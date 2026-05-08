import { readFile } from "node:fs/promises";
import path from "node:path";
import { readEvents, readState, summaryPath } from "./store.js";
import { escapeHtml, pathExists, truncate } from "./utils.js";
import { getDockerSummary } from "./docker.js";
import { loadRunbook } from "./runbook.js";
import type { HuntEvent } from "./types.js";

export async function renderStatus(runDir: string): Promise<string> {
  const state = await readState(runDir);
  const runbook = await loadRunbook(path.join(runDir, "runbook.yml"));
  const coordinator = coordinatorStatus(state);
  const agents = Object.values(state.agents)
    .map((agent) => {
      const status = agent.id === "advisor" ? state.advisor.status : agent.status;
      return `${agent.id.padEnd(16)} ${status.padEnd(10)} ${agent.role.padEnd(16)} ${agent.lastMessage ? truncate(agent.lastMessage, 90) : ""}`;
    })
    .join("\n");
  return [
    `RUN        ${state.runId}`,
    `PROFILE    ${state.profile}`,
    `STATUS     ${state.status}`,
    `SANDBOX    ${state.sandboxMode}`,
    runbook.sandbox.image ? `IMAGE      ${runbook.sandbox.image}` : "",
    `DANGER     ${state.danger ? "enabled" : "disabled"}`,
    `WORKER     ${workerAccessSummary(state.sandboxMode, state.danger, state.profile)}`,
    `DOCKER     ${await dockerLine(runbook)}`,
    `COORD      ${coordinator.text}`,
    `UPDATED    ${state.updatedAt}`,
    "",
    "AGENTS",
    agents || "(none)",
    "",
    `ADVISOR   ${state.advisor.lastResponse ? truncate(state.advisor.lastResponse, 600) : "No advisor response yet."}`,
    visibleErrors(state).length ? `\nERRORS\n${visibleErrors(state).slice(-5).join("\n")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export async function renderNativeStatus(runDir: string, dockerMessage?: string): Promise<string> {
  const width = nativeWidth();
  const state = await readState(runDir);
  const events = await readEvents(runDir, 2000);
  const runbook = await loadRunbook(path.join(runDir, "runbook.yml"));
  const coordinator = coordinatorStatus(state);
  const errors = visibleErrors(state);
  const tokens = tokenUsageSummary(events);
  const authIssue = hasCodexAuthFailure(errors);
  const image = runbook.sandbox.image ? `image=${runbook.sandbox.image}` : "image=host";
  const dockerStatus = dockerMessage ?? (await dockerLine(runbook));
  const runningTasks = Object.values(state.tasks).filter((task) => ["starting", "running"].includes(task.status)).length;
  const queuedTasks = Object.values(state.tasks).filter((task) => task.status === "queued").length;
  const completedTasks = Object.values(state.tasks).filter((task) => task.status === "done").length;
  const focus = runbook.profile === "bug-bounty" ? bugBountyFocus(runbook) : ctfFocus(runbook);
  const header = `${strong("요약")} ${profileKo(state.profile)} ${statusBadge(state.status)}`;
  const timing = `경과 ${elapsedMinutes(state.createdAt)} / 시작 ${clockTime(state.createdAt)} / 상태 갱신 ${clockTime(state.updatedAt)}`;

  return [
    header,
    rule(width),
    section("지금"),
    kv("대상", focus, width),
    kv("시간", timing, width),
    kv("진행", `${coordinator.alive ? "자동 진행 중" : "자동 루프 멈춤"} / 실행 ${runningTasks} / 대기 ${queuedTasks} / 완료 ${completedTasks}`, width),
    kv("환경", `${state.sandboxMode} full-access / ${image}`, width),
    kv("토큰", formatTokenUsage(tokens), width),
    "",
    section("worker 현황"),
    ...workerSnapshotLines(state, events, width),
    "",
    section("후보 판정"),
    ...candidateSnapshotLines(state, width),
    "",
    section("advisor 판단"),
    paragraph(authIssue ? "Codex 인증 실패가 감지됐습니다. worker가 일을 계속하려면 `codex login` 또는 `~/.codex` 인증 복구가 필요합니다." : humanAdvisorSummary(state.advisor.lastResponse), width),
    "",
    section("다음 흐름"),
    paragraph(authIssue ? "인증이 복구되면 `huntctl loop` 또는 `huntctl resume`으로 같은 run을 이어가면 됩니다." : nextNativeAction(runbook, state, coordinator.alive, dockerStatus), width),
    "",
    section("산출물"),
    paragraph(resolveEvidencePreview(state.workspace, runbook.evidence_dir), width),
    authIssue
      ? `\n${section("오류")}\n${paragraph("Codex API 401 Unauthorized. Codex CLI 인증을 복구해야 worker가 다시 실행됩니다.", width)}`
      : errors.length
        ? `\n${section("오류")}\n${errors.slice(-3).flatMap((error) => bulletWrap(truncate(oneLine(error), 180), width, "red")).join("\n")}`
        : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export async function renderNativeWorkers(runDir: string, limitPerWorker = 5): Promise<string> {
  const width = nativeWidth();
  const state = await readState(runDir);
  const events = await readEvents(runDir, 1600);
  const workers = Object.values(state.agents).filter((agent) => agent.id !== "advisor" && agent.role !== "advisor");
  const lines = [
    `${strong("workers")} ${dim("현재 하는 일")}`,
    rule(width),
    ...wrapText("명령어 원문이 아니라 worker가 왜 그 작업을 하는지와 결과만 보여줍니다.", width).map(dim)
  ];

  for (const worker of workers) {
    const task = worker.currentTaskId ? state.tasks[worker.currentTaskId] : undefined;
    const taskSummary = task ? summarizeTaskPrompt(task.prompt, task.reason, worker.role) : "다음 작업 대기 중";
    const recent = events
      .filter((event) => event.agentId === worker.id)
      .flatMap((event) => renderWorkerFeedEvent(event))
      .slice(-limitPerWorker);
    lines.push("", `${strong(worker.id)} ${statusBadge(worker.status)} ${dim(workerRoleKo(worker.role))}`);
    lines.push(`${dim("토큰")} ${formatTokenUsage(tokenUsageSummary(events, worker.id))}`);
    lines.push(...wrapText(taskSummary, width).map((line, index) => (index === 0 ? `${color("cyan", "목표")} ${line}` : `   ${line}`)));
    if (recent.length) {
      lines.push(...recent);
    } else {
      lines.push(dim("최근 작업 요약 없음"));
    }
  }

  return lines.join("\n");
}

export async function renderNativeEvents(runDir: string, limit = 30): Promise<string> {
  const width = nativeWidth();
  const events = await readEvents(runDir, limit);
  const lines = [
    `${strong("huntctl events")} ${dim("작업 진행 로그")}`,
    rule(width),
    ...wrapText("지금 무엇을 시작/분석/완료/차단했는지 시간순으로 요약합니다.", width).map(dim),
    ""
  ];
  let visible = 0;
  for (const event of events) {
    const rendered = renderProgressEvent(event);
    if (rendered.length) {
      visible += 1;
      lines.push(...rendered);
    }
  }
  if (visible === 0) lines.push("아직 표시할 worker 진행 로그가 없습니다.");
  return lines.join("\n");
}

export async function renderWorkerFeed(runDir: string, agentId: string, limit = 80): Promise<string> {
  const width = nativeWidth();
  const state = await readState(runDir);
  const agent = state.agents[agentId];
  const events = await readEvents(runDir, 1200);
  const rendered = events
    .filter((event) => event.agentId === agentId)
    .flatMap((event) => renderWorkerFeedEvent(event))
    .slice(-limit);
  const title = `${strong(agentId)} ${agent ? statusBadge(agent.status) : ""} ${dim(agent?.role ?? "worker")} ${dim("작업 요약")}`;
  return [
    title,
    rule(width),
    ...wrapText("worker가 지금 무엇을 확인하는지 agent 관점의 의도와 결과만 요약합니다.", width).map(dim),
    "",
    rendered.length ? rendered.join("\n") : "아직 표시할 command 실행 로그가 없습니다."
  ].join("\n");
}

function renderWorkerFeedEvent(event: HuntEvent): string[] {
  if (event.type === "codex.started") {
    const data = objectRecord(event.data);
    const sandbox = typeof data?.usedSandbox === "string" ? data.usedSandbox : "unknown";
    const access = typeof data?.codexAccess === "string" ? data.codexAccess : "";
    return [workerFeedLine(event, "작업 시작", `${sandbox}${access ? ` / ${access}` : ""} / task=${shortTaskId(event.taskId)}`)];
  }
  if (event.type === "task.done") {
    return [workerFeedLine(event, "작업 완료", event.message ? truncate(oneLine(event.message), 220) : `task=${shortTaskId(event.taskId)}`)];
  }
  if (event.type === "task.failed") {
    return [workerFeedLine(event, "작업 실패", event.message ? truncate(oneLine(event.message), 220) : `task=${shortTaskId(event.taskId)}`)];
  }
  if (event.type !== "codex.event") return [];

  const data = objectRecord(event.data);
  const type = typeof data?.type === "string" ? data.type : undefined;
  if (type === "turn.completed") {
    return [workerFeedLine(event, "토큰 사용", formatTokenUsage(tokenUsageFromUsage(data?.usage)))];
  }
  const item = objectRecord(data?.item);
  if (!item || item.type !== "command_execution") return [];

  if (type === "item.started") {
    const command = commandText(item, event.message);
    return [workerFeedLine(event, "작업 의도", summarizeCommand(command))];
  }
  if (type === "item.completed") {
    const command = commandText(item, undefined);
    const status = typeof item.status === "string" ? item.status : "completed";
    const exitCode = typeof item.exit_code === "number" ? ` exit=${item.exit_code}` : "";
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : typeof item.text === "string" ? item.text : "";
    const detail = [summarizeCommand(command), summarizeCommandOutput(output)].filter(Boolean).join(" / ");
    return [workerFeedLine(event, `작업 결과 ${status}${exitCode}`, detail || `task=${shortTaskId(event.taskId)}`)];
  }
  return [];
}

function summarizeTaskPrompt(prompt: string, reason?: string, role?: string): string {
  const text = oneLine(prompt);
  const lower = text.toLowerCase();
  void reason;
  const prefix = "";
  if (role === "recon" || role === "endpoint-mapper") {
    return `${prefix}scope/host/endpoint와 기존 evidence를 정리해 다음 검증 후보를 좁히는 중`;
  }
  if (role === "validator") {
    return `${prefix}후보가 실제 공격자 capability, impact, 재현성으로 이어지는지 검증 중`;
  }
  if (role === "report-writer" || role === "evidence") {
    return `${prefix}현재 증거를 보고서 형식으로 정리하고 제출 가능/불가 이유를 갱신 중`;
  }
  if (lower.includes("report") || lower.includes("보고서") || lower.includes("draft")) {
    return `${prefix}보고서/증거 초안을 갱신하고 제출 가능한 finding인지 정리 중`;
  }
  if (lower.includes("attacker capability") || lower.includes("impact") || lower.includes("reportable")) {
    return `${prefix}공격자가 실제로 무엇을 할 수 있는지와 영향/재현 가능성을 검증 중`;
  }
  if (lower.includes("scope") || lower.includes("host") || lower.includes("endpoint")) {
    return `${prefix}대상 scope와 endpoint를 정리하고 다음 검증 후보를 좁히는 중`;
  }
  if (lower.includes("poc") || lower.includes("request") || lower.includes("response")) {
    return `${prefix}PoC 요청/응답과 재현 증거를 정리하는 중`;
  }
  if (lower.includes("ctf") || lower.includes("flag") || lower.includes("exploit")) {
    return `${prefix}flag/exploit/writeup으로 이어지는 풀이 경로를 진행 중`;
  }
  return `${prefix}${truncate(text, 180)}`;
}

function humanAdvisorSummary(value?: string): string {
  if (!value?.trim()) return "advisor가 아직 worker 결과를 기다리는 중입니다.";
  const text = oneLine(value);
  if (text.startsWith("Native advisor is running")) {
    return "advisor가 켜져 있고 worker 결과를 계속 확인하는 중입니다.";
  }
  return truncate(text, 360);
}

function workerSnapshotLines(state: Awaited<ReturnType<typeof readState>>, events: HuntEvent[], width: number): string[] {
  const workers = Object.values(state.agents).filter((agent) => agent.id !== "advisor" && agent.role !== "advisor");
  if (!workers.length) return [dim("worker 없음")];
  const lines: string[] = [];
  for (const worker of workers) {
    const task = worker.currentTaskId ? state.tasks[worker.currentTaskId] : undefined;
    const age = task?.startedAt ? `작업 ${elapsedShort(task.startedAt)}` : "대기";
    const taskSummary = task ? summarizeTaskPrompt(task.prompt, task.reason, worker.role) : "다음 작업 대기 중";
    const latest = truncate(latestWorkerActivity(events, worker.id), 180);
    const head = `${strong(worker.id)} ${statusBadge(worker.status)} ${dim(workerRoleKo(worker.role))} ${dim(age)}`;
    lines.push(head);
    lines.push(...indentWrapped(`목표: ${taskSummary}`, width));
    lines.push(...indentWrapped(`최근: ${latest}`, width));
  }
  return lines;
}

function candidateSnapshotLines(state: Awaited<ReturnType<typeof readState>>, width: number): string[] {
  const allCandidates = Object.values(state.candidates ?? {}).filter((candidate) => candidate.id !== "candidate-ledger-current");
  if (!allCandidates.length) return [dim("아직 후보 없음")];
  const counts = countBy(allCandidates.map((candidate) => candidate.status));
  const candidates = allCandidates.sort(candidateSort).slice(0, 4);
  const lines = [
    dim(
      `report-ready ${counts["report-ready"] ?? 0} / keep ${counts.keep ?? 0} / 입력필요 ${counts.blocked ?? 0} / reject ${counts.reject ?? 0}`
    )
  ];
  for (const candidate of candidates) {
    const title = `${candidate.id} ${candidateStatusBadge(candidate.status)}${candidate.lane ? ` ${dim(candidate.lane)}` : ""}`;
    lines.push(title, ...indentWrapped(candidateOneLine(candidate), width));
  }
  return lines;
}

function candidateOneLine(candidate: Awaited<ReturnType<typeof readState>>["candidates"][string]): string {
  if (candidate.status === "report-ready") return truncate(candidate.impact || candidate.capability || "제출 가능 후보", 180);
  if (candidate.status === "blocked") return truncate(`막힘: ${candidate.missingProof || candidate.notes || "추가 입력/증거 필요"}`, 180);
  if (candidate.status === "keep") return truncate(`계속: ${candidate.capability || candidate.notes || "추가 검증 가치 있음"}`, 180);
  if (candidate.status === "pivot-adjacent" || candidate.status === "rotate-lane") {
    return truncate(`전환: ${candidate.notes || candidate.missingProof || "다른 표면으로 이동 필요"}`, 180);
  }
  return truncate(`제외: ${candidate.impact || candidate.notes || candidate.missingProof || "공격자 영향 미입증"}`, 180);
}

function candidateStatusBadge(status: string): string {
  if (status === "blocked") return badge("입력필요", "yellow");
  return statusBadge(status);
}

function candidateSort(
  left: Awaited<ReturnType<typeof readState>>["candidates"][string],
  right: Awaited<ReturnType<typeof readState>>["candidates"][string]
): number {
  const priority: Record<string, number> = {
    "report-ready": 0,
    keep: 1,
    blocked: 2,
    "pivot-adjacent": 3,
    "rotate-lane": 4,
    continue: 5,
    pivot: 6,
    reject: 7,
    solved: 0
  };
  const diff = (priority[left.status] ?? 9) - (priority[right.status] ?? 9);
  if (diff !== 0) return diff;
  return right.lastDecisionAt.localeCompare(left.lastDecisionAt);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function latestWorkerActivity(events: HuntEvent[], agentId: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.agentId !== agentId) continue;
    const summary = workerActivitySummary(event);
    if (summary) return `${clockTime(event.time)} ${summary}`;
  }
  return "최근 활동 없음";
}

function workerActivitySummary(event: HuntEvent): string | undefined {
  if (event.type === "codex.started") return "Docker/Codex worker 시작";
  if (event.type === "task.done") return `작업 완료${event.message ? `: ${truncate(oneLine(event.message), 160)}` : ""}`;
  if (event.type === "task.failed") return `작업 실패${event.message ? `: ${truncate(oneLine(event.message), 160)}` : ""}`;
  if (event.type !== "codex.event") return undefined;

  const data = objectRecord(event.data);
  const type = typeof data?.type === "string" ? data.type : event.message;
  if (type === "turn.started") return "모델이 결과를 분석하는 중";
  if (type === "turn.completed") return `모델 응답 완료: ${formatTokenUsage(tokenUsageFromUsage(data?.usage))}`;

  const item = objectRecord(data?.item);
  if (!item) return undefined;
  if (item.type === "agent_message" && typeof item.text === "string") {
    const parsed = parseMaybeJson(item.text);
    const response = typeof parsed?.response === "string" ? parsed.response : undefined;
    const summary = typeof parsed?.summary === "string" ? parsed.summary : undefined;
    return `판단: ${truncate(oneLine(response ?? summary ?? item.text), 180)}`;
  }
  if (item.type === "command_execution") {
    const command = commandText(item, event.message);
    if (type === "item.started") return `확인 중: ${summarizeCommand(command)}`;
    if (type === "item.completed") {
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : typeof item.text === "string" ? item.text : "";
      return `${summarizeCommand(command)} / ${summarizeCommandOutput(output).replace(/^결과: /, "")}`;
    }
  }
  return undefined;
}

function indentWrapped(value: string, width: number): string[] {
  return wrapText(value, Math.max(12, width - 3)).map((line) => `${color("gray", "  ")}${line}`);
}

function workerFeedLine(event: HuntEvent, title: string, detail: string): string {
  const time = dim(event.time.slice(11, 19));
  const task = dim(shortTaskId(event.taskId).padEnd(12));
  const head = `${time} ${task} ${color(workerFeedTone(title), title)}`;
  const lines = wrapText(truncate(oneLine(detail), 360), Math.max(12, nativeWidth() - 5));
  if (!lines.length) return head;
  return [head, `${color("gray", "  └─")} ${lines[0]}`, ...lines.slice(1).map((line) => `${color("gray", "     ")}${line}`)].join("\n");
}

function workerFeedTone(title: string): Tone {
  if (title.includes("실패")) return "red";
  if (title.includes("완료")) return "green";
  if (title.includes("시작")) return "yellow";
  return "cyan";
}

function commandText(item: Record<string, unknown>, fallback?: string): string {
  return typeof item.command === "string" ? item.command : fallback ? fallback : "";
}

function summarizeCommand(command: string): string {
  const value = cleanShellCommand(command);
  if (!value) return "worker가 현재 task에 필요한 확인 작업을 실행합니다.";

  const fileTargets = extractLikelyPaths(value).slice(0, 3);
  if (/\b(rg|grep)\b/.test(value)) {
    const pattern = extractSearchPattern(value);
    return `패턴 검색: ${pattern ? `"${pattern}" ` : ""}${fileTargets.length ? `대상 ${fileTargets.join(", ")}` : "기존 evidence와 workspace"}`;
  }
  if (/\b(find|fd)\b/.test(value)) {
    return `파일 목록 탐색: ${fileTargets.length ? fileTargets.join(", ") : "workspace/evidence에서 관련 산출물 찾기"}`;
  }
  if (/\b(sed|cat|head|tail|jq|yq)\b/.test(value)) {
    return `파일 내용 확인: ${fileTargets.length ? fileTargets.join(", ") : "선택한 evidence/report 파일"}`;
  }
  if (/\b(curl|httpx|wget|ffuf|nuclei)\b/.test(value)) {
    const url = extractUrl(value);
    return `HTTP/웹 확인: ${url ?? "대상 endpoint의 응답, 헤더, 리다이렉트, 재현 가능성 확인"}`;
  }
  if (/\b(python3?|node|npm|npx|tsx|go|ruby|perl)\b/.test(value)) {
    return `스크립트/도구 실행: evidence 분석, PoC 생성, 또는 결과 가공`;
  }
  if (/\b(mkdir|cp|mv|tee|touch)\b/.test(value)) {
    return `산출물 정리: artifacts/evidence 파일 생성 또는 복사`;
  }
  if (/\b(docker)\b/.test(value)) {
    return "Docker 작업: 컨테이너/이미지 상태 확인 또는 sandbox 실행";
  }
  return truncate(oneLine(value), 180);
}

function summarizeCommandOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "결과: 출력 없음";
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const first = truncate(oneLine(lines[0] ?? trimmed), 180);
  return `결과: ${lines.length}줄 출력${first ? `, 핵심 ${first}` : ""}`;
}

function cleanShellCommand(command: string): string {
  let value = oneLine(command);
  value = value.replace(/^\/bin\/bash\s+-lc\s+/, "");
  value = value.replace(/^bash\s+-lc\s+/, "");
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\"/g, '"').trim();
}

function extractLikelyPaths(value: string): string[] {
  const matches = value.match(/(?:\.?\/|\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+/g) ?? [];
  return Array.from(new Set(matches)).filter((item) => !item.startsWith("http://") && !item.startsWith("https://"));
}

function extractSearchPattern(value: string): string | undefined {
  const quoted = value.match(/\b(?:rg|grep)\b[^"']*["']([^"']{1,80})["']/);
  if (quoted?.[1]) return quoted[1];
  const plain = value.match(/\b(?:rg|grep)\b\s+(?:-[A-Za-z0-9]+\s+)*([^\s|]{1,80})/);
  return plain?.[1];
}

function extractUrl(value: string): string | undefined {
  return value.match(/https?:\/\/[^\s"'|)]+/)?.[0];
}

function visibleErrors(state: Awaited<ReturnType<typeof readState>>): string[] {
  if (!state.runId) return state.errors;
  return state.errors.filter((error) => {
    if (error.startsWith("advisor parse failed:") && state.status === "running") return false;
    if (isCodexHomePermissionNoise(error)) return false;
    return true;
  });
}

function hasCodexAuthFailure(errors: string[]): boolean {
  return errors.some((error) => error.includes("401 Unauthorized") || error.includes("Codex API 401"));
}

function isCodexHomePermissionNoise(error: string): boolean {
  return error.includes("EACCES: permission denied") && /\/codex-home(?:-[^/]+)?\/config\.toml/.test(error);
}

function bugBountyFocus(runbook: Awaited<ReturnType<typeof loadRunbook>>): string {
  const target = runbook.target?.name ?? "미지정";
  const inScope = runbook.target?.scope.length ?? 0;
  const outScope = runbook.target?.out_of_scope.length ?? 0;
  const preview = preferredScopePreview(runbook.target?.scope ?? []);
  return `${target} / in=${inScope} out=${outScope} / ${preview}`;
}

function ctfFocus(runbook: Awaited<ReturnType<typeof loadRunbook>>): string {
  const name = runbook.challenge?.name ?? "미지정";
  const files = runbook.challenge?.files.length ?? 0;
  const category = runbook.challenge?.category ?? "unknown";
  return `${name} / 파일 ${files}개 / ${category}`;
}

function resolveEvidencePreview(workspace: string, evidenceDir: string): string {
  const resolved = path.isAbsolute(evidenceDir) ? evidenceDir : path.resolve(workspace, evidenceDir);
  const relative = path.relative(workspace, resolved);
  return relative && !relative.startsWith("..") ? relative : resolved;
}

function coordinatorStatus(state: Awaited<ReturnType<typeof readState>>): { alive: boolean; text: string; textKo: string } {
  const pid = state.advisor.pid;
  if (!pid) return { alive: false, text: "not running", textKo: "대기/중지" };
  if (isPidAlive(pid)) return { alive: true, text: `continuous pid=${pid}`, textKo: `자동 루프 실행중 pid=${pid}` };
  return { alive: false, text: `stopped (stale pid=${pid})`, textKo: `멈춤 stale pid=${pid}` };
}

function nextNativeAction(
  runbook: Awaited<ReturnType<typeof loadRunbook>>,
  state: Awaited<ReturnType<typeof readState>>,
  coordinatorAlive: boolean,
  dockerStatus: string
): string {
  const active = Object.values(state.tasks).some((task) => ["queued", "starting", "running"].includes(task.status));
  const running = Object.values(state.tasks).some((task) => ["starting", "running"].includes(task.status));
  const queued = Object.values(state.tasks).some((task) => task.status === "queued");
  if (running) return queued ? "worker가 실행 중입니다. 끝나는 대로 대기열의 다음 작업을 이어서 실행합니다." : "worker가 실행 중입니다. 끝나면 advisor가 target 기준으로 다음 작업을 자동 배정합니다.";
  if (queued) return "대기열 작업이 있어 worker 슬롯이 비는 대로 실행합니다.";
  if (active) return "worker 상태를 동기화하는 중입니다.";
  if (state.sandboxMode === "docker" && dockerStatus.includes("image-status=없음")) {
    return "Docker worker image가 없으면 worker가 host full-access로 fallback 실행됩니다.";
  }
  if (!coordinatorAlive) return "자동 coordinator가 멈춰 있습니다. native 상태 감시가 재시작을 시도하거나 `huntctl loop`로 직접 재시작할 수 있습니다.";
  return "idle worker가 있으면 advisor loop가 현재 정보 기준으로 다음 작업을 자동 배정합니다.";
}

function workerAccessSummary(sandboxMode: string, danger: boolean, profile: string): string {
  if (sandboxMode === "docker") return "Docker 컨테이너 full-access 재현/PoC";
  void danger;
  void profile;
  return "host full-access";
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

async function dockerLine(runbook: Awaited<ReturnType<typeof loadRunbook>>): Promise<string> {
  const summary = await getDockerSummary(runbook);
  return summary.message;
}

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
} as const;

type Tone = keyof typeof ansi;

function color(tone: Tone, value: string): string {
  if (!useColor) return value;
  return `${ansi[tone]}${value}${ansi.reset}`;
}

function strong(value: string): string {
  return color("bold", value);
}

function dim(value: string): string {
  return color("gray", value);
}

function rule(width = nativeWidth()): string {
  return color("gray", "─".repeat(Math.max(24, width)));
}

function section(title: string): string {
  return color("cyan", `▌ ${title}`);
}

function kv(label: string, value: string, width = nativeWidth()): string {
  const labelWidth = 12;
  const prefix = `${color("gray", label.padEnd(labelWidth))} `;
  const continuation = `${" ".repeat(labelWidth)} `;
  const lines = wrapText(value, Math.max(12, width - labelWidth - 1));
  if (lines.length === 0) return prefix;
  return [prefix + lines[0], ...lines.slice(1).map((line) => continuation + line)].join("\n");
}

function badge(value: string, tone: Tone, width = 8): string {
  return color(tone, `[${value.padEnd(width)}]`);
}

function statusBadge(status: string): string {
  const tone: Tone =
    status === "running" || status === "completed" || status === "done"
      ? "green"
      : status === "queued" || status === "starting" || status === "idle"
        ? "yellow"
        : status === "blocked" || status === "failed" || status === "stopped"
          ? "red"
          : "cyan";
  return badge(statusKo(status), tone);
}

function profileChip(profile: string): string {
  return badge(profileKo(profile), profile === "ctf" ? "magenta" : "blue", 8);
}

function tableHeader(left: string, middle: string, role: string, right: string): string {
  return color("gray", `${left.padEnd(16)} ${middle.padEnd(10)} ${role.padEnd(16)} ${right}`);
}

function commandLine(label: string, command: string): string {
  const width = nativeWidth();
  const labelWidth = 10;
  const prefix = `${color("gray", label.padEnd(labelWidth))} `;
  const continuation = `${" ".repeat(labelWidth)} `;
  const lines = wrapText(command, Math.max(18, width - labelWidth - 1));
  return [prefix + color("cyan", lines[0] ?? ""), ...lines.slice(1).map((line) => continuation + color("cyan", line))].join("\n");
}

function bulletWrap(value: string, width = nativeWidth(), tone: Tone = "gray"): string[] {
  const lines = wrapText(value, Math.max(12, width - 2));
  if (!lines.length) return [];
  return [`${color(tone, "•")} ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`)];
}

function paragraph(value: string, width = nativeWidth()): string {
  return wrapText(value, width).join("\n");
}

function preferredScopePreview(scope: string[]): string {
  if (!scope.length) return "아직 없음";
  const urls = scope.filter((item) => item.startsWith("http://") || item.startsWith("https://"));
  const others = scope.filter((item) => !urls.includes(item));
  return [...urls, ...others].slice(0, 2).join(", ");
}

function nativeWidth(): number {
  const columns = process.stdout.columns ?? 68;
  return Math.max(42, Math.min(92, columns - 2));
}

function wrapText(value: string, width: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const parts = visibleWidth(word) > width ? breakLongWord(word, width) : [word];
    for (const part of parts) {
      if (!line) {
        line = part;
      } else if (visibleWidth(`${line} ${part}`) <= width) {
        line = `${line} ${part}`;
      } else {
        lines.push(line);
        line = part;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function breakLongWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const char of Array.from(word)) {
    if (current && visibleWidth(current + char) > width) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function visibleWidth(value: string): number {
  let width = 0;
  for (const char of Array.from(stripAnsi(value))) {
    const code = char.codePointAt(0) ?? 0;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function renderSummary(runDir: string): Promise<string> {
  if (await pathExists(summaryPath(runDir))) {
    return readFile(summaryPath(runDir), "utf8");
  }
  const state = await readState(runDir);
  return state.advisor.lastSummary || "No summary yet.\n";
}

export async function renderReportHtml(runDir: string): Promise<string> {
  const state = await readState(runDir);
  const events = await readEvents(runDir, 200);
  const summary = await renderSummary(runDir);
  const rows = Object.values(state.tasks)
    .map(
      (task) =>
        `<tr><td>${escapeHtml(task.id)}</td><td>${escapeHtml(task.agentId)}</td><td>${escapeHtml(task.role)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.reason ?? "")}</td></tr>`
    )
    .join("\n");
  const eventRows = events
    .map(
      (event) =>
        `<tr><td>${escapeHtml(event.time)}</td><td>${escapeHtml(event.source)}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.agentId ?? "")}</td><td>${escapeHtml(event.message ?? "")}</td></tr>`
    )
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>huntctl report ${escapeHtml(state.runId)}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; margin: 32px; color: #171717; background: #f7f7f2; }
    h1, h2 { margin-bottom: 8px; }
    pre { background: #fff; border: 1px solid #ddd; padding: 16px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; background: #fff; margin: 12px 0 28px; }
    th, td { border: 1px solid #ddd; text-align: left; padding: 8px; vertical-align: top; }
    th { background: #ecece4; }
    .meta { color: #525252; }
  </style>
</head>
<body>
  <h1>huntctl report</h1>
  <p class="meta">${escapeHtml(state.runId)} · ${escapeHtml(state.profile)} · ${escapeHtml(state.status)}</p>
  <h2>Summary</h2>
  <pre>${escapeHtml(summary)}</pre>
  <h2>Tasks</h2>
  <table><thead><tr><th>ID</th><th>Agent</th><th>Role</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Recent Events</h2>
  <table><thead><tr><th>Time</th><th>Source</th><th>Type</th><th>Agent</th><th>Message</th></tr></thead><tbody>${eventRows}</tbody></table>
</body>
</html>`;
}

