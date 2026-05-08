#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { commandExists, pathExists } from "./utils.js";
import { latestRunId, readState, runDirFor } from "./store.js";
import {
  askAdvisor,
  assignWorkerTask,
  runAdvisorLoop,
  startContinuousAdvisorLoop,
  runWorkerTask,
  startInteractiveSession,
  startRun,
  stopTarget,
  updateScope,
  writeReport
} from "./orchestrator.js";
import { runDashboard } from "./dashboard.js";
import { readAgentLogs, renderNativeEvents, renderNativeStatus, renderNativeWorkers, renderReportHtml, renderStatus, renderSummary, renderWorkerFeed } from "./render.js";
import type { Profile, SandboxMode } from "./types.js";
import { launchNativeAdvisor } from "./native.js";
import { loadRunbook } from "./runbook.js";
import { buildWorkerImage, DEFAULT_WORKER_IMAGE, getDockerSummary, hasDockerImage, WORKER_IMAGE_CANDIDATES } from "./docker.js";

const program = new Command();

program
  .name("huntctl")
  .description("Codex-powered CTF and bug bounty agent orchestration CLI")
  .version("0.1.0");

program.action(async () => {
  await startCommand({
    profile: "bug-bounty",
    workers: 3,
    sandbox: "auto",
    dashboard: true,
    native: true,
    danger: true
  });
});

program
  .command("start")
  .description("Start an interactive advisor session without a YAML runbook")
  .option("--profile <profile>", "ctf or bug-bounty", "bug-bounty")
  .option("--workers <n>", "number of worker agents", parsePositiveInt, 3)
  .option("--role <role>", "worker role, repeatable", collect, [])
  .option("--sandbox <mode>", "auto, docker, or host", "auto")
  .option("--strict-sandbox", "fail instead of falling back to host when Docker sandbox is unavailable", false)
  .option("--image <image>", "Docker image for --sandbox docker")
  .option("--target <name>", "target or challenge name")
  .option("--target-dir <path>", "workspace folder for this target/session; defaults to ./targets/<target>-<timestamp>")
  .option("--description <text>", "target/challenge description")
  .option("--scope <url>", "in-scope URL, repeatable", collect, [])
  .option("--out-of-scope <url>", "out-of-scope URL, repeatable", collect, [])
  .option("--file <path>", "CTF challenge file, repeatable", collect, [])
  .option("--evidence-dir <path>", "host directory for shared evidence/artifacts; defaults to <target-dir>/evidence")
  .option("--vrt <name>", "VRT category, repeatable", collect, [])
  .option("--weakness <name>", "weakness/CWE/OWASP item, repeatable", collect, [])
  .option("--platform <platform>", "hackerone, bugcrowd, or custom", "custom")
  .option("--hackerone-weaknesses-url <url>", "HackerOne weakness types URL")
  .option("--bugcrowd-vrt <path>", "Bugcrowd VRT JSON path")
  .option("--report-template <path>", "bug bounty report template file")
  .option("--no-native", "use the built-in huntctl dashboard instead of tmux native advisor")
  .option("--danger", "run Codex advisor/workers with danger bypass enabled", true)
  .option("--no-danger", "disable danger bypass flag in run metadata")
  .option("--no-attach", "create native tmux session without attaching")
  .option("--no-dashboard", "create the session but do not open dashboard")
  .action(async (options: StartOptions) => {
    await startCommand(options);
  });

program
  .command("scope")
  .description("Manage bug bounty scope for the current run")
  .command("add")
  .description("Add in-scope URLs/domains")
  .argument("<urls...>")
  .option("--run-id <run-id>", "run id")
  .action(async (urls: string[], options: { runId?: string }) => {
    const id = options.runId ?? (await latestRunId());
    await updateScope({ runDir: runDirFor(id), urls, outOfScope: false });
    console.log(`added in-scope: ${urls.join(", ")}`);
  });

program.commands
  .find((command) => command.name() === "scope")
  ?.command("exclude")
  .description("Add out-of-scope URLs/domains")
  .argument("<urls...>")
  .option("--run-id <run-id>", "run id")
  .action(async (urls: string[], options: { runId?: string }) => {
    const id = options.runId ?? (await latestRunId());
    await updateScope({ runDir: runDirFor(id), urls, outOfScope: true });
    console.log(`added out-of-scope: ${urls.join(", ")}`);
  });

