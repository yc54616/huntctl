import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { appendEvent, readState, summaryPath, updateState } from "./store.js";
import type { Runbook } from "./types.js";
import { commandExists, nowIso, shellQuote } from "./utils.js";
import { CODEX_TOKEN_SAVER_PROFILE, CODEX_TOOL_OUTPUT_TOKEN_LIMIT, prepareRunCodexHome } from "./codex.js";

const execFileAsync = promisify(execFile);

export interface NativeLaunchOptions {
  runDir: string;
  runbook: Runbook;
  attach: boolean;
  resume?: boolean;
  reuseExisting?: boolean;
}

export async function launchNativeAdvisor(options: NativeLaunchOptions): Promise<{ sessionName: string }> {
  if (!(await commandExists("tmux"))) {
    throw new Error("tmux is required for native advisor mode. Install tmux or run without --native.");
  }
  if (!(await commandExists("codex"))) {
    throw new Error("codex is required for native advisor mode.");
  }

  const state = await readState(options.runDir);
  const sessionName = tmuxSessionName(state.runId);
  if (options.reuseExisting && (await tmuxSessionExists(sessionName))) {
    await ensureThreePaneLayout(sessionName, state.runId, state.workspace);
    await appendEvent(options.runDir, {
      time: nowIso(),
      runId: state.runId,
      type: "native.attached",
      source: "orchestrator",
      agentId: "advisor",
      message: `tmux session ${sessionName}`
    });
    if (options.attach) {
      await attachTmux(sessionName);
    }
    return { sessionName };
  }

  const nativeDir = path.join(options.runDir, "native");
  await mkdir(nativeDir, { recursive: true });
  const codexHome = await prepareRunCodexHome(options.runDir);

  const promptPath = path.join(nativeDir, "advisor-prompt.md");
  const advisorScriptPath = path.join(nativeDir, "advisor.sh");
  const statusScriptPath = path.join(nativeDir, "status.sh");
  const workersScriptPath = path.join(nativeDir, "workers.sh");
  await writeFile(promptPath, buildNativeAdvisorPrompt(options.runbook, state.runId), "utf8");
  await writeFile(
    advisorScriptPath,
    advisorScript(state.workspace, promptPath, {
      danger: Boolean(options.runbook.danger),
      codexHome,
      resume: Boolean(options.resume)
    }),
    { mode: 0o755 }
  );
  await writeFile(statusScriptPath, statusScript(state.runId), { mode: 0o755 });
  await writeFile(workersScriptPath, workersScript(state.runId), { mode: 0o755 });

  await killExistingSession(sessionName);
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-n", "huntctl", "-c", state.workspace, advisorScriptPath]);
  await execFileAsync("tmux", ["split-window", "-h", "-l", "42%", "-t", `${sessionName}:0.0`, "-c", state.workspace, statusScriptPath]);
  await execFileAsync("tmux", ["split-window", "-v", "-l", "45%", "-t", `${sessionName}:0.1`, "-c", state.workspace, workersScriptPath]);
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.0`, "-T", "advisor"]);
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.1`, "-T", "summary"]);
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.2`, "-T", "workers"]);
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.0`]);
  await execFileAsync("tmux", ["select-window", "-t", `${sessionName}:0`]);

  await updateState(options.runDir, (next) => {
    next.advisor.status = "running";
    if (next.agents.advisor) {
      next.agents.advisor.status = "running";
      next.agents.advisor.lastMessage = "Native Codex TUI advisor is active in tmux.";
    }
    next.advisor.lastResponse = [
      `Native advisor is running in tmux session ${sessionName}.`,
      options.runbook.danger ? "Danger mode is enabled for Codex advisor/workers." : "Danger mode is disabled."
    ].join(" ");
    next.advisor.lastSummary = next.advisor.lastResponse;
    next.autoActions.push(`native advisor tmux session started: ${sessionName}`);
  });
  await writeFile(summaryPath(options.runDir), `Native advisor is running in tmux session ${sessionName}.\n`, "utf8");
  await appendEvent(options.runDir, {
    time: nowIso(),
    runId: state.runId,
    type: "native.started",
    source: "orchestrator",
    agentId: "advisor",
    message: `tmux session ${sessionName}`
  });

  if (options.attach) {
    await attachTmux(sessionName);
  }
  return { sessionName };
}

