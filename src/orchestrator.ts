import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRunbook, resolvePromptFile, runbookToYaml } from "./runbook.js";
import { createInteractiveRunbook } from "./runbook.js";
import {
  appendEvent,
  createRunStore,
  createTask,
  currentRunPath,
  readEvents,
  readState,
  runDirFor,
  runsRoot,
  summaryPath,
  taskDir,
  updateState,
  workerAgents
} from "./store.js";
import type { AgentConfig, AdvisorDecision, BountyLane, HuntEvent, RunState, Runbook, TaskState } from "./types.js";
import { buildAdvisorPrompt, buildInitialTaskPrompt, buildWorkerPrompt, parseAdvisorDecision, parseCandidateUpdates } from "./prompts.js";
import { applyPolicyWarningsToPrompt, evaluateTaskPolicy } from "./policy.js";
import type { Candidate } from "./types.js";
import { internalCommandArgs, nowIso, pathExists, safeDockerName, truncate, writeJson } from "./utils.js";
import { runCodexTask } from "./codex.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_ADVISOR_DEBOUNCE_MS = 30_000;

export async function startRun(params: {
  runbookPath: string;
  workspace: string;
  sandboxMode?: Runbook["sandbox"]["mode"];
  dockerImage?: string;
  strictSandbox?: boolean;
  foreground?: boolean;
}): Promise<{ runId: string; runDir: string }> {
  const runbook = await loadRunbook(params.runbookPath);
  const sandboxMode = params.sandboxMode ?? runbook.sandbox.mode;
  runbook.sandbox.mode = sandboxMode;
  if (params.dockerImage) runbook.sandbox.image = params.dockerImage;
  if (params.strictSandbox !== undefined) runbook.sandbox.strict = params.strictSandbox;
  const { runId, runDir } = await createRunStore({
    runbook,
    runbookPath: params.runbookPath,
    workspace: params.workspace,
    sandboxMode
  });

  const workers = workerAgents(runbook.agents);
  await updateState(runDir, (state) => {
    for (const agent of workers) {
      const task = createTask(agent, "initial", buildInitialTaskPrompt(runbook, agent));
      state.tasks[task.id] = task;
      state.agents[agent.id].status = "queued";
    }
  });

  await startQueuedTasks(runDir, runbook);
  if (runbook.advisor.mode === "auto") {
    await startAdvisorLoop(runDir);
  }

  await appendEvent(runDir, {
    time: nowIso(),
    runId,
    type: "run.started",
    source: "orchestrator",
    message: `Started ${workers.length} worker task(s)`
  });

  if (params.foreground) {
    await waitUntilNoActiveTasks(runDir);
  }
  return { runId, runDir };
}

export async function startInteractiveSession(params: {
  profile: Runbook["profile"];
  workers: number;
  roles?: string[];
  sandboxMode: Runbook["sandbox"]["mode"];
  dockerImage?: string;
  danger?: boolean;
  workspace: string;
  targetName?: string;
  description?: string;
  scope?: string[];
  outOfScope?: string[];
  files?: string[];
  evidenceDir?: string;
  targetDir?: string;
  vrt?: string[];
  weaknesses?: string[];
  reportTemplate?: string;
  platform?: "hackerone" | "bugcrowd" | "custom";
  hackeroneWeaknessesUrl?: string;
  bugcrowdVrtPath?: string;
  strictSandbox?: boolean;
}): Promise<{ runId: string; runDir: string }> {
  const sessionWorkspace = await prepareInteractiveWorkspace({
    rootWorkspace: params.workspace,
    profile: params.profile,
    targetName: params.targetName,
    targetDir: params.targetDir
  });
  const evidenceDir = params.evidenceDir ?? "evidence";
  const runbook = createInteractiveRunbook({
    ...params,
    evidenceDir
  });
  const { runId, runDir } = await createRunStore({
    runbook,
    runbookPath: path.join(sessionWorkspace, "interactive"),
    workspace: sessionWorkspace,
    sandboxMode: params.sandboxMode
  });
  await linkRunIntoRootWorkspace({
    rootWorkspace: params.workspace,
    sessionWorkspace,
    runId,
    runDir
  });
  await writeSessionWorkspaceNote({
    workspace: sessionWorkspace,
    runId,
    runDir,
    profile: runbook.profile,
    evidenceDir
  });
  const readySummary =
    runbook.profile === "bug-bounty"
      ? "인터랙티브 advisor가 준비됐습니다. 시작 옵션으로 scope를 줬거나, 왼쪽 advisor에게 target/scope를 말하면 worker에게 자동으로 일을 나눕니다."
      : "인터랙티브 advisor가 준비됐습니다. 왼쪽 advisor에게 CTF 문제 설명, 파일, 카테고리, 원하는 분석 방향을 말하면 worker에게 일을 나눕니다.";
  await writeFile(summaryPath(runDir), `${readySummary}\n`, "utf8");
  await updateState(runDir, (state) => {
    state.advisor.lastSummary = readySummary;
    state.advisor.lastResponse = readySummary;
  });
  await appendEvent(runDir, {
    time: nowIso(),
    runId,
    type: "session.ready",
    source: "orchestrator",
    message: readySummary
  });
  return { runId, runDir };
}

async function prepareInteractiveWorkspace(params: {
  rootWorkspace: string;
  profile: Runbook["profile"];
  targetName?: string;
  targetDir?: string;
}): Promise<string> {
  const workspace = params.targetDir
    ? path.resolve(params.rootWorkspace, params.targetDir)
    : path.join(params.rootWorkspace, "targets", defaultTargetFolderName(params.profile, params.targetName));
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(workspace, "evidence"), { recursive: true });
  await mkdir(path.join(workspace, "notes"), { recursive: true });
  return workspace;
}

function defaultTargetFolderName(profile: Runbook["profile"], targetName?: string): string {
  const base = safeDockerName((targetName || profile).toLowerCase()).replace(/^-+|-+$/g, "") || profile;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${base}-${stamp}`;
}

async function linkRunIntoRootWorkspace(params: {
  rootWorkspace: string;
  sessionWorkspace: string;
  runId: string;
  runDir: string;
}): Promise<void> {
  const root = path.resolve(params.rootWorkspace);
  const session = path.resolve(params.sessionWorkspace);
  if (root === session) return;

  await mkdir(runsRoot(root), { recursive: true });
  const alias = runDirFor(params.runId, root);
  await rm(alias, { recursive: true, force: true });
  await symlink(params.runDir, alias, "dir");
  await writeFile(currentRunPath(root), params.runId, "utf8");
}

async function writeSessionWorkspaceNote(params: {
  workspace: string;
  runId: string;
  runDir: string;
  profile: Runbook["profile"];
  evidenceDir: string;
}): Promise<void> {
  const evidencePath = path.isAbsolute(params.evidenceDir) ? params.evidenceDir : path.resolve(params.workspace, params.evidenceDir);
  await mkdir(evidencePath, { recursive: true });
  const note = [
    `# huntctl session ${params.runId}`,
    "",
    `profile: ${params.profile}`,
    `workspace: ${params.workspace}`,
    `run_dir: ${params.runDir}`,
    `evidence_dir: ${evidencePath}`,
    "",
    "Workers run from this folder. Save shared PoC, requests, screenshots, exploit code, notes, and report evidence under `evidence/` unless a task says otherwise.",
    ""
  ].join("\n");
  await writeFile(path.join(params.workspace, `huntctl-session-${params.runId}.md`), note, "utf8");
}