export async function readAgentLogs(runDir: string, agentId: string): Promise<string> {
  const filePath = path.join(runDir, "agents", agentId, "logs.md");
  if (!(await pathExists(filePath))) return `No logs for ${agentId}\n`;
  return readFile(filePath, "utf8");
}

function statusKo(status: string): string {
  const map: Record<string, string> = {
    running: "실행중",
    completed: "완료",
    failed: "실패",
    stopped: "중지",
    idle: "대기",
    queued: "대기열",
    done: "완료",
    blocked: "차단",
    starting: "시작중"
  };
  return map[status] ?? status;
}

function profileKo(profile: string): string {
  const map: Record<string, string> = {
    ctf: "CTF",
    "bug-bounty": "버그바운티"
  };
  return map[profile] ?? profile;
}

function clockTime(iso?: string): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function elapsedMinutes(iso?: string): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const totalMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}일`);
  if (hours) parts.push(`${hours}시간`);
  parts.push(`${minutes}분`);
  return parts.join(" ");
}

function elapsedShort(iso?: string): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (totalSeconds < 60) return "<1분째";
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}분째`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}시간 ${minutes}분째`;
}

function workerRoleKo(role: string): string {
  const map: Record<string, string> = {
    worker: "worker",
    recon: "정찰 worker",
    validator: "검증 worker",
    "report-writer": "리포트 worker",
    "endpoint-mapper": "엔드포인트 worker",
    evidence: "증거 worker",
    "file-triage": "파일 분석 worker",
    solver: "풀이 worker",
    writeup: "writeup worker"
  };
  return map[role] ?? `${role} worker`;
}

function eventTypeKo(type: string): string {
  const map: Record<string, string> = {
    "run.created": "run 생성",
    "run.started": "run 시작",
    "session.ready": "세션 준비",
    "native.started": "native advisor 시작",
    "advisor.loop.started": "advisor 자동 루프 시작",
    "advisor.loop.already-running": "advisor 자동 루프 이미 실행중",
    "task.queued": "작업 대기열 추가",
    "task.blocked": "작업 차단",
    "task.done": "작업 완료",
    "task.failed": "작업 실패",
    "codex.started": "Codex worker 시작",
    "codex.event": "Codex 이벤트",
    "codex.fake": "mock Codex 완료",
    "advisor.summary": "advisor 요약",
    "scope.updated": "scope 업데이트",
    "target.stopped": "중지"
  };
  return map[type] ?? type;
}

function renderProgressEvent(event: HuntEvent): string[] {
  const time = dim(event.time.slice(11, 19));
  const actor = actorLabel(event.agentId ?? sourceKo(event.source));
  const details: string[] = [];
  let title = eventTypeKo(event.type);

  if (event.type === "codex.started") {
    const data = objectRecord(event.data);
    const sandbox = typeof data?.usedSandbox === "string" ? data.usedSandbox : "unknown";
    const image = typeof data?.dockerImage === "string" ? ` image=${data.dockerImage}` : "";
    const access = typeof data?.codexAccess === "string" ? ` access=${data.codexAccess}` : "";
    const artifacts = typeof data?.artifactDir === "string" ? ` artifacts=${data.artifactDir}` : "";
    title = `${workerVerb(event.agentId)} 시작`;
    details.push(`${sandbox}${image}${access} task=${shortTaskId(event.taskId)}`);
    if (artifacts) details.push(artifacts.trim());
    return [eventLine(time, actor, title, event.type), ...details.map(detailLine)];
  }

  if (event.type === "codex.event") {
    const rendered = renderCodexEvent(event);
    if (!rendered) return [];
    return [eventLine(time, actor, rendered.title, event.type), ...rendered.details.map(detailLine)];
  }

  if (event.type === "advisor.summary") {
    title = "advisor 판단";
    const data = objectRecord(event.data);
    const response = typeof data?.response === "string" ? data.response : event.message;
    if (response) details.push(truncate(oneLine(response), 220));
    const held = Array.isArray(data?.held_tasks) ? data.held_tasks.map(String).slice(0, 2) : [];
    for (const item of held) details.push(`보류: ${truncate(oneLine(item), 160)}`);
    return [eventLine(time, actor, title, event.type), ...details.map(detailLine)];
  }

  if (event.type === "task.queued") {
    title = "작업 배정";
    if (event.message) details.push(truncate(oneLine(event.message), 220));
  } else if (event.type === "task.failed") {
    title = "작업 실패";
    if (event.message) details.push(truncate(oneLine(event.message), 180));
  } else if (event.type === "task.done") {
    title = "작업 완료";
    if (event.message) details.push(truncate(oneLine(event.message), 180));
    const data = objectRecord(event.data);
    if (typeof data?.artifactDir === "string") details.push(`산출물: ${data.artifactDir}`);
  } else if (event.type === "task.blocked") {
    title = "정책상 차단";
    if (event.message) details.push(truncate(oneLine(event.message), 180));
  } else if (event.type === "scope.updated") {
    title = "scope 반영";
    if (event.message) details.push(truncate(oneLine(event.message), 180));
  } else if (event.type === "advisor.loop.started") {
    title = "자동 coordinator 시작";
    if (event.message) details.push(truncate(oneLine(event.message), 180));
  } else if (event.type === "advisor.loop.already-running") {
    title = "자동 coordinator 실행중";
    if (event.message) details.push(truncate(oneLine(event.message), 180));
  } else if (event.type === "native.started") {
    title = "왼쪽 advisor 시작";
    if (event.message) details.push(truncate(oneLine(event.message), 180));
  } else if (event.message) {
    details.push(truncate(oneLine(event.message), 180));
  }

  return [eventLine(time, actor, title, event.type), ...details.map(detailLine)];
}

function actorLabel(value: string): string {
  const tone: Tone =
    value.includes("advisor") ? "cyan" : value.includes("recon") ? "blue" : value.includes("validator") ? "magenta" : value.includes("report") ? "green" : "gray";
  return color(tone, value.padEnd(16));
}

function eventLine(time: string, actor: string, title: string, type: string): string {
  return `${time} ${actor} ${color(eventTone(type), title)}`;
}

function detailLine(value: string): string {
  const width = nativeWidth();
  const lines = wrapText(truncate(oneLine(value), 260), Math.max(12, width - 5));
  if (!lines.length) return "";
  return [`${color("gray", "  └─")} ${lines[0]}`, ...lines.slice(1).map((line) => `${color("gray", "     ")}${line}`)].join("\n");
}

function eventTone(type: string): Tone {
  if (type === "task.done" || type === "scope.updated") return "green";
  if (type === "task.failed" || type === "task.blocked") return "red";
  if (type === "task.queued" || type === "codex.started") return "yellow";
  if (type === "advisor.summary" || type.startsWith("advisor.")) return "cyan";
  if (type === "codex.event") return "magenta";
  return "blue";
}

function renderCodexEvent(event: HuntEvent): { title: string; details: string[] } | undefined {
  const data = objectRecord(event.data);
  const type = typeof data?.type === "string" ? data.type : event.message;
  if (type === "thread.started") return undefined;
  if (type === "turn.started") return { title: "모델 분석 시작", details: [`task=${shortTaskId(event.taskId)}`] };
  if (type === "turn.completed") {
    return {
      title: "모델 응답 완료",
      details: [formatTokenUsage(tokenUsageFromUsage(data?.usage))]
    };
  }
  if (type === "item.completed") {
    const item = objectRecord(data?.item);
    if (item?.type === "agent_message" && typeof item.text === "string") {
      const parsed = parseMaybeJson(item.text);
      const response = typeof parsed?.response === "string" ? parsed.response : undefined;
      const summary = typeof parsed?.summary === "string" ? parsed.summary : undefined;
      return {
        title: "결과 메시지 생성",
        details: [truncate(oneLine(response ?? summary ?? item.text), 220)]
      };
    }
    return undefined;
  }
  if (type === "item.started") return undefined;
  if (!type) return undefined;
  return undefined;
}

interface TokenUsageSummary {
  turns: number;
  input: number;
  cachedInput: number;
  output: number;
  reasoningOutput: number;
}

function tokenUsageSummary(events: HuntEvent[], agentId?: string): TokenUsageSummary {
  const total = emptyTokenUsage();
  for (const event of events) {
    if (agentId && event.agentId !== agentId) continue;
    const usage = tokenUsageFromEvent(event);
    if (!usage.turns) continue;
    total.turns += usage.turns;
    total.input += usage.input;
    total.cachedInput += usage.cachedInput;
    total.output += usage.output;
    total.reasoningOutput += usage.reasoningOutput;
  }
  return total;
}

function tokenUsageFromEvent(event: HuntEvent): TokenUsageSummary {
  if (event.type !== "codex.event") return emptyTokenUsage();
  const data = objectRecord(event.data);
  if (data?.type !== "turn.completed") return emptyTokenUsage();
  return tokenUsageFromUsage(data.usage);
}

function tokenUsageFromUsage(value: unknown): TokenUsageSummary {
  const usage = objectRecord(value);
  if (!usage) return emptyTokenUsage();
  const input = numericUsage(usage.input_tokens);
  const output = numericUsage(usage.output_tokens);
  const cachedInput = numericUsage(usage.cached_input_tokens);
  const reasoningOutput = numericUsage(usage.reasoning_output_tokens);
  if (!input && !output && !cachedInput && !reasoningOutput) return emptyTokenUsage();
  return {
    turns: 1,
    input,
    cachedInput,
    output,
    reasoningOutput
  };
}

function emptyTokenUsage(): TokenUsageSummary {
  return {
    turns: 0,
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoningOutput: 0
  };
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function formatTokenUsage(usage: TokenUsageSummary): string {
  if (!usage.turns) return "아직 없음";
  const seen = usage.input + usage.output;
  const uncachedInput = Math.max(0, usage.input - usage.cachedInput);
  const uncachedPlusOutput = uncachedInput + usage.output;
  const cacheRate = usage.input ? Math.round((usage.cachedInput / usage.input) * 100) : 0;
  const parts = [
    `${usage.turns}회`,
    `seen ${formatTokenCount(seen)}`,
    `uncached+out ${formatTokenCount(uncachedPlusOutput)}`,
    `new-in ${formatTokenCount(uncachedInput)}`,
    `cached ${formatTokenCount(usage.cachedInput)} (${cacheRate}%)`,
    `out ${formatTokenCount(usage.output)}`
  ];
  if (usage.reasoningOutput) parts.push(`reason ${formatTokenCount(usage.reasoningOutput)}`);
  return parts.join(" / ");
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
  return String(value);
}

function trimNumber(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function parseMaybeJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return objectRecord(parsed);
  } catch {
    return undefined;
  }
}

function sourceKo(source: HuntEvent["source"]): string {
  const map: Record<HuntEvent["source"], string> = {
    orchestrator: "시스템",
    advisor: "advisor",
    worker: "worker",
    user: "사용자",
    policy: "정책",
    system: "시스템"
  };
  return map[source] ?? source;
}

function workerVerb(agentId?: string): string {
  if (!agentId) return "Codex 작업";
  if (agentId === "advisor") return "advisor 점검";
  if (agentId.includes("recon")) return "정찰 작업";
  if (agentId.includes("validator")) return "검증 작업";
  if (agentId.includes("report")) return "보고서 작업";
  return "worker 작업";
}

function shortTaskId(taskId?: string): string {
  if (!taskId) return "-";
  const parts = taskId.split("-");
  return parts.length > 4 ? `${parts[1] ?? "task"}-${parts[parts.length - 1]}` : taskId;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