async function attachTmux(sessionName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tmux", ["attach-session", "-t", sessionName], {
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        reject(new Error(`tmux attach exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function tmuxSessionName(runId: string): string {
  return `huntctl-${runId}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
}

async function killExistingSession(sessionName: string): Promise<void> {
  try {
    if (!(await tmuxSessionExists(sessionName))) return;
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
  } catch {
    // No existing session.
  }
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function ensureThreePaneLayout(sessionName: string, runId: string, workspace: string): Promise<void> {
  if (await tmuxWindowExists(sessionName, "workers")) {
    await execFileAsync("tmux", ["kill-window", "-t", `${sessionName}:workers`]);
  }
  const paneCount = await tmuxPaneCount(sessionName);
  if (paneCount < 2) {
    await execFileAsync("tmux", ["split-window", "-h", "-l", "42%", "-t", `${sessionName}:0.0`, "-c", workspace, statusScript(runId)]);
  }
  if ((await tmuxPaneCount(sessionName)) < 3) {
    await execFileAsync("tmux", ["split-window", "-v", "-l", "45%", "-t", `${sessionName}:0.1`, "-c", workspace, workersScript(runId)]);
  }
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.0`, "-T", "advisor"]);
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.1`, "-T", "summary"]);
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.2`, "-T", "workers"]);
  await execFileAsync("tmux", ["select-window", "-t", `${sessionName}:0`]);
  await execFileAsync("tmux", ["select-pane", "-t", `${sessionName}:0.0`]);
}

async function tmuxWindowExists(sessionName: string, windowName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-windows", "-t", sessionName, "-F", "#{window_name}"]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(windowName);
  } catch {
    return false;
  }
}

async function tmuxPaneCount(sessionName: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", `${sessionName}:0`, "-F", "#{pane_id}"]);
    return stdout.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function advisorScript(
  workspace: string,
  promptPath: string,
  options: {
    danger: boolean;
    codexHome?: string;
    resume: boolean;
  }
): string {
  const commonArgs = [
    "--cd",
    shellQuote(workspace),
    "--profile",
    CODEX_TOKEN_SAVER_PROFILE,
    "--disable",
    "apps",
    "-c",
    shellQuote("features.apps=false"),
    "-c",
    shellQuote('web_search="disabled"'),
    "-c",
    shellQuote(`tool_output_token_limit=${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`),
    "-c",
    shellQuote('model_reasoning_effort="low"'),
    "-c",
    shellQuote('attribution=""')
  ];
  commonArgs.push("--dangerously-bypass-approvals-and-sandbox");

  const resumeCommand = ["codex", "resume", "--last", "--all", ...commonArgs].join(" ");
  const freshCommand = ["codex", ...commonArgs, '"$(cat "$PROMPT_PATH")"'].join(" ");
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export PROMPT_PATH=${shellQuote(promptPath)}`,
    ...(options.codexHome ? [`export CODEX_HOME=${shellQuote(options.codexHome)}`] : []),
    "clear",
    'printf "huntctl native advisor (왼쪽: 실제 Codex 대화창)\\n"',
    'printf "workspace: %s\\n" "$PWD"',
    'printf "advisor host commands: 켜짐\\n"',
    'printf "worker full-access: 켜짐\\n"',
    options.resume ? 'printf "resume: 이전 Codex advisor 세션 복구 시도\\n\\n"' : 'printf "resume: 새 Codex advisor 세션\\n\\n"',
    ...(options.resume
      ? [
          `${resumeCommand} && exit 0`,
          'printf "\\n이 run의 이전 Codex 세션을 찾지 못해 새 advisor 세션을 시작합니다.\\n\\n"'
        ]
      : []),
    freshCommand,
    'printf "\\nCodex advisor exited. Press Enter to close this pane.\\n"',
    "read -r _ || true"
  ].join("\n");
}

function statusScript(runId: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `huntctl native-status ${shellQuote(runId)}`
  ].join("\n");
}

function workersScript(runId: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `huntctl native-workers ${shellQuote(runId)}`
  ].join("\n");
}

