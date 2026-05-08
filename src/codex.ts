import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, HuntEvent, Runbook } from "./types.js";
import { agentDir, appendEvent, taskDir, updateState } from "./store.js";
import { nowIso, safeDockerName, truncate } from "./utils.js";
import { hasDockerImage } from "./docker.js";
import { reasoningEffortForAgent } from "./reasoning.js";

export interface CodexRunOptions {
  runDir: string;
  runId: string;
  taskId: string;
  agent: AgentConfig;
  runbook: Runbook;
  prompt: string;
  workspace: string;
  sandboxMode: Runbook["sandbox"]["mode"];
}

export interface CodexRunResult {
  exitCode: number | null;
  finalMessage: string;
  usedSandbox: ExecutionSandbox;
  artifactDir: string;
  evidenceDir: string;
}

type ExecutionSandbox = "host" | "docker";

interface DockerRuntimeMounts {
  shared: string;
  cache: string;
  distfiles: string;
}

export const CODEX_TOKEN_SAVER_PROFILE = "huntctl-token-saver";
export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 2000;
const CODEX_EVENT_TEXT_LIMIT = 900;

export async function runCodexTask(options: CodexRunOptions): Promise<CodexRunResult> {
  if (process.env.HUNTCTL_FAKE_CODEX === "1") {
    return runFakeCodexTask(options);
  }

  const usedSandbox = await resolveSandbox(options.runbook, options.sandboxMode, {
    runDir: options.runDir,
    runId: options.runId,
    agentId: options.agent.id,
    taskId: options.taskId
  });
  const codexHome = await prepareRunCodexHome(options.runDir);
  const dockerCodexHome = usedSandbox === "docker" ? codexHome : undefined;
  const dockerRuntime = usedSandbox === "docker" ? await prepareDockerRuntimeMounts(options.runDir) : undefined;
  const agentPath = agentDir(options.runDir, options.agent.id);
  const taskPath = taskDir(options.runDir, options.taskId);
  await mkdir(agentPath, { recursive: true });
  await mkdir(taskPath, { recursive: true });
  const artifactPath = path.join(taskPath, "artifacts");
  const evidencePath = resolveHostEvidenceDir(options.workspace, options.runbook.evidence_dir);
  await mkdir(artifactPath, { recursive: true });
  await mkdir(evidencePath, { recursive: true });
  const outputLastMessage = path.join(taskPath, "final.md");
  const rawJsonlPath = path.join(taskPath, "codex.jsonl");
  const stderrPath = path.join(taskPath, "stderr.log");
  await writeFile(path.join(taskPath, "prompt.md"), options.prompt, "utf8");

  const { command, args } = buildCodexCommand({
    ...options,
    outputLastMessage,
    artifactPath,
    evidencePath,
    usedSandbox,
    dockerCodexHome,
    dockerRuntime
  });

  await appendEvent(options.runDir, {
    time: nowIso(),
    runId: options.runId,
    type: "codex.started",
    source: "worker",
    agentId: options.agent.id,
    taskId: options.taskId,
    message: codexStartMessage(command, options, usedSandbox),
    data: {
      usedSandbox,
      dockerImage: usedSandbox === "docker" ? dockerImageForRunbook(options.runbook) : undefined,
      codexAccess: codexAccessMode({ runbook: options.runbook, usedSandbox }),
      artifactDir: artifactPath,
      evidenceDir: evidencePath
    }
  });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.workspace,
      env: codexEnvironment(codexHome, artifactPath, evidencePath),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let buffer = "";
    child.stdout.on("data", async (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      await appendFile(rawJsonlPath, text, "utf8");
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        await handleCodexLine(options, line);
      }
    });

    child.stderr.on("data", async (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      await appendFile(stderrPath, text, "utf8");
    });

    child.on("error", reject);
    child.on("exit", async (code) => {
      if (buffer.trim()) {
        await handleCodexLine(options, buffer.trim());
      }
      let finalMessage = "";
      try {
        finalMessage = await readFile(outputLastMessage, "utf8");
      } catch {
        finalMessage = "";
      }
      if (!finalMessage.trim()) {
        try {
          finalMessage = truncate(await readFile(stderrPath, "utf8"), 4000);
        } catch {
          finalMessage = "";
        }
      }
      await exportTaskMetadata({
        artifactPath,
        evidencePath,
        outputLastMessage,
        promptPath: path.join(taskPath, "prompt.md"),
        stderrPath,
        options,
        usedSandbox,
        exitCode: code
      });
      await appendFile(path.join(agentPath, "logs.md"), `\n\n## ${options.taskId}\n\n${finalMessage}\n`, "utf8");
      resolve({
        exitCode: code,
        finalMessage,
        usedSandbox,
        artifactDir: artifactPath,
        evidenceDir: evidencePath
      });
    });
  });
}

