import { appendFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, AgentState, HuntEvent, Runbook, RunState, TaskState } from "./types.js";
import { makeId, nowIso, pathExists, readJson, withFileLock, writeJson } from "./utils.js";
import { runbookToYaml } from "./runbook.js";

export const HUNT_DIR = ".huntctl";

export function runsRoot(workspace = process.cwd()): string {
  return path.resolve(workspace, HUNT_DIR, "runs");
}

export function currentRunPath(workspace = process.cwd()): string {
  return path.resolve(workspace, HUNT_DIR, "current");
}

export function runDirFor(runId: string, workspace = process.cwd()): string {
  return path.join(runsRoot(workspace), runId);
}

export function statePath(runDir: string): string {
  return path.join(runDir, "state.json");
}

export function eventPath(runDir: string): string {
  return path.join(runDir, "events.jsonl");
}

export function summaryPath(runDir: string): string {
  return path.join(runDir, "summary.md");
}

export function agentDir(runDir: string, agentId: string): string {
  return path.join(runDir, "agents", agentId);
}

export function taskDir(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId);
}

export async function createRunStore(params: {
  runbook: Runbook;
  runbookPath: string;
  workspace: string;
  sandboxMode: Runbook["sandbox"]["mode"];
}): Promise<{ runId: string; runDir: string; state: RunState }> {
  const runId = makeId(params.runbook.profile === "ctf" ? "ctf" : "bb");
  const runDir = runDirFor(runId, params.workspace);
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(runDir, "agents"), { recursive: true });
  await mkdir(path.join(runDir, "tasks"), { recursive: true });
  await writeFile(path.join(runDir, "runbook.yml"), runbookToYaml(params.runbook), "utf8");
  if (await pathExists(params.runbookPath)) {
    await cp(params.runbookPath, path.join(runDir, "runbook.source.yml"));
  }

  const agents: Record<string, AgentState> = Object.fromEntries(
    params.runbook.agents.map((agent) => [
      agent.id,
      {
        id: agent.id,
        role: agent.role,
        status: "idle" as const,
        taskCount: 0
      }
    ])
  );
  const now = nowIso();
  const state: RunState = {
    runId,
    profile: params.runbook.profile,
    status: "running",
    createdAt: now,
    updatedAt: now,
    runbookPath: path.resolve(params.runbookPath),
    workspace: params.workspace,
    sandboxMode: params.sandboxMode,
    danger: Boolean(params.runbook.danger),
    agents,
    tasks: {},
    advisor: {
      status: "idle",
      cycles: 0
    },
    findings: [],
    heldTasks: [],
    autoActions: [],
    errors: [],
    candidates: {},
    policyWarnings: [],
    sandboxFallbacks: []
  };
  await writeJson(statePath(runDir), state);
  await writeFile(currentRunPath(params.workspace), runId, "utf8");
  await appendEvent(runDir, {
    time: nowIso(),
    runId,
    type: "run.created",
    source: "orchestrator",
    message: `Created ${runId}`
  });
  return { runId, runDir, state };
}

export async function readState(runDir: string): Promise<RunState> {
  const raw = await readJson<RunState>(statePath(runDir));
  if (!raw.candidates) raw.candidates = {};
  if (!raw.policyWarnings) raw.policyWarnings = [];
  if (!raw.sandboxFallbacks) raw.sandboxFallbacks = [];
  return raw;
}

export async function updateState(runDir: string, mutator: (state: RunState) => void | Promise<void>): Promise<RunState> {
  return withFileLock(path.join(runDir, ".state.lock"), async () => {
    const state = await readState(runDir);
    await mutator(state);
    state.updatedAt = nowIso();
    await writeJson(statePath(runDir), state);
    return state;
  });
}

export async function appendEvent(runDir: string, event: HuntEvent): Promise<void> {
  await appendFile(eventPath(runDir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readEvents(runDir: string, limit = 100): Promise<HuntEvent[]> {
  if (!(await pathExists(eventPath(runDir)))) return [];
  const raw = await readFile(eventPath(runDir), "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const events: HuntEvent[] = [];
  for (const line of lines.slice(Math.max(0, lines.length - limit))) {
    try {
      events.push(JSON.parse(line) as HuntEvent);
    } catch {
      // Large command outputs from older runs may contain malformed JSONL fragments.
    }
  }
  return events;
}

export async function latestRunId(workspace = process.cwd()): Promise<string> {
  const current = currentRunPath(workspace);
  if (await pathExists(current)) {
    const value = (await readFile(current, "utf8")).trim();
    if (value) return value;
  }
  const runs = await listRuns(workspace);
  if (!runs[0]) throw new Error("No huntctl runs found");
  return runs[0].runId;
}

export async function listRuns(workspace = process.cwd()): Promise<Array<{ runId: string; runDir: string; updatedAt: string }>> {
  const root = runsRoot(workspace);
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const runs: Array<{ runId: string; runDir: string; updatedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(root, entry.name);
    if (!(await pathExists(statePath(runDir)))) continue;
    const state = await readState(runDir);
    runs.push({ runId: entry.name, runDir, updatedAt: state.updatedAt });
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function workerAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((agent) => agent.role !== "advisor" && agent.id !== "advisor");
}

export function createTask(agent: AgentConfig, source: TaskState["source"], prompt: string, reason?: string): TaskState {
  return {
    id: makeId(`task-${agent.id}`),
    agentId: agent.id,
    role: agent.role,
    source,
    status: "queued",
    prompt,
    reason
  };
}