function buildNativeAdvisorPrompt(runbook: Runbook, runId: string): string {
  const workerList = runbook.agents
    .filter((agent) => agent.id !== "advisor" && agent.role !== "advisor")
    .map((agent) => `- ${agent.id}: ${agent.role}`)
    .join("\n");
  const context =
    runbook.profile === "ctf"
      ? JSON.stringify({ profile: runbook.profile, challenge: runbook.challenge, limits: runbook.limits }, null, 2)
      : JSON.stringify({ profile: runbook.profile, target: runbook.target, program: runbook.program, limits: runbook.limits }, null, 2);

  return [
    "당신은 실제 Codex CLI 안에서 실행되는 huntctl advisor입니다.",
    "사용자와는 항상 한국어로 자연스럽게 대화하세요.",
    "명령 출력이나 worker 결과를 요약할 때도 기본 언어는 한국어입니다.",
    "",
    `Run ID: ${runId}`,
    `Danger mode: ${runbook.danger ? "enabled" : "disabled"}`,
    "Native advisor host command access: enabled",
    "",
    "화면 구성:",
    "- 왼쪽: 지금 이 실제 Codex advisor TUI. 사용자는 여기서 당신과 대화합니다.",
    "- 오른쪽 위: 사용자가 읽는 요약. 현재 무엇을 하는지, advisor 판단, 다음 흐름만 짧게 보여줍니다.",
    "- 오른쪽 아래: worker 요약. 명령어 원문이 아니라 각 worker의 의도와 결과를 보여줍니다.",
    "- 백그라운드 coordinator loop는 사용자가 멈추기 전까지 idle worker에 다음 작업을 계속 채웁니다.",
    "",
    "Worker pool:",
    workerList || "- no workers configured",
    "",
    "worker나 상태 변경이 필요할 때 사용할 명령:",
    `- huntctl status ${runId}`,
    `- huntctl scope add <in-scope-url...> --run-id ${runId}`,
    `- huntctl scope exclude <out-of-scope-url...> --run-id ${runId}`,
    `- huntctl assign <worker-id> "<task>" --run-id ${runId}`,
    `- huntctl logs <worker-id> --run-id ${runId}`,
    `- huntctl summary ${runId}`,
    `- huntctl stop <worker-id> --run-id ${runId}`,
    "",
    "운영 규칙:",
    "- target, 목표, authorization/scope는 판단 context로 쓰되 worker 배정을 막는 조건으로 쓰지 마세요.",
    "- 사용자가 scope/out-of-scope를 알려주면 huntctl scope add/exclude로 상태에 반영할 수 있지만, 이것은 표시/보고용 context입니다.",
    "- bug bounty에서는 사용자가 말한 authorization, scope, program rules, rate limit, test-account 경계를 보고서와 증거 context로 기록하세요.",
    "- CTF에서는 로컬 문제 파일과 문제에서 제공한 서비스에 집중하세요.",
    "- CTF는 정답/flag가 있으므로 같은 표면에서 신호가 없으면 1-2회 시도 후 다른 파일, 기법, 입력, 취약점 class로 바로 전환하세요.",
    "- 버그바운티에서는 VRT/weakness 전체를 골고루 커버하세요. 쉬운 header/CORS/redirect/public metadata 후보만 반복하지 말고 P1/P2/P3/P4 priority를 모두 coverage ledger에 포함하세요. SQLi/NoSQLi, server-side injection, XSS, SSRF, auth bypass/account takeover, IDOR/BOLA/BFLA, path traversal/XXE/deserialization, cloud secret exposure, business logic 같은 reportable 가능 class에는 명시적으로 worker cycle을 배정하세요.",
    "- 버그바운티에서 APK/AAB/DEX/JAR가 제공되면 웹만 보지 말고 Android mobile lane을 배정하세요. apktool/jadx/aapt 정적 분석 후 가능하면 Docker sandbox에서 android-emulator-headless, android-wait-for-boot, adb install, logcat, deep link 실행, safe traffic/proxy evidence까지 시도하게 하세요.",
    "- 될 것 같은 high-impact lead가 나오면 sweep을 멈추고 바로 depth mode로 전환하세요. 최소 재현 PoC, request/response, attacker capability, concrete impact, evidence path, report-ready/keep/reject 판단까지 밀어붙이세요.",
    "- worker에게 VRT coverage ledger를 갱신하게 하세요. 형식은 category/lane, asset/endpoint, evidence path, status, next category 정도면 충분합니다.",
    "- 버그바운티는 한 고신호 candidate를 깊게 검증하되, 같은 lane에서 새 증거/capability가 2회 연속 늘지 않으면 candidate ledger에 blocked/reject/pivot-adjacent/rotate-lane 사유를 남기고 인접 lane으로 전환하세요.",
    "- CTF worker 결과는 `Decision: solved | continue | pivot | blocked` 중 하나로 끝나게 하세요.",
    "- 버그바운티 worker 결과는 `Decision: report-ready | keep | blocked | reject | pivot-adjacent | rotate-lane` 중 하나로 끝나게 하세요.",
    "- blocked/reject candidate는 새 사용자 입력, 새 권한, 새 세션/계정/canary, 새 evidence가 blocker를 제거하지 않는 한 다시 배정하지 마세요.",
    "- 사용자에게 현재 판단, 다음 액션, worker 배정 이유를 한국어로 짧게 알려주세요.",
    "- scope나 파일이 부족해도 기존 workspace/run state를 읽는 worker 작업이나 누락 입력 체크리스트 작업을 배정하세요.",
    "- 기본 구조는 advisor + worker-N입니다. worker 역할명을 사용자에게 복잡하게 설명하지 말고, worker별 target/domain focus와 취약점 lane만 명확히 나눠 주세요.",
    "- 진행할 수 있는 작업이 있으면 huntctl assign을 직접 실행해 worker를 조율하세요. 명령 예시만 보여주고 멈추지 마세요.",
    "- worker가 이미 running/queued면 같은 worker에 새 작업을 쌓지 마세요. idle worker에게만 다음 방향을 주세요.",
    "- 오른쪽 summary/workers를 보고 다음 작업이 명확하면, 사용자에게 명령을 복사하라고 하지 말고 직접 배정하세요.",
    "- huntctl 명령이 실패하면 추측하지 말고, 실제 stderr와 오른쪽 상태 패널의 원인을 기준으로 설명하세요.",
    "- 자동 coordinator가 이미 처리한 작업을 반복하지 말고, status/events를 확인한 뒤 새 가설이나 다음 단계로 이어가세요.",
    "- 버그바운티에서 가장 중요한 기준은 공격자가 무엇을 할 수 있는지입니다. attacker capability, 영향, 재현 절차, PoC 코드/HTTP 요청, 증거 경로가 없으면 finding으로 단정하지 마세요.",
    "- 버그바운티 worker에게는 target/domain focus, candidate id, lane, normalized status, 새 evidence, missing proof, next decision을 계속 갱신하게 하세요.",
    "- worker가 report-ready라고 해도 바로 최종 보고서로 확정하지 말고, advisor가 마지막으로 scope, 공격자 악용 가능성, concrete impact, 재현성, PoC 코드/HTTP 요청, 증거 경로, taxonomy/severity를 검토하세요. 부족하면 해당 증거만 보강하도록 worker에게 다시 배정하세요.",
    "- report-ready가 없으면 제출용 보고서를 쓰지 말고 candidate ledger, evidence map, dashboard summary, missing-input checklist만 갱신하게 하세요.",
    "- worker에게는 단순 관찰보다 재현 가능한 증거와 보고 가능성을 확인하는 작업을 우선 배정하세요.",
    "- Docker worker는 컨테이너 안에서 full-access로 재현/PoC를 실행합니다. 산출물은 HUNTCTL_ARTIFACTS와 HUNTCTL_EVIDENCE_DIR에 저장하게 하세요.",
    "- 성공 산출물은 host에 남아야 합니다. worker에게 PoC, exploit, request/response, screenshot, writeup 파일 경로를 최종 응답에 적게 하세요.",
    "- CTF에서 flag를 찾으면 최종 산출물은 반드시 Flag, Exploit Code, Writeup, Reproduction으로 정리하세요.",
    "- HackerOne 보고서는 Asset, Weakness, Severity, Description, Impact, Attachments 필드에 맞춰 정리하세요.",
    "- HackerOne Description에는 Summary, 테스트 계정/IP, Steps to Reproduce, Burp request/response, 추가 자료를 넣으세요.",
    "- Bugcrowd 보고서는 Summary title, Target, Technical severity, VRT Category, Vulnerability details, Attachments, Confirmation 기준으로 정리하세요.",
    "- Bugcrowd Technical severity/VRT Category는 설정된 vulnerability-rating-taxonomy.json을 우선 사용하세요.",
    "- bug bounty 산출물에는 보고서 초안, PoC 코드/HTTP 요청, 증거 파일/스크린샷/영상 경로, 영향도, 재현 단계를 포함하세요.",
    "- 사용자가 다른 보고서 형식을 주면 그 형식을 우선하고, 부족하면 어떤 필드가 필요한지 한국어로 물어보세요.",
    "",
    "Current context:",
    context,
    "",
    "시작할 때는 한국어로 짧게 준비됐다고 말하고, 사용자가 무엇을 헌팅할지 물어보세요."
  ].join("\n");
}