async function runFakeCodexTask(options: CodexRunOptions): Promise<CodexRunResult> {
  const agentPath = agentDir(options.runDir, options.agent.id);
  const taskPath = taskDir(options.runDir, options.taskId);
  const artifactPath = path.join(taskPath, "artifacts");
  const evidencePath = resolveHostEvidenceDir(options.workspace, options.runbook.evidence_dir);
  await mkdir(agentPath, { recursive: true });
  await mkdir(taskPath, { recursive: true });
  await mkdir(artifactPath, { recursive: true });
  await mkdir(evidencePath, { recursive: true });
  await writeFile(path.join(taskPath, "prompt.md"), options.prompt, "utf8");
  const finalMessage =
    options.agent.role === "advisor" || options.agent.id === "advisor"
      ? JSON.stringify(
          {
            summary: `Mock advisor summary for ${options.runId}. Workers were reviewed and no additional tasks were assigned.`,
            next_tasks: [],
            held_tasks: [],
            auto_actions: [`mock advisor reviewed ${options.runId}`]
          },
          null,
          2
        )
      : [`# Mock ${options.agent.role} result`, "", `Task ${options.taskId} completed in fake Codex mode.`, "", "Findings: none."].join("\n");
  await writeFile(path.join(taskPath, "final.md"), finalMessage, "utf8");
  await appendFile(path.join(agentPath, "logs.md"), `\n\n## ${options.taskId}\n\n${finalMessage}\n`, "utf8");
  await appendEvent(options.runDir, {
    time: nowIso(),
    runId: options.runId,
    type: "codex.fake",
    source: "worker",
    agentId: options.agent.id,
    taskId: options.taskId,
    message: `fake ${options.agent.role} completed`
  });
  return {
    exitCode: 0,
    finalMessage,
    usedSandbox: "host",
    artifactDir: artifactPath,
    evidenceDir: evidencePath
  };
}

async function resolveSandbox(
  runbook: Runbook,
  mode: Runbook["sandbox"]["mode"],
  context: { runDir: string; runId: string; agentId: string; taskId: string }
): Promise<ExecutionSandbox> {
  const image = runbook.sandbox.image?.trim();
  const strict = Boolean(runbook.sandbox.strict);
  if (mode === "host") return "host";
  const dockerAvailable = image ? await hasDockerImage(image) : false;
  if (mode === "docker") {
    if (dockerAvailable) return "docker";
    const reason = !image
      ? "sandbox.image가 지정되지 않음"
      : `Docker 이미지 ${image}를 찾을 수 없음`;
    return await handleSandboxFallback({ ...context, strict, requestedMode: "docker", reason });
  }
  if (mode === "auto") {
    if (dockerAvailable) return "docker";
    const reason = !image
      ? "sandbox.image 미지정으로 host로 진행"
      : `Docker 이미지 ${image} 미존재로 host로 진행`;
    if (strict) {
      return await handleSandboxFallback({ ...context, strict, requestedMode: "auto", reason });
    }
    await recordSandboxFallback({ ...context, requestedMode: "auto", reason });
    return "host";
  }
  return "host";
}