program
  .command("doctor")
  .description("Check local dependencies")
  .action(async () => {
    const checks: Array<readonly [string, boolean]> = [
      ["node", true],
      ["npm", await commandExists("npm")],
      ["codex", await commandExists("codex")],
      ["docker", await commandExists("docker")]
    ];
    for (const [name, ok] of checks) {
      console.log(`${ok ? "ok " : "miss"} ${name}`);
    }
    if (await commandExists("docker")) {
      console.log("\nDocker worker images:");
      for (const image of WORKER_IMAGE_CANDIDATES) {
        const summary = await getDockerSummary({ sandbox: { mode: "docker", image } });
        console.log(`  ${summary.message}`);
      }
      console.log(`\n통합 worker 이미지 빌드: huntctl sandbox build --image ${DEFAULT_WORKER_IMAGE}`);
      console.log(`실행 예시: huntctl start --sandbox docker --image ${DEFAULT_WORKER_IMAGE}`);
    }
  });

program
  .command("sandbox")
  .description("Build and check the unified Docker worker sandbox")
  .command("build")
  .description("Build the unified Docker image used by workers")
  .option("--image <image>", "image tag", DEFAULT_WORKER_IMAGE)
  .option("--dockerfile <path>", "Dockerfile path", "sandbox/Dockerfile.sandbox")
  .option("--context <path>", "Docker build context", ".")
  .option("--no-audit", "skip ctf-tool-audit and MCP doctor after build")
  .action(async (options: { image: string; dockerfile: string; context: string; audit?: boolean }) => {
    await buildWorkerImage({
      image: options.image,
      dockerfile: options.dockerfile,
      context: options.context,
      audit: options.audit !== false
    });
  });

program
  .command("run")
  .description("Start a run from a YAML runbook")
  .argument("<runbook>", "runbook YAML path")
  .option("--sandbox <mode>", "auto, docker, or host", "auto")
  .option("--strict-sandbox", "fail instead of falling back to host when Docker sandbox is unavailable", false)
  .option("--image <image>", "Docker image override for --sandbox docker")
  .option("--foreground", "wait until queued worker tasks finish")
  .option("--mock", "use fake Codex responses for local smoke tests")
  .action(async (runbook: string, options: { sandbox: SandboxMode; image?: string; foreground?: boolean; mock?: boolean; strictSandbox?: boolean }) => {
    if (options.mock) process.env.HUNTCTL_FAKE_CODEX = "1";
    const result = await startRun({
      runbookPath: path.resolve(runbook),
      workspace: process.cwd(),
      sandboxMode: options.sandbox,
      dockerImage: options.image,
      strictSandbox: Boolean(options.strictSandbox),
      foreground: options.foreground
    });
    console.log(`run_id: ${result.runId}`);
    console.log(`run_dir: ${result.runDir}`);
    console.log(`dashboard: huntctl dashboard ${result.runId}`);
  });

program
  .command("dashboard")
  .description("Open the terminal dashboard")
  .argument("[run-id]", "run id")
  .action(async (runId?: string) => {
    const id = runId ?? (await latestRunId());
    await runDashboard(runDirFor(id));
  });

program
  .command("resume")
  .description("Reattach or resume the native Codex advisor for an existing run")
  .argument("[run-id]", "run id")
  .option("--fresh", "start a fresh advisor instead of Codex resume")
  .option("--no-attach", "create/reuse the tmux session without attaching")
  .action(async (runId?: string, options?: { fresh?: boolean; attach?: boolean }) => {
    const id = runId ?? (await latestRunId());
    const runDir = runDirFor(id);
    await readState(runDir);
    await startContinuousAdvisorLoop(runDir);
    const runbook = await loadRunbook(path.join(runDir, "runbook.yml"));
    const native = await launchNativeAdvisor({
      runDir,
      runbook,
      attach: options?.attach !== false,
      resume: !options?.fresh,
      reuseExisting: !options?.fresh
    });
    console.log(`run_id: ${id}`);
    console.log(`native_session: ${native.sessionName}`);
    console.log(`attach: tmux attach -t ${native.sessionName}`);
  });