export async function startContinuousAdvisorLoop(runDir: string): Promise<void> {
  await startAdvisorLoop(runDir, { continuous: true });
}

export async function runWorkerTask(params: { runDir: string; taskId: string }): Promise<void> {
  const runbook = await loadRunbook(path.join(params.runDir, "runbook.yml"));
  const state = await readState(params.runDir);
  const task = state.tasks[params.taskId];
  if (!task) throw new Error(`Unknown task id: ${params.taskId}`);
  const agent = runbook.agents.find((candidate) => candidate.id === task.agentId);
  if (!agent) throw new Error(`Unknown agent id: ${task.agentId}`);

  const promptFile = resolvePromptFile(state.runbookPath, agent.prompt_file);
  const policy = evaluateTaskPolicy(runbook, task.prompt);
  const taskPromptWithWarnings = applyPolicyWarningsToPrompt(task.prompt, policy.warnings);
  const prompt = await buildWorkerPrompt({
    runbook,
    agent,
    taskPrompt: taskPromptWithWarnings,
    promptFile,
    runbookPath: path.join(params.runDir, "runbook.yml")
  });
  if (policy.warnings.length) {
    await updateState(params.runDir, (next) => {
      const stamp = `${nowIso()} ${task.id}: ${policy.warnings.join(" | ")}`;
      next.policyWarnings = [...next.policyWarnings, stamp].slice(-50);
    });
    await appendEvent(params.runDir, {
      time: nowIso(),
      runId: state.runId,
      type: "policy.warning",
      source: "policy",
      agentId: agent.id,
      taskId: task.id,
      message: policy.warnings.join(" | "),
      data: {
        outOfScopeUrls: policy.outOfScopeUrls,
        unscopedUrls: policy.unscopedUrls
      }
    });
  }
  if (!policy.allowed) {
    await updateState(params.runDir, (next) => {
      next.tasks[task.id].status = "blocked";
      next.tasks[task.id].blockedReason = policy.reason;
      next.agents[agent.id].status = "blocked";
      next.agents[agent.id].lastMessage = policy.reason;
      next.heldTasks.push(`${task.id}: ${policy.reason}`);
    });
    await appendEvent(params.runDir, {
      time: nowIso(),
      runId: state.runId,
      type: "task.blocked",
      source: "policy",
      agentId: agent.id,
      taskId: task.id,
      message: policy.reason
    });
    return;
  }

  await updateState(params.runDir, (next) => {
    next.tasks[task.id].status = "running";
    next.tasks[task.id].startedAt = nowIso();
    next.tasks[task.id].pid = process.pid;
    next.agents[agent.id].status = "running";
    next.agents[agent.id].pid = process.pid;
    next.agents[agent.id].currentTaskId = task.id;
    next.agents[agent.id].lastUpdate = nowIso();
  });

  try {
    const result = await runCodexTask({
      runDir: params.runDir,
      runId: state.runId,
      taskId: task.id,
      agent,
      runbook,
      prompt,
      workspace: state.workspace,
      sandboxMode: state.sandboxMode
    });
    const candidateUpdates = parseCandidateUpdates(result.finalMessage || "");
    await updateState(params.runDir, (next) => {
      const done = result.exitCode === 0;
      next.tasks[task.id].status = done ? "done" : "failed";
      next.tasks[task.id].endedAt = nowIso();
      next.tasks[task.id].exitCode = result.exitCode;
      next.tasks[task.id].lastMessage = truncate(result.finalMessage || "No final message", 1000);
      next.agents[agent.id].status = done ? "done" : "failed";
      next.agents[agent.id].pid = undefined;
      next.agents[agent.id].lastUpdate = nowIso();
      next.agents[agent.id].lastMessage = truncate(result.finalMessage || "No final message", 1000);
      next.agents[agent.id].taskCount += 1;
      if (!done) next.errors.push(workerFailureMessage(agent.id, task.id, result.exitCode, result.finalMessage));
      mergeCandidates(next, candidateUpdates, { taskId: task.id, agentId: agent.id });
    });
    if (candidateUpdates.length) {
      await appendEvent(params.runDir, {
        time: nowIso(),
        runId: state.runId,
        type: "candidate.updated",
        source: "worker",
        agentId: agent.id,
        taskId: task.id,
        message: candidateUpdates.map((update) => `${update.id}=${update.status}`).join(", "),
        data: candidateUpdates
      });
    }
    await appendEvent(params.runDir, {
      time: nowIso(),
      runId: state.runId,
      type: result.exitCode === 0 ? "task.done" : "task.failed",
      source: "worker",
      agentId: agent.id,
      taskId: task.id,
      message: `exit=${result.exitCode} artifacts=${result.artifactDir}`,
      data: {
        artifactDir: result.artifactDir,
        evidenceDir: result.evidenceDir,
        usedSandbox: result.usedSandbox
      }
    });
  } catch (error) {
    await updateState(params.runDir, (next) => {
      const message = error instanceof Error ? error.message : String(error);
      next.tasks[task.id].status = "failed";
      next.tasks[task.id].endedAt = nowIso();
      next.tasks[task.id].lastMessage = message;
      next.agents[agent.id].status = "failed";
      next.agents[agent.id].pid = undefined;
      next.agents[agent.id].lastMessage = message;
      next.errors.push(message);
    });
    await appendEvent(params.runDir, {
      time: nowIso(),
      runId: state.runId,
      type: "task.failed",
      source: "worker",
      agentId: agent.id,
      taskId: task.id,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    await startQueuedTasks(params.runDir, runbook);
    await maybeCompleteRun(params.runDir);
  }
}

export async function runAdvisorLoop(params: { runDir: string; once?: boolean; continuous?: boolean }): Promise<void> {
  let runbook = await loadRunbook(path.join(params.runDir, "runbook.yml"));
  await updateState(params.runDir, (state) => {
    state.advisor.status = "running";
    if (!params.once) state.advisor.pid = process.pid;
  });
  await appendEvent(params.runDir, {
    time: nowIso(),
    runId: (await readState(params.runDir)).runId,
    type: "advisor.loop.started",
    source: "advisor",
    agentId: "advisor",
    message: params.continuous ? "continuous coordinator loop started" : params.once ? "single advisor cycle started" : "advisor loop started"
  });

  while (true) {
    const state = await readState(params.runDir);
    if (state.status !== "running") break;
    runbook = await loadRunbook(path.join(params.runDir, "runbook.yml"));
    await reapDeadWorkers(params.runDir);
    await startQueuedTasks(params.runDir, runbook);
    await emitAdvisorHeartbeat(params.runDir);
    const afterStart = await readState(params.runDir);
    if (params.once || (await shouldRunAdvisorCycle(params.runDir, runbook, afterStart))) {
      await runAdvisorOnce(params.runDir, runbook);
    }
    if (params.once || (!params.continuous && runbook.advisor.mode !== "auto")) break;
    const after = await readState(params.runDir);
    if (!params.continuous && allTasksTerminal(after)) break;
    await new Promise((resolve) => setTimeout(resolve, runbook.advisor.interval_seconds * 1000));
  }

  await updateState(params.runDir, (state) => {
    if (params.once) {
      if (state.advisor.pid === process.pid) state.advisor.pid = undefined;
      state.advisor.status = state.advisor.pid ? "running" : "idle";
      return;
    }
    if (state.advisor.pid === process.pid) {
      state.advisor.status = "idle";
      state.advisor.pid = undefined;
    }
  });
  await maybeCompleteRun(params.runDir);
}

export async function assignWorkerTask(params: {
  runDir: string;
  agentId: string;
  prompt: string;
  source: TaskState["source"];
  reason?: string;
}): Promise<string> {
  const runbook = await loadRunbook(path.join(params.runDir, "runbook.yml"));
  const agent = runbook.agents.find((candidate) => candidate.id === params.agentId);
  if (!agent) throw new Error(`Unknown agent id: ${params.agentId}`);
  if (agent.role === "advisor" || agent.id === "advisor") throw new Error("Use ask for advisor; assign targets worker agents");
  const task = createTask(agent, params.source, params.prompt, params.reason);
  await updateState(params.runDir, (state) => {
    if (state.status === "completed" || state.status === "failed") {
      state.status = "running";
    }
    state.tasks[task.id] = task;
    state.agents[agent.id].status = state.agents[agent.id].status === "running" ? "running" : "queued";
  });
  await appendEvent(params.runDir, {
    time: nowIso(),
    runId: (await readState(params.runDir)).runId,
    type: "task.queued",
    source: params.source === "user" ? "user" : "advisor",
    agentId: agent.id,
    taskId: task.id,
    message: params.prompt
  });
  await startQueuedTasks(params.runDir, runbook);
  return task.id;
}

export async function askAdvisor(params: { runDir: string; message: string }): Promise<void> {
  const state = await readState(params.runDir);
  await appendEvent(params.runDir, {
    time: nowIso(),
    runId: state.runId,
    type: "user.ask",
    source: "user",
    message: params.message
  });
  await runAdvisorOnce(params.runDir, await loadRunbook(path.join(params.runDir, "runbook.yml")));
}

export async function stopTarget(params: { runDir: string; target: string }): Promise<void> {
  const state = await readState(params.runDir);
  const isRun = params.target === state.runId || params.target === "run";
  const pids = new Set<number>();
  if (isRun) {
    for (const task of Object.values(state.tasks)) {
      if (task.pid) pids.add(task.pid);
    }
    if (state.advisor.pid) pids.add(state.advisor.pid);
  } else {
    const agent = state.agents[params.target];
    if (!agent) throw new Error(`Unknown run or agent target: ${params.target}`);
    if (agent.pid) pids.add(agent.pid);
    if (params.target === "advisor" && state.advisor.pid) pids.add(state.advisor.pid);
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have already exited.
    }
  }

  if (isRun || params.target === "advisor") {
    await killNativeSession(state.runId);
  }

  await updateState(params.runDir, (next) => {
    if (isRun) next.status = "stopped";
    for (const task of Object.values(next.tasks)) {
      if (isRun || task.agentId === params.target) {
        if (task.status === "running" || task.status === "queued" || task.status === "starting") {
          task.status = "stopped";
          task.endedAt = nowIso();
        }
      }
    }
    for (const agent of Object.values(next.agents)) {
      if (isRun || agent.id === params.target) {
        if (agent.status === "running" || agent.status === "queued") agent.status = "stopped";
        agent.pid = undefined;
      }
    }
    if (isRun) {
      next.advisor.status = "stopped";
      next.advisor.pid = undefined;
    } else if (params.target === "advisor") {
      next.advisor.status = "stopped";
      next.advisor.pid = undefined;
    }
  });
  await appendEvent(params.runDir, {
    time: nowIso(),
    runId: state.runId,
    type: "target.stopped",
    source: "orchestrator",
    message: params.target
  });
}

export async function updateScope(params: { runDir: string; urls: string[]; outOfScope: boolean }): Promise<void> {
  const runbookPath = path.join(params.runDir, "runbook.yml");
  const runbook = await loadRunbook(runbookPath);
  if (runbook.profile !== "bug-bounty") {
    throw new Error("scope commands are only available for bug-bounty runs");
  }
  if (!runbook.target) {
    runbook.target = {
      name: "interactive-target",
      scope: [],
      out_of_scope: []
    };
  }
  const key = params.outOfScope ? "out_of_scope" : "scope";
  const current = new Set(runbook.target[key]);
  for (const url of params.urls.map((value) => value.trim()).filter(Boolean)) {
    current.add(url);
  }
  runbook.target[key] = Array.from(current).sort();
  await writeFile(runbookPath, runbookToYaml(runbook), "utf8");
  const state = await readState(params.runDir);
  await appendEvent(params.runDir, {
    time: nowIso(),
    runId: state.runId,
    type: "scope.updated",
    source: "user",
    message: `${params.outOfScope ? "out-of-scope" : "in-scope"} +${params.urls.length}`,
    data: {
      scope: runbook.target.scope,
      out_of_scope: runbook.target.out_of_scope
    }
  });
  await updateState(params.runDir, (next) => {
    next.autoActions.push(`${params.outOfScope ? "out-of-scope" : "in-scope"} updated: ${params.urls.join(", ")}`);
  });
}

async function killNativeSession(runId: string): Promise<void> {
  const sessionName = `huntctl-${runId}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
  } catch {
    // No native tmux session to stop.
  }
}

async function runAdvisorOnce(runDir: string, runbook: Runbook): Promise<void> {
  const state = await readState(runDir);
  const recentEvents = (await advisorDeltaEvents(runDir, state)).slice(-24).map(formatAdvisorEvent).join("\n");
  const advisorAgent: AgentConfig = runbook.agents.find((agent) => agent.role === "advisor" || agent.id === "advisor") ?? {
    id: "advisor",
    role: "advisor"
  };
  const taskId = `advisor-${Date.now()}`;
  const prompt = await buildAdvisorPrompt({ runbook, state, recentEvents });
  await mkdir(taskDir(runDir, taskId), { recursive: true });
  let decision: AdvisorDecision | undefined;
  let finalMessage = "";
  let parseError: string | undefined;
  try {
    const result = await runCodexTask({
      runDir,
      runId: state.runId,
      taskId,
      agent: advisorAgent,
      runbook,
      prompt,
      workspace: state.workspace,
      sandboxMode: "host"
    });
    finalMessage = result.finalMessage;
    try {
      decision = parseAdvisorDecision(finalMessage);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    finalMessage = error instanceof Error ? error.message : String(error);
  }

  const planningState = await readState(runDir);
  decision = await withAutomaticFallbackPlan(runbook, planningState, decision);

  const summary = decision?.summary || finalMessage || "Advisor did not return a summary.";
  const response = decision?.response || summary;
  await writeFile(summaryPath(runDir), `${summary.trim()}\n`, "utf8");
  await updateState(runDir, (next) => {
    next.advisor.lastRunAt = nowIso();
    next.advisor.lastSummary = summary.trim();
    next.advisor.lastResponse = response.trim();
    next.advisor.cycles += 1;
    if (decision) {
      next.heldTasks = [...next.heldTasks, ...decision.held_tasks].slice(-50);
      next.autoActions = [...next.autoActions, ...decision.auto_actions].slice(-50);
    } else if (parseError && !runbook.interactive) {
      next.errors.push(`advisor parse failed: ${parseError}: ${truncate(finalMessage, 300)}`);
    }
  });

  if (decision && runbook.advisor.can_assign_workers) {
    let assignmentState = await readState(runDir);
    for (const nextTask of decision.next_tasks.slice(0, 3)) {
      const agent = pickAgentForTask(runbook.agents, assignmentState, nextTask.worker_id, nextTask.worker_role);
      if (!agent || !nextTask.task) {
        await updateState(runDir, (next) => {
          next.heldTasks.push(nextTask.task || "advisor suggested an empty task or no idle worker was available");
        });
        continue;
      }
      const policy = evaluateTaskPolicy(runbook, nextTask.task);
      if (policy.warnings.length) {
        await updateState(runDir, (next) => {
          next.policyWarnings = [
            ...next.policyWarnings,
            `${nowIso()} ${agent.id}: ${policy.warnings.join(" | ")}`
          ].slice(-50);
        });
        await appendEvent(runDir, {
          time: nowIso(),
          runId: state.runId,
          type: "policy.warning",
          source: "policy",
          agentId: agent.id,
          message: policy.warnings.join(" | "),
          data: {
            outOfScopeUrls: policy.outOfScopeUrls,
            unscopedUrls: policy.unscopedUrls
          }
        });
      }
      if (!policy.allowed) {
        await updateState(runDir, (next) => {
          next.heldTasks.push(`${nextTask.task}: ${policy.reason}`);
        });
        continue;
      }
      await assignWorkerTask({
        runDir,
        agentId: agent.id,
        prompt: nextTask.task,
        source: "advisor",
        reason: nextTask.reason
      });
      assignmentState = await readState(runDir);
    }
  }

  await appendEvent(runDir, {
    time: nowIso(),
    runId: state.runId,
    type: "advisor.summary",
    source: "advisor",
    agentId: advisorAgent.id,
    message: truncate(response, 500),
    data: decision
  });
}

async function shouldRunAdvisorCycle(runDir: string, runbook: Runbook, state: RunState): Promise<boolean> {
  void runbook;
  if (!state.advisor.lastRunAt) return true;
  const delta = await advisorDeltaEvents(runDir, state);
  if (!delta.length) return false;
  if (delta.some(isUrgentAdvisorEvent)) return true;
  return elapsedSince(state.advisor.lastRunAt) >= advisorDebounceMs();
}

function isUrgentAdvisorEvent(event: HuntEvent): boolean {
  return event.type === "user.ask" || event.type === "scope.updated" || event.type === "target.stopped";
}

function elapsedSince(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

function advisorDebounceMs(): number {
  const raw = process.env.HUNTCTL_ADVISOR_DEBOUNCE_MS;
  if (!raw) return DEFAULT_ADVISOR_DEBOUNCE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ADVISOR_DEBOUNCE_MS;
  return parsed;
}

async function advisorDeltaEvents(runDir: string, state: RunState): Promise<HuntEvent[]> {
  const cursor = state.advisor.lastRunAt;
  const events = (await readEvents(runDir, 240)).filter(isAdvisorPromptEvent);
  if (!cursor) return events.slice(-40);
  return events.filter((event) => event.time > cursor);
}

function formatAdvisorEvent(event: HuntEvent): string {
  return JSON.stringify({
    time: event.time,
    type: event.type,
    source: event.source,
    agentId: event.agentId,
    taskId: event.taskId,
    message: event.message ? truncate(oneLine(event.message), 140) : undefined
  });
}

function isAdvisorPromptEvent(event: HuntEvent): boolean {
  return [
    "user.ask",
    "scope.updated",
    "candidate.updated",
    "policy.warning",
    "task.queued",
    "task.blocked",
    "task.done",
    "task.failed",
    "session.ready",
    "run.started",
    "target.stopped"
  ].includes(event.type);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function withAutomaticFallbackPlan(
  runbook: Runbook,
  state: RunState,
  decision?: AdvisorDecision
): Promise<AdvisorDecision | undefined> {
  if (!runbook.advisor.can_assign_workers || state.status !== "running") return decision;
  if (decision?.next_tasks.length) {
    return decision;
  }

  const fallback = await buildAutomaticPlannerDecision(runbook, state);
  if (!fallback) return decision;
  if (!decision) return fallback;

  return {
    response: decision.response?.trim() ? decision.response : fallback.response,
    summary: decision.summary?.trim() ? decision.summary : fallback.summary,
    next_tasks: fallback.next_tasks,
    held_tasks: [...decision.held_tasks, ...fallback.held_tasks].slice(-50),
    auto_actions: [...decision.auto_actions, ...fallback.auto_actions].slice(-50)
  };
}

async function buildAutomaticPlannerDecision(runbook: Runbook, state: RunState): Promise<AdvisorDecision | undefined> {
  if (hasCodexAuthFailure(state)) {
    return {
      response: "Codex 인증 실패가 감지되어 worker 자동 재시도를 멈췄습니다. `codex login` 또는 `~/.codex` 인증 상태를 복구하면 다시 이어갈 수 있습니다.",
      summary: "Codex 인증 실패로 worker 자동 재시도 중지",
      next_tasks: [],
      held_tasks: ["Codex API 401 Unauthorized"],
      auto_actions: ["Codex auth failure detected; not queueing more worker tasks"]
    };
  }
  const workers = workerAgents(runbook.agents).filter((agent) => isWorkerAvailableForAutoAssign(state, agent.id) && !hasPendingTaskForAgent(state, agent.id));
  if (!workers.length) return undefined;

  if (runbook.profile === "bug-bounty") return buildBugBountyPlannerDecision(runbook, state, workers);
  return buildCtfPlannerDecision(runbook, state, workers);
}

function buildBugBountyPlannerDecision(runbook: Runbook, state: RunState, workers: AgentConfig[]): AdvisorDecision {
  const scopeCount = runbook.target?.scope.length ?? 0;
  const nextTasks = collectSafeFallbackTasks(
    runbook,
    state,
    workers.slice(0, Math.max(1, runbook.limits.max_parallel_agents)),
    (worker) => bountyFallbackTask(runbook, state, worker)
  );
  const message = nextTasks.length
    ? `idle worker ${nextTasks.length}개에 다음 작업을 자동 배정합니다. 현재 scope ${scopeCount}개 기준으로 candidate를 검증하고, 결과는 report-ready/keep/blocked/reject/pivot-adjacent/rotate-lane 중 하나로 닫습니다.`
    : "새로 배정할 중복 없는 작업이 없습니다. 기존 산출물 검토나 추가 목표 입력이 필요합니다.";
  return {
    response: message,
    summary: message,
    next_tasks: nextTasks,
    held_tasks: nextTasks.length ? [] : ["중복 없는 자동 작업 후보 없음"],
    auto_actions: nextTasks.map((task) => `자동 배정 예정: ${task.worker_id ?? task.worker_role} - ${task.reason ?? task.task}`)
  };
}

function buildCtfPlannerDecision(runbook: Runbook, state: RunState, workers: AgentConfig[]): AdvisorDecision {
  const nextTasks = collectSafeFallbackTasks(
    runbook,
    state,
    workers.slice(0, Math.max(1, runbook.limits.max_parallel_agents)),
    (worker) => ctfFallbackTask(runbook, state, worker)
  );
  const message = nextTasks.length
    ? `idle worker ${nextTasks.length}개에 CTF 다음 분석 작업을 자동 배정합니다.`
    : "새로 배정할 중복 없는 CTF 작업이 없습니다. 추가 파일, 서비스 정보, 현재 가설을 알려주세요.";
  return {
    response: message,
    summary: message,
    next_tasks: nextTasks,
    held_tasks: nextTasks.length ? [] : ["중복 없는 CTF 자동 작업 후보 없음"],
    auto_actions: nextTasks.map((task) => `자동 배정 예정: ${task.worker_id ?? task.worker_role} - ${task.reason ?? task.task}`)
  };
}

function collectSafeFallbackTasks(
  runbook: Runbook,
  state: RunState,
  workers: AgentConfig[],
  build: (worker: AgentConfig) => AdvisorDecision["next_tasks"][number]
): AdvisorDecision["next_tasks"] {
  const tasks: AdvisorDecision["next_tasks"] = [];
  for (const worker of workers) {
    const task = build(worker);
    if (!task.task.trim()) continue;
    if (!evaluateTaskPolicy(runbook, task.task).allowed) continue;
    tasks.push(task);
  }
  return tasks.slice(0, 3);
}

function bountyFallbackTask(runbook: Runbook, state: RunState, worker: AgentConfig): AdvisorDecision["next_tasks"][number] {
  const round = (state.agents[worker.id]?.taskCount ?? 0) + 1;
  const platform = runbook.program?.platform ?? "custom";
  const evidence = runbook.evidence_dir;
  const lanePlan = selectBountyLanePlan(runbook, state, worker, round);
  const base =
    `자동 라운드 ${round}. 현재 runbook 목표 정보와 기존 ${evidence} 산출물을 기준으로 진행하세요. ` +
    `이번 작업 lane은 "${lanePlan.lane.label}"입니다. 인접 전환 lane은 "${lanePlan.next.label}"입니다. ` +
    `lane 목표: ${lanePlan.lane.goal} ` +
    "반드시 마지막 줄에 `Decision: report-ready | keep | blocked | reject | pivot-adjacent | rotate-lane` 중 하나를 정확히 쓰세요. " +
    "`report-ready`는 in-scope asset, attacker capability, concrete impact, 재현 절차, PoC request/code, durable evidence path, taxonomy/severity mapping이 모두 있을 때만 허용됩니다. " +
    "`keep`은 이번 cycle에서 capability/impact/repro/PoC 품질을 직접 높이는 새 증거가 생겼을 때만 허용됩니다. " +
    "`blocked`는 세션/테스트 계정/canary/mobile runtime/fixture/cross-account permission 같은 사용자 입력 없이는 다음 proof가 불가능할 때 쓰고, 필요한 입력을 정확히 적으세요. " +
    "`reject`는 공개 metadata, scanner/header-only, escaped reflection, error-body-only CORS, 정상 redirect, 공격자-controlled 보안 경계 침범 없음일 때 쓰세요. " +
    "`pivot-adjacent`는 가까운 asset/surface/class에 구체적 다음 테스트가 있을 때, `rotate-lane`은 같은 lane에서 2회 연속 새 evidence/capability가 없을 때 쓰세요. " +
    "보고 가능성을 확인하려면 attacker capability, 구체적 영향, 재현 절차, PoC 코드 또는 HTTP 요청, 증거 파일 경로를 반드시 남기세요. " +
    "버그바운티는 한 고신호 후보를 충분히 깊게 파는 것이 우선이지만, 같은 lane에서 2회 연속 새 evidence/capability가 없으면 candidate ledger에 blocked/reject/pivot-adjacent/rotate-lane 사유를 남기고 인접 lane으로 전환하세요. " +
    "candidate ledger에는 candidate id, asset/surface lane, vuln class, normalized status(report-ready/keep/blocked/reject/pivot-adjacent/rotate-lane), evidence added, missing proof, next decision을 남기세요. " +
    "결과에는 `Why continue`와 `Why stop/rotate`를 모두 포함하고, reportable 여부, 불확실성, 다음 배정 후보를 한국어로 남기세요.";

  const role = worker.role;
  if (role === "recon" || role === "endpoint-mapper") {
    const focus = [
      `${lanePlan.lane.recon} 기존 evidence에서 확인 가능한 host/endpoint 후보를 중복 제거하고, 이 lane에서 가장 좋은 candidate 1개와 대체 candidate 1개만 고르세요.`,
      `${lanePlan.lane.recon} 공개 메타데이터와 저장된 request/response trace를 기준으로 이 lane의 기술 스택, 라우팅, 공개 설정 후보를 정리하세요.`,
      `${lanePlan.lane.recon} 현재 가장 높은 신호의 candidate 하나를 중심으로 관련 endpoint, precondition, 증거 경로를 깊게 보강하세요.`,
      `${lanePlan.lane.recon} 이전 라운드 산출물의 gap을 읽고, 같은 lane을 계속 팔지 "${lanePlan.next.label}"로 전환할지 blocked/reject/rotate 기준과 함께 정리하세요.`
    ][round % 4];
    return {
      worker_id: worker.id,
      worker_role: role,
      task: `${focus} ${base}`,
      reason: "idle recon worker가 있어 기존 증거 기반의 다음 후보 선별을 계속 진행"
    };
  }
  if (role === "validator") {
    const focus = [
      `${lanePlan.lane.validator} 기존 candidate와 triage 문서를 검토해 report-ready/keep/blocked/reject/pivot-adjacent/rotate-lane 중 하나로 재판정하고 공격자 관점의 영향 입증 가능성을 평가하세요.`,
      `${lanePlan.lane.validator} 이 lane의 후보가 실제 제출 가능한 영향으로 이어지는지 증거 기반으로 검증하고, 안 되면 "${lanePlan.next.label}" 전환 조건을 쓰세요.`,
      `${lanePlan.lane.validator} 보고 가능한 단일 후보가 있다면 attacker capability, PoC 요청, 재현 조건, 계정/IP 요구사항, 증거 경로를 체크리스트로 만들고 없으면 blocked 또는 reject 사유를 쓰세요.`,
      `${lanePlan.lane.validator} 최근 worker 결과에서 가장 높은 신호의 candidate 하나를 골라 report-ready/keep/blocked/reject/pivot-adjacent/rotate-lane 중 어디인지 증거 기준으로 판정하세요.`
    ][round % 4];
    return {
      worker_id: worker.id,
      worker_role: role,
      task: `${focus} ${base}`,
      reason: "idle validator worker가 있어 기존 후보를 제출 가능성 기준으로 계속 검증"
    };
  }
  if (role === "report-writer" || role === "evidence") {
    const template =
      platform === "hackerone"
        ? "HackerOne 필드(Asset, Weakness, Severity, Description, Impact, Attachments)"
        : platform === "bugcrowd"
          ? "Bugcrowd 필드(Summary title, Target, Technical severity, VRT Category, Vulnerability details, Attachments, Confirmation)"
          : "사용자가 제공한 보고서 형식 또는 일반 bug bounty 보고서 형식";
    const focus = [
      `${lanePlan.lane.report} 현재 evidence index와 triage 문서를 ${template}에 맞춰 갱신하되, report-ready가 없으면 제출용 보고서가 아니라 ledger/dashboard/missing-input checklist만 갱신하세요.`,
      `${lanePlan.lane.report} PoC 코드/HTTP 요청/응답 스니펫/스크린샷 또는 영상 경로, attacker capability, impact가 필요한 항목과 현재 누락된 항목을 evidence checklist로 정리하세요.`,
      `${lanePlan.lane.report} 현재 주력 candidate의 보고 가능성 상태를 report-ready/keep/blocked/reject/pivot-adjacent/rotate-lane으로 갱신하고 stale이면 "${lanePlan.next.label}"로 전환 조건을 명시하세요.`,
      `${lanePlan.lane.report} 최신 산출물을 기준으로 주력 candidate report draft, evidence map, limitations, next steps를 한 파일에 정리하세요.`
    ][round % 4];
    return {
      worker_id: worker.id,
      worker_role: role,
      task: `${focus} ${base}`,
      reason: "idle report/evidence worker가 있어 산출물과 보고서 상태를 계속 최신화"
    };
  }
  return {
    worker_id: worker.id,
    worker_role: role,
    task: `역할 ${role} 기준으로 "${lanePlan.lane.label}" lane의 기존 evidence를 읽고 후속 분석 후보와 필요한 산출물을 정리하세요. ${base}`,
    reason: `idle ${role} worker가 있어 현재 evidence 기반 후속 작업 배정`
  };
}

const DEFAULT_BOUNTY_LANES: BountyLane[] = [
  {
    label: "auth/session/account boundary",
    goal: "로그인/세션/계정 경계에서 공격자가 권한 없는 데이터나 action에 도달할 수 있는지 확인",
    recon: "auth/session 흐름, redirect after login, cookie flags, account edge를 중심으로 보세요.",
    validator: "인증 전/후 차이, test account 경계, 세션 고정/혼동, 권한 없는 action 가능성을 검증하세요.",
    report: "계정 전제조건, 테스트 계정, 세션 상태, 영향받는 사용자/데이터를 보고서 필드에 맞게 정리하세요."
  },
  {
    label: "access-control/API object boundary",
    goal: "API/객체 식별자/권한 경계에서 IDOR/BOLA/BFLA 가능성을 확인",
    recon: "API endpoint, object id, tenant/account 파라미터, GraphQL/REST route를 중심으로 보세요.",
    validator: "객체 id/role/account 차이로 읽기/쓰기/상태 변경이 가능한지 최소 요청으로 검증하세요.",
    report: "대상 객체, 권한 모델, 재현 계정 조합, 허용/비허용 응답 차이를 정리하세요."
  },
  {
    label: "input-handling/injection/XSS",
    goal: "입력 반영/파싱/템플릿/검색/필터 경계에서 실행 또는 데이터 접근 영향 확인",
    recon: "파라미터, 검색, JSON body, markdown/html 렌더링, 에러 반응이 있는 endpoint를 찾으세요.",
    validator: "무해한 canary와 reflection/sink/encoding 차이를 확인하고, 실행/권한/데이터 영향이 없으면 제외하세요.",
    report: "payload, sink, 브라우저/계정 조건, 실행 증거와 영향 범위를 정리하세요."
  },
  {
    label: "redirect/deep-link/linking",
    goal: "redirect, AASA/assetlinks, app link, OAuth return URL이 실제 account takeover/phishing/data impact로 이어지는지 확인",
    recon: "redirect parameter, app/deep link metadata, OAuth/social login callback, AASA/assetlinks를 모으세요.",
    validator: "단순 open redirect인지, token/code/session/user action 탈취 가능성까지 이어지는지 분리 검증하세요.",
    report: "redirect chain, precondition, token/code 노출 여부, 사용자 상호작용과 실제 impact를 정리하세요."
  },
  {
    label: "cache/CORS/header/static exposure",
    goal: "캐시/헤더/CORS/static artifact가 민감정보 노출이나 권한 우회로 이어지는지 확인",
    recon: "cache-control, vary, CORS, CSP, security headers, static JS/map/config/backup 파일을 중심으로 보세요.",
    validator: "민감 데이터, authenticated response caching, origin credential exposure가 재현되는지 확인하세요.",
    report: "민감도, 노출 조건, 요청/응답 헤더, 브라우저/프록시 재현 가능성을 정리하세요."
  },
  {
    label: "upload/media/file-processing",
    goal: "업로드/미디어/파일 처리에서 stored impact, parsing bug, metadata leak, access control 문제가 있는지 확인",
    recon: "upload endpoint, media transform, attachment serving, file metadata, CDN/object URL을 찾으세요.",
    validator: "파일 타입/metadata/visibility/serving policy가 공격자 capability로 이어지는지 비파괴적으로 검증하세요.",
    report: "파일 샘플, 업로드 계정, 표시/다운로드 URL, 변환 결과와 영향 범위를 정리하세요."
  },
  {
    label: "mobile/app-link/API client surface",
    goal: "모바일 앱/API client metadata에서 hidden endpoint, weak link, token/storage impact를 확인",
    recon: "APK/manifest/deep link/API host/certificate pinning hints/client config를 중심으로 보세요.",
    validator: "앱 링크/토큰/hidden endpoint가 실제 서버 side impact로 이어지는지 확인하고 단순 노출이면 제외하세요.",
    report: "앱 버전, manifest/API evidence, 서버 재현 요청, 영향 가능성과 한계를 정리하세요."
  },
  {
    label: "business-logic/state transition",
    goal: "결제/구독/쿠폰/상태 전이/초대/권한 변경에서 실제 이득이나 권한 상승이 가능한지 확인",
    recon: "상태 변경 endpoint, 가격/쿠폰/tax/구독/초대/role workflow를 inventory하세요.",
    validator: "허용된 테스트 조건 안에서 상태 전이, replay, race-free logic flaw가 재현되는지 확인하세요.",
    report: "비즈니스 impact, 계정/결제 전제조건, 재현 순서, 제한사항을 정리하세요."
  }
];

function selectBountyLanePlan(
  runbook: Runbook,
  state: RunState,
  worker: AgentConfig,
  round: number
): { lane: BountyLane; next: BountyLane } {
  const lanes = runbook.bounty_lanes && runbook.bounty_lanes.length ? runbook.bounty_lanes : DEFAULT_BOUNTY_LANES;
  const completedAdvisorTasks = Object.values(state.tasks).filter(
    (task) => task.source === "advisor" && ["done", "failed", "blocked"].includes(task.status)
  ).length;
  const roleOffset = worker.role === "validator" ? 2 : worker.role === "report-writer" || worker.role === "evidence" ? 4 : 0;
  const index = (completedAdvisorTasks + round + roleOffset) % lanes.length;
  return {
    lane: lanes[index],
    next: lanes[(index + 1) % lanes.length]
  };
}

function ctfFallbackTask(runbook: Runbook, state: RunState, worker: AgentConfig): AdvisorDecision["next_tasks"][number] {
  const round = (state.agents[worker.id]?.taskCount ?? 0) + 1;
  const evidence = runbook.evidence_dir;
  const files = runbook.challenge?.files.length ? "제공된 문제 파일" : "문제 설명";
  const base =
    `자동 라운드 ${round}. ${files}와 기존 ${evidence} 산출물을 기준으로 진행하세요. ` +
    "CTF는 정답이 있으므로 같은 표면에 오래 머물지 마세요. 현재 가설이 1-2번 시도에서 신호가 없으면 즉시 다른 풀이 축으로 pivot하세요. " +
    "반드시 마지막 줄에 `Decision: solved | continue | pivot | blocked` 중 하나를 정확히 쓰세요. " +
    "`continue`는 flag에 가까워지는 새 신호가 있을 때만, `pivot`은 신호가 없거나 같은 표면 반복일 때, `blocked`는 필요한 파일/서비스/password/runtime이 없을 때만 쓰세요. " +
    "명령, 분석 결과, 실패한 가설, pivot 여부, 다음 시도를 한국어로 남기고 flag를 찾으면 Flag, Exploit Code, Writeup, Reproduction으로 정리하세요.";

  const role = worker.role;
  if (role === "file-triage" || role === "web-recon") {
    const focus = [
      "문제 artifact inventory를 짧게 갱신하고 가장 빠른 풀이 가설 2개와 포기 기준을 정하세요.",
      "이전 가설이 막혔다면 다른 파일/프로토콜/입력 벡터/엔드포인트로 전환해 새 신호를 찾으세요.",
      "넓은 목록 작성은 중단하고 flag 또는 exploit으로 바로 이어지는 관찰만 남기세요."
    ][round % 3];
    return {
      worker_id: worker.id,
      worker_role: role,
      task: `${focus} ${base}`,
      reason: "idle triage worker가 있어 빠른 풀이 표면 전환과 신호 선별을 진행"
    };
  }
  if (role === "ctf-validator" || role === "validator") {
    const focus = [
      "최근 solver/triage 결과에서 가장 가능성 있는 가설 1개를 골라, solver가 만든 PoC/exploit이 실제로 flag 또는 결정적 신호를 산출하는지 독립적으로 재현하세요.",
      "방금 'solved'로 끝난 시도가 있다면 같은 입력으로 1회 재현해 flag 형식과 oracle을 검증하고, 거짓이면 즉시 사유와 함께 pivot 신호를 남기세요.",
      "solver가 'continue'로 두고 간 가설 중 하나를 골라 1회 짧게 검증하고, 새 신호가 없으면 'pivot' 결정과 다음 시도를 적으세요.",
      "현재까지 나온 exploit script/solver 코드를 읽고, 환경 차이(파일 경로/리소스/네트워크)로 실패할 위험이 있는지 점검해 reproduction 노트를 보강하세요."
    ][round % 4];
    return {
      worker_id: worker.id,
      worker_role: role,
      task: `${focus} ${base}`,
      reason: "idle ctf-validator worker가 solver 가설/PoC를 독립 재현 검증"
    };
  }
  if (role === "solver" || role === "crypto" || role === "reverse" || role === "pwn") {
    const focus = [
      "현재까지 가장 가능성 높은 풀이 경로 하나를 1회 깊게 시도하되, 신호가 없으면 다른 exploit/solver 접근으로 전환하세요.",
      "이전 solver 시도가 실패했다면 같은 방향을 반복하지 말고 다른 입력 모델, 취약점 class, symbolic/브루트/패치/동적 분석 중 하나로 pivot하세요.",
      "flag 형식/검증 oracle/성공 조건을 먼저 확인하고, 답으로 이어지지 않는 일반 분석은 줄이세요.",
      "작은 PoC 또는 solver script를 작성해 가설을 빠르게 참/거짓으로 판정하세요."
    ][round % 4];
    return {
      worker_id: worker.id,
      worker_role: role,
      task: `${focus} ${base}`,
      reason: "idle solver worker가 있어 flag 우선의 빠른 시도와 pivot을 진행"
    };
  }
  if (role === "writeup") {
    return {
      worker_id: worker.id,
      worker_role: role,
      task: `현재 결과를 기준으로 writeup 초안을 아주 짧게 갱신하세요. flag가 없으면 긴 설명 대신 실패한 가설, pivot해야 할 방향, 다음 solver 요구사항만 명확히 쓰세요. ${base}`,
      reason: "idle writeup worker가 있어 풀이 흐름을 방해하지 않는 최소 산출물 정리"
    };
  }
  return {
    worker_id: worker.id,
    worker_role: role,
    task: `역할 ${role} 기준으로 flag에 가까워지는 다음 CTF 분석 단계를 하나 수행하세요. 이전 시도와 같은 표면이면 계속할 신호를 먼저 제시하고, 신호가 없으면 다른 접근으로 pivot하세요. ${base}`,
    reason: `idle ${role} worker가 있어 CTF flag 우선 후속 작업 배정`
  };
}

function isWorkerAvailableForAutoAssign(state: RunState, agentId: string): boolean {
  const status = state.agents[agentId]?.status ?? "idle";
  return status === "idle" || status === "done" || status === "failed" || status === "blocked";
}

async function dockerWorkerHoldReason(runbook: Runbook, state: RunState): Promise<string | undefined> {
  void runbook;
  void state;
  return undefined;
}

async function startAdvisorLoop(runDir: string, options: { continuous?: boolean } = {}): Promise<void> {
  const current = await readState(runDir);
  if (isPidAlive(current.advisor.pid)) {
    await appendEvent(runDir, {
      time: nowIso(),
      runId: current.runId,
      type: "advisor.loop.already-running",
      source: "advisor",
      agentId: "advisor",
      message: `advisor loop already running with pid ${current.advisor.pid}`
    });
    return;
  }
  const flags = ["--run-dir", runDir];
  if (options.continuous) flags.push("--continuous");
  const { command, args } = internalCommandArgs("advisor-loop", flags);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env
  });
  child.unref();
  await updateState(runDir, (state) => {
    state.advisor.status = "running";
    state.advisor.pid = child.pid;
  });
}

export async function startQueuedTasks(runDir: string, runbook?: Runbook): Promise<void> {
  const resolvedRunbook = runbook ?? (await loadRunbook(path.join(runDir, "runbook.yml")));
  const state = await readState(runDir);
  const activeTasks = Object.values(state.tasks).filter((task) => task.status === "running" || task.status === "starting");
  const activeAgentIds = new Set(activeTasks.map((task) => task.agentId));
  const running = activeTasks.length;
  const available = Math.max(0, resolvedRunbook.limits.max_parallel_agents - running);
  if (available === 0) return;
  const queued = Object.values(state.tasks)
    .filter((task) => task.status === "queued" && !activeAgentIds.has(task.agentId))
    .slice(0, available);
  for (const task of queued) {
    activeAgentIds.add(task.agentId);
    await spawnWorker(runDir, task.id);
  }
}

async function spawnWorker(runDir: string, taskId: string): Promise<void> {
  await updateState(runDir, (state) => {
    const task = state.tasks[taskId];
    if (!task || task.status !== "queued") return;
    task.status = "starting";
    const agent = state.agents[task.agentId];
    if (agent) {
      agent.status = "running";
      agent.currentTaskId = taskId;
    }
  });

  const { command, args } = internalCommandArgs("worker", ["--run-dir", runDir, "--task-id", taskId]);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env
  });
  child.unref();
  await updateState(runDir, (state) => {
    const task = state.tasks[taskId];
    if (!task || task.status !== "starting") return;
    task.pid = child.pid;
    const agent = state.agents[task.agentId];
    if (agent) {
      agent.status = "running";
      agent.pid = child.pid;
      agent.currentTaskId = taskId;
    }
  });
}

function pickAgentForTask(agents: AgentConfig[], state: Awaited<ReturnType<typeof readState>>, id?: string, role?: string): AgentConfig | undefined {
  const workers = agents.filter((agent) => agent.role !== "advisor" && agent.id !== "advisor");
  const isAvailable = (agent: AgentConfig): boolean => isWorkerAvailableForAutoAssign(state, agent.id) && !hasPendingTaskForAgent(state, agent.id);
  if (id) {
    const agent = workers.find((candidate) => candidate.id === id);
    return agent && isAvailable(agent) ? agent : undefined;
  }
  const matching = role ? workers.filter((agent) => agent.role === role) : workers;
  return matching.find(isAvailable);
}

function hasPendingTaskForAgent(state: Awaited<ReturnType<typeof readState>>, agentId: string): boolean {
  return Object.values(state.tasks).some((task) => task.agentId === agentId && ["queued", "starting", "running"].includes(task.status));
}

function hasCodexAuthFailure(state: RunState): boolean {
  return state.errors.some((error) => error.includes("401 Unauthorized") || error.includes("Codex API 401"));
}

function mergeCandidates(
  state: RunState,
  updates: ReturnType<typeof parseCandidateUpdates>,
  context: { taskId: string; agentId: string }
): void {
  if (!updates.length) return;
  if (!state.candidates) state.candidates = {};
  const now = nowIso();
  for (const update of updates) {
    const existing = state.candidates[update.id];
    const evidenceRefs = mergeEvidenceRefs(existing?.evidenceRefs, update.evidenceRefs);
    const merged: Candidate = {
      id: update.id,
      lane: update.lane ?? existing?.lane,
      vulnClass: update.vulnClass ?? existing?.vulnClass,
      asset: update.asset ?? existing?.asset,
      status: update.status,
      capability: update.capability ?? existing?.capability,
      impact: update.impact ?? existing?.impact,
      missingProof: update.missingProof ?? existing?.missingProof,
      notes: update.notes ?? existing?.notes,
      evidenceRefs,
      lastDecisionAt: now,
      lastTaskId: context.taskId,
      lastAgentId: context.agentId
    };
    state.candidates[update.id] = merged;
    if (merged.status === "report-ready" || merged.status === "solved") {
      const summary = `${merged.id}: ${merged.status}${merged.capability ? ` — ${truncate(merged.capability, 160)}` : ""}`;
      state.findings = Array.from(new Set([...state.findings, summary])).slice(-50);
    }
  }
}

function mergeEvidenceRefs(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  const merged = new Set<string>();
  for (const value of existing ?? []) merged.add(value);
  for (const value of incoming ?? []) merged.add(value);
  return Array.from(merged).slice(-12);
}

function workerFailureMessage(agentId: string, taskId: string, exitCode: number | null, finalMessage: string): string {
  const text = truncate(finalMessage.replace(/\s+/g, " ").trim(), 500);
  const auth = text.includes("401 Unauthorized") ? " Codex API 401 Unauthorized." : "";
  return `${agentId}/${taskId} exited with code ${exitCode}.${auth}${text ? ` ${text}` : ""}`;
}

async function maybeCompleteRun(runDir: string): Promise<void> {
  const runbook = await loadRunbook(path.join(runDir, "runbook.yml"));
  if (runbook.interactive) return;
  const state = await readState(runDir);
  if (state.status !== "running") return;
  if (!allTasksTerminal(state)) return;
  await updateState(runDir, (next) => {
    if (next.status === "running" && allTasksTerminal(next)) {
      next.status = Object.values(next.tasks).some((task) => task.status === "failed") ? "failed" : "completed";
    }
  });
}

function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function emitAdvisorHeartbeat(runDir: string): Promise<void> {
  const now = nowIso();
  const state = await updateState(runDir, (next) => {
    next.advisor.lastHeartbeatAt = now;
  });
  await appendEvent(runDir, {
    time: now,
    runId: state.runId,
    type: "advisor.heartbeat",
    source: "advisor",
    agentId: "advisor",
    message: `cycles=${state.advisor.cycles} pid=${state.advisor.pid ?? "n/a"}`
  });
}

async function reapDeadWorkers(runDir: string): Promise<void> {
  const state = await readState(runDir);
  const stale: Array<{ taskId: string; agentId: string; pid?: number }> = [];
  for (const task of Object.values(state.tasks)) {
    if (task.status !== "running" && task.status !== "starting") continue;
    if (task.pid && isPidAlive(task.pid)) continue;
    stale.push({ taskId: task.id, agentId: task.agentId, pid: task.pid });
  }
  if (!stale.length) return;
  await updateState(runDir, (next) => {
    for (const entry of stale) {
      const task = next.tasks[entry.taskId];
      if (task && (task.status === "running" || task.status === "starting")) {
        task.status = "failed";
        task.endedAt = nowIso();
        task.lastMessage = `worker process pid=${entry.pid ?? "?"} exited without writing back state; reaped by coordinator`;
        task.exitCode = task.exitCode ?? null;
      }
      const agent = next.agents[entry.agentId];
      if (agent) {
        agent.status = "failed";
        agent.pid = undefined;
        agent.lastMessage = `worker pid=${entry.pid ?? "?"} reaped by coordinator`;
        agent.lastUpdate = nowIso();
      }
      next.errors.push(`reaped ${entry.agentId}/${entry.taskId} pid=${entry.pid ?? "?"}`);
    }
  });
  for (const entry of stale) {
    await appendEvent(runDir, {
      time: nowIso(),
      runId: state.runId,
      type: "task.reaped",
      source: "orchestrator",
      agentId: entry.agentId,
      taskId: entry.taskId,
      message: `worker pid=${entry.pid ?? "?"} not alive; marked failed`
    });
  }
}

function allTasksTerminal(state: Awaited<ReturnType<typeof readState>>): boolean {
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0) return false;
  return tasks.every((task) => ["done", "failed", "blocked", "stopped"].includes(task.status));
}

async function waitUntilNoActiveTasks(runDir: string): Promise<void> {
  while (true) {
    const state = await readState(runDir);
    const active = Object.values(state.tasks).some((task) => ["queued", "starting", "running"].includes(task.status));
    if (!active) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function writeReport(runDir: string, html: string): Promise<string> {
  const reportDir = path.join(runDir, "reports");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.html");
  await writeFile(reportPath, html, "utf8");
  return reportPath;
}

export async function removeRunArtifacts(runDir: string): Promise<void> {
  await rm(runDir, { recursive: true, force: true });
}