async function handleSandboxFallback(params: {
  runDir: string;
  runId: string;
  agentId: string;
  taskId: string;
  strict: boolean;
  requestedMode: "auto" | "docker";
  reason: string;
}): Promise<ExecutionSandbox> {
  if (params.strict) {
    await appendEvent(params.runDir, {
      time: nowIso(),
      runId: params.runId,
      type: "sandbox.fallback.refused",
      source: "orchestrator",
      agentId: params.agentId,
      taskId: params.taskId,
      message: `strict sandbox: requested=${params.requestedMode} reason=${params.reason}`
    });
    throw new Error(
      `strict-sandbox: ${params.requestedMode} sandbox를 사용할 수 없습니다 (${params.reason}). ` +
        "sandbox 이미지를 빌드하거나 --strict-sandbox를 끄고 host fallback을 허용하세요."
    );
  }
  await recordSandboxFallback({ ...params });
  return "host";
}

async function recordSandboxFallback(params: {
  runDir: string;
  runId: string;
  agentId: string;
  taskId: string;
  requestedMode: "auto" | "docker";
  reason: string;
}): Promise<void> {
  const banner =
    `[huntctl sandbox fallback] requested=${params.requestedMode} reason=${params.reason}; ` +
    "host full-access로 실행됩니다. 격리가 필요하면 --strict-sandbox 또는 sandbox.strict=true를 사용하세요.";
  process.stderr.write(`\n${banner}\n`);
  await appendEvent(params.runDir, {
    time: nowIso(),
    runId: params.runId,
    type: "sandbox.fallback",
    source: "orchestrator",
    agentId: params.agentId,
    taskId: params.taskId,
    message: banner
  });
}

function buildCodexCommand(
  params: CodexRunOptions & {
    outputLastMessage: string;
    artifactPath: string;
    evidencePath: string;
    usedSandbox: ExecutionSandbox;
    dockerCodexHome?: string;
    dockerRuntime?: DockerRuntimeMounts;
  }
): {
  command: string;
  args: string[];
} {
  const codexArgs = ["exec"];
  const reasoningEffort = reasoningEffortForAgent(params.agent);
  if (params.agent.model) {
    codexArgs.push("--model", params.agent.model);
  }
  codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
  codexArgs.push(
    "--profile",
    CODEX_TOKEN_SAVER_PROFILE,
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "--disable",
    "apps",
    "-c",
    "features.apps=false",
    "-c",
    'web_search="disabled"',
    "-c",
    `tool_output_token_limit=${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`,
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "-c",
    'attribution=""',
    "--json",
    "--output-last-message",
    params.outputLastMessage,
    params.prompt
  );
  if (params.usedSandbox === "host") {
    return { command: "codex", args: codexArgs };
  }
  if (params.usedSandbox === "docker") {
    return buildDockerCommand(params, codexArgs);
  }
  return buildDockerCommand(params, codexArgs);
}

function codexAccessMode(params: { runbook: Runbook; usedSandbox: ExecutionSandbox }): string {
  if (params.usedSandbox === "docker") return "docker-container-full-access";
  void params.runbook;
  return "host-full-access";
}