program
  .command("status")
  .description("Print run status")
  .argument("[run-id]", "run id")
  .option("--watch", "refresh every two seconds")
  .action(async (runId?: string, options?: { watch?: boolean }) => {
    const id = runId ?? (await latestRunId());
    const runDir = runDirFor(id);
    if (!options?.watch) {
      console.log(await renderStatus(runDir));
      return;
    }
    while (true) {
      console.clear();
      console.log(await renderStatus(runDir));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  });

program
  .command("summary")
  .description("Print advisor summary")
  .argument("[run-id]", "run id")
  .action(async (runId?: string) => {
    const id = runId ?? (await latestRunId());
    process.stdout.write(await renderSummary(runDirFor(id)));
  });

program
  .command("logs")
  .description("Print logs for an agent")
  .argument("<agent-id>", "agent id")
  .option("--run-id <run-id>", "run id")
  .action(async (agentId: string, options: { runId?: string }) => {
    const id = options.runId ?? (await latestRunId());
    process.stdout.write(await readAgentLogs(runDirFor(id), agentId));
  });

program
  .command("ask")
  .description("Ask the advisor")
  .argument("<message...>", "message")
  .option("--run-id <run-id>", "run id")
  .action(async (message: string[], options: { runId?: string }) => {
    const id = options.runId ?? (await latestRunId());
    await askAdvisor({ runDir: runDirFor(id), message: message.join(" ") });
    process.stdout.write(await renderSummary(runDirFor(id)));
  });

program
  .command("loop")
  .description("Start the continuous advisor coordinator loop for a run")
  .argument("[run-id]", "run id")
  .option("--foreground", "run the loop in this terminal instead of detaching")
  .action(async (runId?: string, options?: { foreground?: boolean }) => {
    const id = runId ?? (await latestRunId());
    const runDir = runDirFor(id);
    if (options?.foreground) {
      await runAdvisorLoop({ runDir, continuous: true });
      return;
    }
    await startContinuousAdvisorLoop(runDir);
    console.log(`continuous advisor loop: ${id}`);
  });

program
  .command("assign")
  .description("Assign a task to a worker")
  .argument("<worker-id>", "worker id")
  .argument("<message...>", "task")
  .option("--run-id <run-id>", "run id")
  .action(async (workerId: string, message: string[], options: { runId?: string }) => {
    const id = options.runId ?? (await latestRunId());
    const taskId = await assignWorkerTask({ runDir: runDirFor(id), agentId: workerId, prompt: message.join(" "), source: "user" });
    console.log(`queued: ${taskId}`);
  });

program
  .command("stop")
  .description("Stop a run or worker")
  .argument("<target>", "run id, agent id, or 'run'")
  .option("--run-id <run-id>", "run id when target is an agent")
  .action(async (target: string, options: { runId?: string }) => {
    const id = options.runId ?? (target.startsWith("ctf-") || target.startsWith("bb-") ? target : await latestRunId());
    await stopTarget({ runDir: runDirFor(id), target });
    console.log(`stopped: ${target}`);
  });

program
  .command("report")
  .description("Write a report")
  .option("--html", "write HTML report")
  .option("--run-id <run-id>", "run id")
  .action(async (options: { html?: boolean; runId?: string }) => {
    const id = options.runId ?? (await latestRunId());
    const runDir = runDirFor(id);
    if (!options.html) {
      process.stdout.write(await renderSummary(runDir));
      return;
    }
    const reportPath = await writeReport(runDir, await renderReportHtml(runDir));
    console.log(reportPath);
  });

program
  .command("worker", { hidden: true })
  .requiredOption("--run-dir <run-dir>")
  .requiredOption("--task-id <task-id>")
  .action(async (options: { runDir: string; taskId: string }) => {
    await runWorkerTask({ runDir: options.runDir, taskId: options.taskId });
  });

program
  .command("advisor-loop", { hidden: true })
  .requiredOption("--run-dir <run-dir>")
  .option("--once")
  .option("--continuous")
  .action(async (options: { runDir: string; once?: boolean; continuous?: boolean }) => {
    await runAdvisorLoop({ runDir: options.runDir, once: options.once, continuous: options.continuous });
  });

program
  .command("native-status", { hidden: true })
  .argument("<run-id>", "run id")
  .action(async (runId: string) => {
    await watchNativeStatus(runId);
  });

program
  .command("native-events", { hidden: true })
  .argument("<run-id>", "run id")
  .action(async (runId: string) => {
    await watchNativeEvents(runId);
  });

program
  .command("native-workers", { hidden: true })
  .argument("<run-id>", "run id")
  .action(async (runId: string) => {
    await watchNativeWorkers(runId);
  });

program
  .command("worker-feed", { hidden: true })
  .argument("<run-id>", "run id")
  .argument("<agent-id>", "agent id")
  .action(async (runId: string, agentId: string) => {
    await watchWorkerFeed(runId, agentId);
  });

program
  .command("cat-state", { hidden: true })
  .argument("[run-id]", "run id")
  .action(async (runId?: string) => {
    const id = runId ?? (await latestRunId());
    process.stdout.write(await readFile(path.join(runDirFor(id), "state.json"), "utf8"));
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

interface StartOptions {
  profile?: Profile;
  workers?: number;
  role?: string[];
  sandbox?: SandboxMode;
  image?: string;
  target?: string;
  targetDir?: string;
  description?: string;
  scope?: string[];
  outOfScope?: string[];
  file?: string[];
  evidenceDir?: string;
  vrt?: string[];
  weakness?: string[];
  platform?: "hackerone" | "bugcrowd" | "custom";
  hackeroneWeaknessesUrl?: string;
  bugcrowdVrt?: string;
  reportTemplate?: string;
  dashboard?: boolean;
  native?: boolean;
  danger?: boolean;
  attach?: boolean;
  strictSandbox?: boolean;
}

async function startCommand(options: StartOptions): Promise<void> {
  const profile = normalizeProfile(options.profile);
  const sandbox = normalizeSandbox(options.sandbox);
  const dockerImage = await resolveDockerImage(profile, sandbox, options.image);
  const selectedSandbox: SandboxMode = sandbox === "auto" && dockerImage ? "docker" : sandbox;
  const platform = normalizePlatform(options.platform);
  const bugcrowdVrt = await resolveBugcrowdVrt(options.bugcrowdVrt);
  const reportTemplate = await resolveReportTemplate(options.reportTemplate, platform);
  const result = await startInteractiveSession({
    profile,
    workers: options.workers ?? 3,
    roles: options.role,
    sandboxMode: selectedSandbox,
    dockerImage,
    strictSandbox: Boolean(options.strictSandbox),
    danger: options.danger !== false,
    workspace: process.cwd(),
    targetName: options.target,
    targetDir: options.targetDir,
    description: options.description,
    scope: options.scope,
    outOfScope: options.outOfScope,
    files: options.file?.map((file) => path.resolve(file)),
    evidenceDir: options.evidenceDir,
    vrt: options.vrt,
    weaknesses: options.weakness,
    reportTemplate,
    platform,
    hackeroneWeaknessesUrl:
      options.hackeroneWeaknessesUrl ?? (platform === "hackerone" ? "https://docs.hackerone.com/en/articles/8475337-types-of-weaknesses" : undefined),
    bugcrowdVrtPath: bugcrowdVrt
  });
  console.log(`run_id: ${result.runId}`);
  console.log(`run_dir: ${result.runDir}`);
  const state = await readState(result.runDir);
  console.log(`target_dir: ${state.workspace}`);
  console.log(`evidence_dir: ${path.resolve(state.workspace, (await loadRunbook(path.join(result.runDir, "runbook.yml"))).evidence_dir)}`);
  console.log(`profile: ${profile}`);
  console.log(`workers: ${options.workers ?? 3}`);
  console.log(`sandbox: ${selectedSandbox}`);
  console.log(`danger: ${options.danger !== false ? "enabled" : "disabled"}`);
  if (dockerImage) console.log(`docker_image: ${dockerImage}`);
  await startContinuousAdvisorLoop(result.runDir);
  if (options.native) {
    const runbook = await loadRunbook(path.join(result.runDir, "runbook.yml"));
    const native = await launchNativeAdvisor({
      runDir: result.runDir,
      runbook,
      attach: options.attach !== false
    });
    console.log(`native_session: ${native.sessionName}`);
    console.log(`attach: tmux attach -t ${native.sessionName}`);
    return;
  }
  console.log(`dashboard: huntctl dashboard ${result.runId}`);
  if (options.dashboard !== false) {
    await runDashboard(result.runDir);
  }
}

async function watchNativeStatus(runId: string): Promise<void> {
  const runDir = runDirFor(runId);
  let last = "";
  let dockerMessage = "";
  let lastDocker = 0;
  let lastCoordinatorCheck = 0;
  process.on("SIGINT", () => {
    process.exit(0);
  });
  while (true) {
    if (Date.now() - lastCoordinatorCheck > 10000) {
      lastCoordinatorCheck = Date.now();
      const state = await readState(runDir);
      if (state.status === "running" && !isPidAlive(state.advisor.pid)) {
        await startContinuousAdvisorLoop(runDir);
      }
    }
    if (Date.now() - lastDocker > 15000 || !dockerMessage) {
      lastDocker = Date.now();
      const runbook = await loadRunbook(path.join(runDir, "runbook.yml"));
      dockerMessage = (await getDockerSummary(runbook)).message;
    }
    const output = await renderNativeStatus(runDir, dockerMessage);
    if (output !== last) {
      appendPaneSnapshot("summary", output, Boolean(last));
      last = output;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

async function watchNativeEvents(runId: string): Promise<void> {
  const runDir = runDirFor(runId);
  let last = "";
  process.on("SIGINT", () => {
    process.exit(0);
  });
  while (true) {
    const output = await renderNativeEvents(runDir, 35);
    if (output !== last) {
      appendPaneSnapshot("events", output, Boolean(last));
      last = output;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function watchWorkerFeed(runId: string, agentId: string): Promise<void> {
  const runDir = runDirFor(runId);
  let last = "";
  process.on("SIGINT", () => {
    process.exit(0);
  });
  while (true) {
    const output = await renderWorkerFeed(runDir, agentId, 90);
    if (output !== last) {
      appendPaneSnapshot(agentId, output, Boolean(last));
      last = output;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function watchNativeWorkers(runId: string): Promise<void> {
  const runDir = runDirFor(runId);
  let last = "";
  process.on("SIGINT", () => {
    process.exit(0);
  });
  while (true) {
    const output = await renderNativeWorkers(runDir, 4);
    if (output !== last) {
      appendPaneSnapshot("workers", output, Boolean(last));
      last = output;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const paneSnapshotCounts = new Map<string, number>();

function appendPaneSnapshot(label: string, output: string, separated: boolean): void {
  const count = (paneSnapshotCounts.get(label) ?? 0) + 1;
  paneSnapshotCounts.set(label, count);
  const divider = `\n── ${label} #${count} 갱신 ${clockTime()} ──\n`;
  if (process.env.HUNTCTL_PANE_HISTORY === "1") {
    process.stdout.write(`${separated ? divider : ""}${output.trimEnd()}\n`);
    return;
  }
  process.stdout.write(`\x1b[H\x1b[2J\x1b[3J${divider.trimStart()}${output.trimEnd()}\n`);
}

function clockTime(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function normalizeProfile(value?: Profile): Profile {
  if (value === "ctf" || value === "bug-bounty") return value;
  throw new Error(`Invalid profile: ${value}. Expected ctf or bug-bounty.`);
}

function normalizeSandbox(value?: SandboxMode): SandboxMode {
  if (value === "auto" || value === "docker" || value === "host") return value;
  throw new Error(`Invalid sandbox: ${value}. Expected auto, docker, or host.`);
}

function normalizePlatform(value?: string): "hackerone" | "bugcrowd" | "custom" {
  if (value === "hackerone" || value === "bugcrowd" || value === "custom" || value === undefined) return value ?? "custom";
  throw new Error(`Invalid platform: ${value}. Expected hackerone, bugcrowd, or custom.`);
}

async function resolveBugcrowdVrt(value?: string): Promise<string | undefined> {
  if (value) return path.resolve(value);
  const local = path.resolve("vulnerability-rating-taxonomy.json");
  return (await pathExists(local)) ? local : undefined;
}

async function resolveReportTemplate(value: string | undefined, platform: "hackerone" | "bugcrowd" | "custom"): Promise<string | undefined> {
  if (value) return path.resolve(value);
  const template =
    platform === "hackerone"
      ? path.resolve("templates/hackerone-report.md")
      : platform === "bugcrowd"
        ? path.resolve("templates/bugcrowd-report.md")
        : undefined;
  return template && (await pathExists(template)) ? template : undefined;
}

function defaultDockerImage(profile: Profile): string {
  return profile === "ctf" ? DEFAULT_WORKER_IMAGE : DEFAULT_WORKER_IMAGE;
}

async function resolveDockerImage(profile: Profile, sandbox: SandboxMode, explicitImage?: string): Promise<string | undefined> {
  if (explicitImage) return explicitImage;
  if (sandbox === "host") return undefined;
  const image = defaultDockerImage(profile);
  for (const candidate of WORKER_IMAGE_CANDIDATES) {
    if (await hasDockerImage(candidate)) return candidate;
  }
  if (sandbox === "docker") return image;
  return undefined;
}