function buildDockerCommand(
  params: CodexRunOptions & {
    outputLastMessage: string;
    artifactPath: string;
    evidencePath: string;
    usedSandbox: ExecutionSandbox;
    dockerCodexHome?: string;
    dockerRuntime?: DockerRuntimeMounts;
  },
  codexArgs: string[]
): {
  command: string;
  args: string[];
} {
  const image = dockerImageForRunbook(params.runbook);
  const containerName = safeDockerName(`huntctl-${params.runId}-${params.agent.id}-${params.taskId}`);
  const workspaceInContainer = "/workspace";
  const args = [
    "run",
    "--rm",
    "--privileged",
    "--network",
    process.env.HUNTCTL_DOCKER_NETWORK || "host",
    "--shm-size",
    process.env.HUNTCTL_DOCKER_SHM_SIZE || "2g",
    "--cap-add",
    "SYS_PTRACE",
    "--security-opt",
    "seccomp=unconfined",
    "--ulimit",
    "core=-1",
    "--name",
    containerName,
    "-v",
    `${params.workspace}:${params.workspace}`,
    "-v",
    `${params.workspace}:${workspaceInContainer}`,
    "-v",
    `${params.runDir}:${params.runDir}`,
    "-v",
    `${params.artifactPath}:/artifacts`,
    "-v",
    `${params.evidencePath}:/evidence`,
    "-w",
    workspaceInContainer,
    "-e",
    `WORKSPACE=${workspaceInContainer}`,
    "-e",
    `CTF_MCP_WORKSPACE=${workspaceInContainer}`,
    "-e",
    "CODEX_HOME=/root/.codex",
    "-e",
    "HUNTCTL_ARTIFACTS=/artifacts",
    "-e",
    "HUNTCTL_TASK_ARTIFACTS=/artifacts",
    "-e",
    "HUNTCTL_EVIDENCE_DIR=/evidence",
    "-e",
    "ANDROID_HOME=/opt/android-sdk",
    "-e",
    "ANDROID_SDK_ROOT=/opt/android-sdk",
    "-e",
    "QT_QPA_PLATFORM=offscreen"
  ];

  if (existsSync("/dev/kvm")) {
    args.push("--device", "/dev/kvm");
  }

  if (params.dockerRuntime) {
    args.push(
      "-v",
      `${params.dockerRuntime.shared}:/shared`,
      "-v",
      `${params.dockerRuntime.cache}:/cache`,
      "-v",
      `${params.dockerRuntime.distfiles}:/distfiles`,
      "-e",
      "SHARED=/shared",
      "-e",
      "CACHE=/cache",
      "-e",
      "DISTFILES=/distfiles",
      "-e",
      "CTF_MCP_SHARED=/shared",
      "-e",
      "CTF_MCP_CACHE=/cache",
      "-e",
      "CTF_MCP_DISTFILES=/distfiles"
    );
  }

  if (params.dockerCodexHome) {
    args.push("-v", `${params.dockerCodexHome}:/root/.codex`);
  }

  for (const envName of [
    "OPENAI_API_KEY",
    "CODEX_AGENT_IDENTITY",
    "DISTILL_HOST",
    "DISTILL_MODEL",
    "DISTILL_API_KEY",
    "DISTILL_TIMEOUT_MS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY"
  ]) {
    if (process.env[envName]) args.push("-e", envName);
  }

  args.push(
    image,
    "bash",
    "-lc",
    "if command -v ctf-mcp-configure >/dev/null 2>&1; then ctf-mcp-configure >/tmp/huntctl-mcp-configure.log 2>&1 || true; fi; exec codex \"$@\"",
    "huntctl-codex",
    ...codexArgs
  );
  return { command: "docker", args };
}

async function prepareDockerRuntimeMounts(runDir: string): Promise<DockerRuntimeMounts> {
  const root = path.join(runDir, "docker-runtime");
  const shared = path.join(root, "shared");
  const cache = path.join(root, "cache");
  const distfiles = path.join(root, "distfiles");
  await Promise.all([mkdir(shared, { recursive: true }), mkdir(cache, { recursive: true }), mkdir(distfiles, { recursive: true })]);
  return { shared, cache, distfiles };
}

export async function prepareRunCodexHome(runDir: string): Promise<string | undefined> {
  const source = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const uid = process.getuid?.() ?? "local";
  const base = codexHomeBase(runDir);
  await mkdir(base, { recursive: true });
  const candidates = [path.join(base, "default"), path.join(base, `user-${uid}`)];
  let lastPermissionError: unknown;

  for (const target of candidates) {
    try {
      await prepareWritableCodexHome(source, target);
      return target;
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      lastPermissionError = error;
    }
  }

  const fresh = await mkdtemp(path.join(base, `user-${uid}-`));
  try {
    await prepareWritableCodexHome(source, fresh);
    return fresh;
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    throw lastPermissionError ?? error;
  }
}

function codexHomeBase(runDir: string): string {
  if (process.env.HUNTCTL_CODEX_HOME_ROOT) {
    return path.resolve(process.env.HUNTCTL_CODEX_HOME_ROOT, safeDockerName(path.basename(runDir)));
  }
  return path.join(os.homedir(), ".cache", "huntctl", "codex-home", safeDockerName(path.basename(runDir)));
}

async function prepareWritableCodexHome(source: string, target: string): Promise<void> {
  if (!existsSync(target)) {
    await mkdir(target, { recursive: true });
    if (existsSync(source)) {
      await copyCodexEntryIfExists(source, target, "config.toml");
      await copyCodexEntryIfExists(source, target, "AGENTS.md");
      await copyCodexEntryIfExists(source, target, "rules");
    }
  }
  if (existsSync(source)) {
    await refreshCodexAuthEntries(source, target);
  }
  await assertWritableDirectory(target);
  await ensureTokenSaverProfile(target);
  await ensureTokenSaverInstructions(target);
  await ensureArtifactInstructions(target);
  await ensureWorkspacePruneInstructions(target);
}

async function assertWritableDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const probe = path.join(target, `.huntctl-write-test-${process.pid}`);
  await writeFile(probe, "ok", "utf8");
  await rm(probe, { force: true });
}

function isPermissionError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
  return code === "EACCES" || code === "EPERM" || String(error).toLowerCase().includes("permission denied");
}

async function copyCodexEntryIfExists(sourceRoot: string, targetRoot: string, entry: string): Promise<void> {
  const source = path.join(sourceRoot, entry);
  if (!existsSync(source)) return;
  const target = path.join(targetRoot, entry);
  try {
    await copyFile(source, target);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
    if (code !== "EISDIR") throw error;
    await cp(source, target, {
      recursive: true,
      errorOnExist: false,
      force: true
    });
  }
}

async function refreshCodexAuthEntries(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const entry of ["auth.json", "version.json", "installation_id"]) {
    await copyCodexEntryIfExists(sourceRoot, targetRoot, entry);
  }
}

async function ensureTokenSaverProfile(codexHome: string): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");
  let current = "";
  try {
    current = await readFile(configPath, "utf8");
  } catch {
    current = "";
  }
  if (current.includes(`[profiles.${CODEX_TOKEN_SAVER_PROFILE}]`)) return;
  const spacer = current.trim() ? "\n\n" : "";
  const profile = [
    `[profiles.${CODEX_TOKEN_SAVER_PROFILE}]`,
    'web_search = "disabled"',
    `tool_output_token_limit = ${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`,
    'attribution = ""',
    "",
    `[profiles.${CODEX_TOKEN_SAVER_PROFILE}.features]`,
    "apps = false",
    ""
  ].join("\n");
  await writeFile(configPath, `${current}${spacer}${profile}`, "utf8");
}

async function ensureTokenSaverInstructions(codexHome: string): Promise<void> {
  const agentsPath = path.join(codexHome, "AGENTS.md");
  let current = "";
  try {
    current = await readFile(agentsPath, "utf8");
  } catch {
    current = "";
  }
  if (current.includes("huntctl token saver")) return;
  const spacer = current.trim() ? "\n\n" : "";
  const block = [
    "## huntctl token saver",
    "",
    "- 큰 비대화형 명령 출력은 `distill`이 사용 가능하고 설정되어 있으면 원문이 반드시 필요한 경우를 제외하고 먼저 압축하세요.",
    "- 예: `npm test 2>&1 | distill \"테스트 통과 여부와 실패한 테스트명만 한국어로 요약\"`",
    "- `distill` 설정이 없거나 실패하면 필요한 줄만 `tail`, `rg`, `jq` 등으로 줄여서 확인하세요.",
    "- exact raw output, 대화형/TUI, 비밀번호 prompt가 필요한 명령에는 `distill`을 끼우지 마세요.",
    ""
  ].join("\n");
  await writeFile(agentsPath, `${current}${spacer}${block}`, "utf8");
}

async function ensureArtifactInstructions(codexHome: string): Promise<void> {
  const agentsPath = path.join(codexHome, "AGENTS.md");
  let current = "";
  try {
    current = await readFile(agentsPath, "utf8");
  } catch {
    current = "";
  }
  if (current.includes("huntctl artifacts")) return;
  const spacer = current.trim() ? "\n\n" : "";
  const block = [
    "## huntctl artifacts",
    "",
    "- 성공 산출물은 반드시 `HUNTCTL_ARTIFACTS` 아래에 저장하세요. Docker에서는 이 경로가 host run 디렉터리로 mount됩니다.",
    "- 여러 worker가 공유해야 하는 PoC, exploit, request/response, screenshot, writeup은 `HUNTCTL_EVIDENCE_DIR` 아래에 저장하세요.",
    "- 최종 응답에는 생성한 파일의 정확한 경로를 `Artifacts` 섹션으로 나열하세요.",
    ""
  ].join("\n");
  await writeFile(agentsPath, `${current}${spacer}${block}`, "utf8");
}

async function ensureWorkspacePruneInstructions(codexHome: string): Promise<void> {
  const agentsPath = path.join(codexHome, "AGENTS.md");
  let current = "";
  try {
    current = await readFile(agentsPath, "utf8");
  } catch {
    current = "";
  }
  if (current.includes("huntctl workspace pruning")) return;
  const spacer = current.trim() ? "\n\n" : "";
  const block = [
    "## huntctl workspace pruning",
    "",
    "- 토큰 절약을 위해 `.huntctl/runs/**/codex-home*`, `.huntctl/runs/**/docker-runtime`, `.huntctl/runs/**/codex.jsonl`, `.tmp/plugins`, `node_modules`, `.git`는 전체 탐색하지 마세요.",
    "- `.huntctl`를 확인할 때는 현재 run의 `state.json`, `runbook.yml`, `tasks/*/artifacts`, `.huntctl/evidence`처럼 필요한 경로만 좁혀서 읽으세요.",
    "- 큰 로그나 JSONL은 전체 `cat` 대신 `tail`, `jq`, `rg --glob` 제외 규칙, `find ... -prune`으로 필요한 줄만 확인하세요.",
    ""
  ].join("\n");
  await writeFile(agentsPath, `${current}${spacer}${block}`, "utf8");
}

async function exportTaskMetadata(params: {
  artifactPath: string;
  evidencePath: string;
  outputLastMessage: string;
  promptPath: string;
  stderrPath: string;
  options: CodexRunOptions;
  usedSandbox: ExecutionSandbox;
  exitCode: number | null;
}): Promise<void> {
  await copyIfPresent(params.outputLastMessage, path.join(params.artifactPath, "final.md"));
  await copyIfPresent(params.promptPath, path.join(params.artifactPath, "prompt.md"));
  await copyIfPresent(params.stderrPath, path.join(params.artifactPath, "stderr.log"));
  await writeFile(
    path.join(params.artifactPath, "manifest.json"),
    `${JSON.stringify(
      {
        runId: params.options.runId,
        taskId: params.options.taskId,
        agentId: params.options.agent.id,
        role: params.options.agent.role,
        profile: params.options.runbook.profile,
        exitCode: params.exitCode,
        usedSandbox: params.usedSandbox,
        artifactDir: params.artifactPath,
        evidenceDir: params.evidencePath,
        exportedAt: nowIso()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  if (!existsSync(source)) return;
  try {
    await copyFile(source, target);
  } catch {
    // Artifact metadata should not fail the worker result.
  }
}

function resolveHostEvidenceDir(workspace: string, evidenceDir: string): string {
  return path.isAbsolute(evidenceDir) ? evidenceDir : path.resolve(workspace, evidenceDir);
}

function codexEnvironment(codexHome?: string, artifactPath?: string, evidencePath?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    ...(artifactPath ? { HUNTCTL_ARTIFACTS: artifactPath, HUNTCTL_TASK_ARTIFACTS: artifactPath } : {}),
    ...(evidencePath ? { HUNTCTL_EVIDENCE_DIR: evidencePath } : {})
  };
}

function dockerImageForRunbook(runbook: Runbook): string {
  const image = runbook.sandbox.image?.trim();
  if (!image) {
    throw new Error("Docker sandbox requires sandbox.image or --image <image>.");
  }
  return image;
}

async function handleCodexLine(options: CodexRunOptions, line: string): Promise<void> {
  let data: unknown = line;
  let message: string | undefined;
  try {
    data = JSON.parse(line) as unknown;
    message = extractCodexMessage(data);
  } catch {
    message = truncate(line, 300);
  }

  const event: HuntEvent = {
    time: nowIso(),
    runId: options.runId,
    type: "codex.event",
    source: "worker",
    agentId: options.agent.id,
    taskId: options.taskId,
    message,
    data: sanitizeCodexEventData(data)
  };
  await appendEvent(options.runDir, event);
}

function codexStartMessage(command: string, options: CodexRunOptions, usedSandbox: ExecutionSandbox): string {
  const access = usedSandbox === "docker" ? "docker/full-access" : "host/full-access";
  const runner = command === "docker" ? "docker run codex exec" : "codex exec";
  return `${runner} ${access} agent=${options.agent.id} effort=${reasoningEffortForAgent(options.agent)} task=${options.taskId} prompt=<saved:${path.join("tasks", options.taskId, "prompt.md")}>`;
}

function sanitizeCodexEventData(data: unknown): unknown {
  if (!data || typeof data !== "object") return typeof data === "string" ? truncate(data, CODEX_EVENT_TEXT_LIMIT) : data;
  const record = data as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const item = objectRecord(record.item);

  if (type === "turn.completed") {
    return {
      type,
      usage: sanitizeUsage(record.usage)
    };
  }

  if (item) {
    return {
      type,
      item: sanitizeCodexItem(item)
    };
  }

  if (type === "thread.started") {
    return {
      type,
      thread_id: typeof record.thread_id === "string" ? record.thread_id : undefined
    };
  }

  return {
    type,
    message: typeof record.message === "string" ? truncate(record.message, CODEX_EVENT_TEXT_LIMIT) : undefined
  };
}

function sanitizeCodexItem(item: Record<string, unknown>): Record<string, unknown> {
  const type = typeof item.type === "string" ? item.type : undefined;
  const base: Record<string, unknown> = {
    id: typeof item.id === "string" ? item.id : undefined,
    type
  };
  if (type === "command_execution") {
    return {
      ...base,
      command: typeof item.command === "string" ? truncate(item.command, 700) : undefined,
      status: typeof item.status === "string" ? item.status : undefined,
      exit_code: typeof item.exit_code === "number" ? item.exit_code : undefined,
      aggregated_output: typeof item.aggregated_output === "string" ? compactLargeText(item.aggregated_output, CODEX_EVENT_TEXT_LIMIT) : undefined
    };
  }
  if (type === "agent_message") {
    return {
      ...base,
      text: typeof item.text === "string" ? compactLargeText(item.text, 1600) : undefined
    };
  }
  return base;
}

function sanitizeUsage(value: unknown): Record<string, number> | undefined {
  const usage = objectRecord(value);
  if (!usage) return undefined;
  const next: Record<string, number> = {};
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]) {
    if (typeof usage[key] === "number") next[key] = usage[key];
  }
  return next;
}

function compactLargeText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const headSize = Math.floor(limit * 0.62);
  const tailSize = Math.max(80, limit - headSize - 80);
  const omitted = value.length - headSize - tailSize;
  return `${value.slice(0, headSize)}\n... [huntctl truncated ${omitted} chars; full output is in task codex.jsonl/stderr/artifacts] ...\n${value.slice(-tailSize)}`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function extractCodexMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.message,
    record.text,
    record.delta,
    record.type,
    typeof record.event === "string" ? record.event : undefined
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
  return typeof value === "string" ? truncate(value, 300) : undefined;
}
