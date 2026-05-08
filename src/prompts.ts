import { readFile } from "node:fs/promises";
import type { AdvisorDecision, AgentConfig, Candidate, CandidateStatus, RunState, Runbook } from "./types.js";
import { truncate } from "./utils.js";
import { taxonomyContext, taxonomyReferenceContext } from "./taxonomy.js";

const ADVISOR_STATE_CHAR_LIMIT = 3200;
const ADVISOR_RECENT_EVENTS_CHAR_LIMIT = 1400;
const ADVISOR_ACTIVE_TASK_LIMIT = 6;
const ADVISOR_RECENT_TASK_LIMIT = 8;
const ADVISOR_LIST_LIMIT = 6;
const ADVISOR_CANDIDATE_LEDGER_CHAR_LIMIT = 1200;
const WORKER_SCOPE_PREVIEW_LIMIT = 20;
const WORKER_OUT_SCOPE_PREVIEW_LIMIT = 14;

export async function buildWorkerPrompt(params: {
  runbook: Runbook;
  agent: AgentConfig;
  taskPrompt: string;
  promptFile?: string;
  runbookPath?: string;
}): Promise<string> {
  const custom = params.promptFile ? await readFile(params.promptFile, "utf8") : "";
  const rolePlan = workerContextPlan(params.runbook, params.agent.role);
  const reportTemplate =
    rolePlan.inlineReportTemplate && params.runbook.profile === "bug-bounty" && params.runbook.program?.report_template
      ? await safeRead(params.runbook.program.report_template)
      : "";
  const context =
    params.runbook.profile === "ctf"
      ? ctfContext(params.runbook)
      : bountyContext(params.runbook, params.agent.role, params.runbookPath);
  const taxonomy = rolePlan.inlineTaxonomy ? await taxonomyContext(params.runbook) : taxonomyReferenceContext(params.runbook);
  return [
    "huntctl cacheable worker prompt prefix v2",
    "You are a huntctl worker agent.",
    `Role: ${params.agent.role}`,
    "Respond in Korean by default unless the user explicitly asks for another language.",
    "",
    "Operational rules:",
    "- Use the runbook and user messages as context, not as a hard blocker.",
    "- Prefer evidence-preserving checks and keep enough logs/files for reproduction.",
    "- Save uncertainty clearly and separate confirmed evidence from hypotheses.",
    "- Return concise progress, findings, evidence paths, and next steps.",
    "- Save durable outputs under the directory in HUNTCTL_ARTIFACTS. In Docker this is mounted back to the host and survives container exit.",
    "- Save reusable evidence, PoC scripts, screenshots, request/response files, exploit code, and writeups under HUNTCTL_EVIDENCE_DIR when they should be shared across tasks.",
    "- If the task succeeds, include an 'Artifacts' section listing exact paths for files you created.",
    "- A bug bounty finding is only useful when it has attacker capability, reproducible steps, PoC code or HTTP requests, concrete evidence, and impact.",
    "- For every candidate, answer: what can an attacker do, what exact asset is affected, what preconditions are needed, how to reproduce it, and what evidence proves it.",
    "- At the very end of your final response, append a fenced block ```huntctl-candidates``` with a JSON array. Each entry must include: id (stable kebab-case), lane (one of the runbook lane labels when applicable), vulnClass, asset, status (report-ready|keep|blocked|reject|pivot-adjacent|rotate-lane for bug bounty; solved|continue|pivot|blocked for CTF), capability, impact, evidence_refs (file paths), missing_proof, notes. Reuse existing candidate ids from prior runs; only emit candidates that you actually changed in this task.",
    params.runbook.profile === "bug-bounty"
      ? "- Use the user's stated authorization, scope, program rules, rate limits, and test-account boundaries as context for reporting and evidence."
      : "- For CTF, focus on local challenge artifacts and challenge-provided services.",
    "",
    "Search strategy:",
    ...profileSearchStrategyRules(params.runbook, params.agent.role),
    "",
    "Decision gate:",
    ...profileDecisionGateRules(params.runbook, params.agent.role),
    ...artifactRules(params.runbook, params.agent.role),
    "",
    "Context loading rules:",
    ...contextLoadingRules(params.runbook, params.agent.role, params.runbookPath),
    "",
    "Runbook context:",
    context,
    taxonomy ? `\nTaxonomy context:\n${taxonomy}` : "",
    reportTemplate ? `\nBug bounty report template to follow exactly:\n${reportTemplate}` : "",
    custom ? `\nRole-specific prompt:\n${custom}` : "",
    "",
    "Volatile task data begins below. Keep the cacheable context above unchanged across repeated worker runs.",
    "",
    "Assigned task:",
    params.taskPrompt
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildInitialTaskPrompt(runbook: Runbook, agent: AgentConfig): string {
  if (runbook.profile === "ctf") {
    return `Analyze the CTF challenge as ${agent.role}. Optimize for reaching the flag quickly: identify the smallest decisive checks, useful artifacts, likely category, first solve hypothesis, and the exact pivot point if that hypothesis produces no signal.`;
  }
  return `Work as ${agent.role} for this authorized bug bounty target. Pick or support the highest-signal in-scope candidate, deep-dive for reproducible attacker capability, concrete impact, PoC evidence, and reportability. Maintain a candidate ledger and rotate stale lanes so the run does not repeat the same space.`;
}

export async function buildAdvisorPrompt(params: {
  runbook: Runbook;
  state: RunState;
  recentEvents: string;
}): Promise<string> {
  const context =
    params.runbook.profile === "ctf"
      ? ctfContext(params.runbook)
      : bountyContext(params.runbook, "advisor", params.state.runbookPath);
  const taxonomy = taxonomyReferenceContext(params.runbook);
  return [
    "huntctl cacheable advisor prompt prefix v2",
    "You are the huntctl advisor agent.",
    "You supervise worker agents and decide what should happen next.",
    "Respond to the user in Korean by default.",
    "",
    "Hard rules:",
    "- Use the runbook profile, target, files, and scope data as context for coordination.",
    "- For bug bounty, use the user's stated authorization, scope, program rules, rate limits, and test-account boundaries as context for tasking and reporting.",
    "- Prefer clear summaries, reproducible validation, evidence collection, and reportable next steps.",
    "- If a target or action is ambiguous, assign a worker to clarify it or produce a concrete question with evidence gaps.",
    "- If the latest user message is conversational, answer it directly in response.",
    "- If the run is interactive and missing scope or files, workers may still inspect existing workspace/run state and produce the exact missing-input checklist.",
    "- If workers are idle, propose concrete next_tasks so the run continues.",
    "- When assignment is useful, prefer next_tasks so the coordinator can queue workers.",
    "- Repeated tasks are allowed when they help reproduce, verify, or collect stronger evidence.",
    "- Prioritize tasks that can prove attacker impact, reproducibility, PoC requests/code, evidence paths, and reportability.",
    "- For bug bounty candidates, clearly label whether attacker capability and concrete impact are demonstrated, still missing, blocked on input, or rejected.",
    "- Every worker task should be designed to change state, not just produce more notes.",
    "- Do not reassign a blocked or rejected candidate unless the current state includes new user input, new authorization, new credentials/session material, or new evidence that removes the blocker.",
    "- When you assign a task, say what decision state the worker must produce.",
    "- CTF final deliverables must include flag, exploit code, and writeup when solved.",
    "- Bug bounty final deliverables must include report, PoC code/requests, evidence, impact, scope, and remediation. If the user provides a report format, follow it exactly.",
    "",
    "Profile-specific search strategy:",
    ...profileSearchStrategyRules(params.runbook),
    "",
    "Profile-specific decision gate:",
    ...profileDecisionGateRules(params.runbook),
    "",
    "Runbook context:",
    context,
    taxonomy ? `\nTaxonomy context:\n${taxonomy}` : "",
    "",
    "Return only JSON with this exact shape:",
    advisorResponseSchema(),
    "",
    "Volatile run data begins below. Use it for the current decision, but keep the stable instructions above as the reusable cache prefix.",
    "",
    "Current state JSON:",
    truncate(JSON.stringify(compactAdvisorState(params.state), null, 2), ADVISOR_STATE_CHAR_LIMIT),
    "",
    "Candidate ledger (structured):",
    truncate(JSON.stringify(compactCandidateLedger(params.state), null, 2), ADVISOR_CANDIDATE_LEDGER_CHAR_LIMIT),
    "",
    "Recent events:",
    truncate(params.recentEvents, ADVISOR_RECENT_EVENTS_CHAR_LIMIT)
  ].join("\n");
}

function compactCandidateLedger(state: RunState): Array<Record<string, unknown>> {
  const candidates = Object.values(state.candidates ?? {});
  return candidates
    .sort((a, b) => b.lastDecisionAt.localeCompare(a.lastDecisionAt))
    .slice(0, 10)
    .map((candidate) => ({
      id: candidate.id,
      lane: candidate.lane,
      vulnClass: candidate.vulnClass,
      asset: candidate.asset,
      status: candidate.status,
      capability: candidate.capability ? truncate(oneLine(candidate.capability), 120) : undefined,
      impact: candidate.impact ? truncate(oneLine(candidate.impact), 120) : undefined,
      missingProof: candidate.missingProof ? truncate(oneLine(candidate.missingProof), 120) : undefined,
      evidenceRefs: candidate.evidenceRefs.slice(-3),
      lastDecisionAt: candidate.lastDecisionAt,
      lastTaskId: candidate.lastTaskId
    }));
}

function advisorResponseSchema(): string {
  return JSON.stringify(
    {
      response: "Korean direct answer to the user's latest message, suitable for the dashboard",
      summary: "short Korean markdown summary of current state",
      next_tasks: [
        {
          worker_role: "validator",
          worker_id: "validator-1",
          task: "concrete task",
          reason: "why this is next"
        }
      ],
      held_tasks: ["task waiting because more evidence or user context would improve it"],
      auto_actions: ["human-readable action line"]
    } satisfies AdvisorDecision,
    null,
    2
  );
}

function compactAdvisorState(state: RunState): Record<string, unknown> {
  const allTasks = Object.values(state.tasks).sort((a, b) => (a.startedAt ?? a.id).localeCompare(b.startedAt ?? b.id));
  const activeTasks = allTasks
    .filter((task) => ["queued", "starting", "running"].includes(task.status))
    .slice(-ADVISOR_ACTIVE_TASK_LIMIT)
    .map((task) => ({
      id: task.id,
      agentId: task.agentId,
      role: task.role,
      source: task.source,
      status: task.status,
      reason: task.reason ? truncate(oneLine(task.reason), 120) : undefined,
      prompt: compactPrompt(task.prompt, 220),
      startedAt: task.startedAt,
      lastMessage: task.lastMessage ? compactMessage(task.lastMessage, 180) : undefined,
      blockedReason: task.blockedReason ? truncate(oneLine(task.blockedReason), 120) : undefined
    }));
  const recentTasks = allTasks
    .filter((task) => !["queued", "starting", "running"].includes(task.status))
    .slice(-ADVISOR_RECENT_TASK_LIMIT)
    .map((task) => ({
      id: task.id,
      agentId: task.agentId,
      role: task.role,
      source: task.source,
      status: task.status,
      endedAt: task.endedAt,
      exitCode: task.exitCode,
      decision: task.lastMessage ? extractDecision(task.lastMessage) : undefined,
      lastMessage: task.lastMessage ? compactMessage(task.lastMessage, 180) : undefined,
      blockedReason: task.blockedReason ? truncate(oneLine(task.blockedReason), 120) : undefined
    }));
  const agents = Object.fromEntries(
    Object.entries(state.agents).map(([id, agent]) => [
      id,
      {
        id: agent.id,
        role: agent.role,
        status: agent.status,
        currentTaskId: agent.currentTaskId,
        taskCount: agent.taskCount,
        lastMessage: agent.lastMessage ? compactMessage(agent.lastMessage, 140) : undefined
      }
    ])
  );
  return {
    runId: state.runId,
    profile: state.profile,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    workspace: state.workspace,
    sandboxMode: state.sandboxMode,
    danger: state.danger,
    taskStats: taskStatusCounts(allTasks),
    agents,
    activeTasks,
    recentTasks,
    advisor: {
      status: state.advisor.status,
      cycles: state.advisor.cycles,
      lastRunAt: state.advisor.lastRunAt,
      lastResponse: state.advisor.lastResponse ? compactMessage(state.advisor.lastResponse, 260) : undefined
    },
    findings: state.findings.slice(-ADVISOR_LIST_LIMIT).map((item) => compactMessage(item, 160)),
    heldTasks: state.heldTasks.slice(-ADVISOR_LIST_LIMIT).map((item) => compactMessage(item, 160)),
    autoActions: state.autoActions.slice(-ADVISOR_LIST_LIMIT).map((item) => compactMessage(item, 160)),
    errors: state.errors.slice(-ADVISOR_LIST_LIMIT).map((item) => compactMessage(item, 160))
  };
}

function taskStatusCounts(tasks: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function compactPrompt(value: string, max: number): string {
  const decision = extractDecision(value);
  const text = truncate(oneLine(value), max);
  return decision ? `${decision}; ${text}` : text;
}

function compactMessage(value: string, max: number): string {
  const decision = extractDecision(value);
  const text = truncate(oneLine(value), max);
  return decision && !text.includes(decision) ? `${decision}; ${text}` : text;
}

function extractDecision(value: string): string | undefined {
  const match = value.match(/\bDecision:\s*(solved|continue|pivot|blocked|report-ready|keep|reject|pivot-adjacent|rotate-lane)\b/i);
  return match ? `Decision: ${match[1].toLowerCase()}` : undefined;
}

const CANDIDATE_STATUSES: CandidateStatus[] = [
  "report-ready",
  "keep",
  "blocked",
  "reject",
  "pivot-adjacent",
  "rotate-lane",
  "solved",
  "continue",
  "pivot"
];

export function parseCandidateUpdates(finalMessage: string): Array<Partial<Candidate> & { id: string; status: CandidateStatus }> {
  const fence = finalMessage.match(/```huntctl-candidates\s*([\s\S]*?)```/i);
  if (!fence) return [];
  const body = fence[1].trim();
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const updates: Array<Partial<Candidate> & { id: string; status: CandidateStatus }> = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const statusRaw = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
    if (!id || !CANDIDATE_STATUSES.includes(statusRaw as CandidateStatus)) continue;
    const evidenceRefs = Array.isArray(record.evidence_refs)
      ? record.evidence_refs.filter((value) => typeof value === "string").map((value) => String(value))
      : [];
    updates.push({
      id,
      status: statusRaw as CandidateStatus,
      lane: typeof record.lane === "string" ? record.lane : undefined,
      vulnClass: typeof record.vulnClass === "string" ? record.vulnClass : undefined,
      asset: typeof record.asset === "string" ? record.asset : undefined,
      capability: typeof record.capability === "string" ? record.capability : undefined,
      impact: typeof record.impact === "string" ? record.impact : undefined,
      missingProof: typeof record.missing_proof === "string" ? record.missing_proof : undefined,
      evidenceRefs,
      notes: typeof record.notes === "string" ? record.notes : undefined
    });
  }
  return updates;
}

export function parseAdvisorDecision(value: string): AdvisorDecision {
  const json = extractJsonObject(value);
  const parsed = JSON.parse(json) as AdvisorDecision;
  return {
    response: parsed.response === undefined ? undefined : String(parsed.response),
    summary: String(parsed.summary ?? ""),
    next_tasks: Array.isArray(parsed.next_tasks) ? parsed.next_tasks : [],
    held_tasks: Array.isArray(parsed.held_tasks) ? parsed.held_tasks.map(String) : [],
    auto_actions: Array.isArray(parsed.auto_actions) ? parsed.auto_actions.map(String) : []
  };
}

function ctfContext(runbook: Runbook): string {
  const challenge = runbook.challenge;
  return JSON.stringify(
    {
      profile: runbook.profile,
      challenge,
      limits: runbook.limits,
      evidence_dir: runbook.evidence_dir
    },
    null,
    2
  );
}

function bountyContext(runbook: Runbook, role = "worker", runbookPath?: string): string {
  const program = runbook.program;
  const target = runbook.target;
  const includeRules = roleNeedsValidationContext(role);
  const includeReportRefs = roleNeedsReportContext(role);
  return JSON.stringify(
    {
      profile: runbook.profile,
      full_runbook_path: runbookPath,
      target: target
        ? {
            name: target.name,
            scope_count: target.scope.length,
            scope_preview: previewList(target.scope, WORKER_SCOPE_PREVIEW_LIMIT),
            out_of_scope_count: target.out_of_scope.length,
            out_of_scope_preview: previewList(target.out_of_scope, WORKER_OUT_SCOPE_PREVIEW_LIMIT)
          }
        : undefined,
      program: program
        ? {
            platform: program.platform ?? "custom",
            description: program.description ? truncate(oneLine(program.description), 900) : undefined,
            rules: includeRules ? compactJson(program.rules, 900) : compactJson(program.rules, 360),
            report_template_path: program.report_template,
            hackerone_weaknesses_url: program.hackerone_weaknesses_url,
            bugcrowd_vrt_path: program.bugcrowd_vrt_path,
            vrt_hints: includeRules ? previewList(program.vrt, 18) : previewList(program.vrt, 8),
            weakness_hints: includeRules || includeReportRefs ? previewList(program.weaknesses, 18) : previewList(program.weaknesses, 8)
          }
        : undefined,
      limits: runbook.limits,
      evidence_dir: runbook.evidence_dir
    },
    null,
    2
  );
}

function workerContextPlan(runbook: Runbook, role: string): { inlineTaxonomy: boolean; inlineReportTemplate: boolean } {
  if (runbook.profile !== "bug-bounty") {
    return {
      inlineTaxonomy: false,
      inlineReportTemplate: false
    };
  }
  return {
    inlineTaxonomy: roleNeedsValidationContext(role) || roleNeedsReportContext(role),
    inlineReportTemplate: roleNeedsReportContext(role)
  };
}

function contextLoadingRules(runbook: Runbook, role: string, runbookPath?: string): string[] {
  const rules = [
    "- Use the inline context first. If the preview is enough, do not read large runbook/taxonomy/template files.",
    "- When you need exact scope, platform taxonomy, or report wording, read only the relevant lines/sections from the referenced file paths and summarize them.",
    "- Do not paste large raw logs, full scope lists, full JSON taxonomies, or full templates into your final response; save raw evidence to artifacts and return paths."
  ];
  if (runbookPath) rules.push(`- Full runbook path for exact scope/rules when needed: ${runbookPath}`);
  if (runbook.profile === "bug-bounty" && runbook.program?.bugcrowd_vrt_path) {
    rules.push(`- Bugcrowd VRT path for exact category/severity mapping when needed: ${runbook.program.bugcrowd_vrt_path}`);
  }
  if (runbook.profile === "bug-bounty" && runbook.program?.report_template) {
    const reportNeed = roleNeedsReportContext(role) ? "Use it for final report wording." : "Read it only if your task explicitly needs report wording.";
    rules.push(`- Report template path: ${runbook.program.report_template}. ${reportNeed}`);
  }
  return rules;
}

function roleNeedsValidationContext(role: string): boolean {
  const value = role.toLowerCase();
  return value.includes("validator") || value.includes("triage") || value.includes("evidence");
}

function roleNeedsReportContext(role: string): boolean {
  const value = role.toLowerCase();
  return value.includes("report") || value.includes("writeup") || value.includes("evidence");
}

function previewList(values: string[], limit: number): string[] {
  if (values.length <= limit) return values;
  return [...values.slice(0, limit), `... +${values.length - limit} more in runbook`];
}

function compactJson(value: unknown, max: number): string | undefined {
  if (!value || (typeof value === "object" && !Object.keys(value as Record<string, unknown>).length)) return undefined;
  return truncate(JSON.stringify(value), max);
}

function profileSearchStrategyRules(runbook: Runbook, role?: string): string[] {
  if (runbook.profile === "ctf") {
    return [
      "- CTF has a known answer. Optimize every cycle for finding the flag, exploit, or decisive solve path.",
      "- Do not tunnel on one surface. Timebox each hypothesis; after 1-2 weak attempts or no new signal, pivot to a different technique, file, service, parameter, crypto angle, reverse path, or exploit class.",
      "- Prefer fast discriminating checks over broad inventory. Keep failed attempts short, record why they failed, then switch direction.",
      "- Do only enough inventory to choose the next solve path; long cataloging is lower priority than a check that can prove or kill a hypothesis.",
      "- If multiple workers are available, diversify approaches instead of assigning everyone to the same hypothesis.",
      role === "writeup"
        ? "- Writeup work should not slow solving; if flag is missing, produce the shortest useful state summary and ask solver workers to pivot."
        : role === "ctf-validator" || role === "validator"
          ? "- Validator work re-runs the most recent solver hypothesis/PoC against the challenge to confirm the flag or kill the lead independently. Do not write new solvers; only verify."
          : "- Worker output must name the current hypothesis, result, whether to continue or pivot, and the next distinct solve attempt."
    ];
  }
  return [
    "- Bug bounty usually has no single answer. Pick the highest-signal in-scope candidate and deep-dive until it becomes report-ready, keep-worthy, blocked, rejected, or ready to rotate.",
    "- Do not pivot just because the first request is inconclusive. Tighten reproduction, collect request/response evidence, test preconditions, and prove or disprove attacker capability and concrete impact.",
    "- Avoid staying in the same space indefinitely. Track a candidate ledger with candidate id, asset/surface lane, vulnerability class, status, evidence added, missing proof, and next decision.",
    "- Use a depth budget per lane: spend a few focused cycles on reproduction and impact, but if two consecutive cycles add no new evidence or capability, pivot to an adjacent asset/surface/vulnerability lane.",
    "- Pivot only after writing a clear rejection reason, scope reason, missing-permission blocker, or evidence gap that makes more work on this candidate inefficient.",
    "- When multiple workers are available, coordinate around one primary candidate only while another worker keeps a light alternate lane alive so the run does not tunnel.",
    "- Prefer lane rotation over shallow scanning: auth/session, access control/IDOR, API parameter behavior, redirects/deep links, cache/CORS/headers, uploads/media, mobile/app links, cloud/static assets, business logic.",
    role === "report-writer"
      ? "- Report-writing should maintain normalized candidate status: report-ready, keep, blocked, reject, pivot-adjacent, or rotate-lane, with exact evidence gaps."
      : "- Worker output must name the candidate under test, current lane, current confidence, evidence added, and whether to keep digging, pivot adjacent, or rotate to a different lane."
  ];
}

function profileDecisionGateRules(runbook: Runbook, role?: string): string[] {
  if (runbook.profile === "ctf") {
    return [
      "- End every task with exactly one line: `Decision: solved | continue | pivot | blocked`.",
      "- `solved` means the flag is found or a complete exploit/solver path reliably prints it.",
      "- `continue` is allowed only when the latest attempt produced a concrete new signal that makes the same path more likely.",
      "- `pivot` is required after 1-2 weak attempts, no new signal, broad inventory with no solve path, or repeated failure on the same surface.",
      "- `blocked` means a required file, service, password, remote endpoint, or runtime dependency is missing; name the exact missing input.",
      role === "writeup"
        ? "- If no flag exists, write only a compact state note: tried hypotheses, why they failed, and the next pivot for solver workers."
        : role === "ctf-validator" || role === "validator"
          ? "- Validator must mark `solved` only after independently reproducing the flag from the solver's PoC, otherwise return `pivot` (PoC failed), `continue` (still promising signal), or `blocked` (need a missing input)."
          : "- Output must include: hypothesis, test performed, signal found or absent, decision, next distinct solve attempt."
    ];
  }
  return [
    "- End every task with exactly one line: `Decision: report-ready | keep | blocked | reject | pivot-adjacent | rotate-lane`.",
    "- `report-ready` requires all of: in-scope affected asset, attacker capability, concrete impact, reproducible steps, PoC request/code, durable evidence paths, and platform severity/taxonomy mapping.",
    "- `keep` is allowed only when the last cycle added new evidence that directly improves attacker capability, impact, reproduction, or PoC quality.",
    "- `blocked` is required when the next proof needs user-provided authorization, login/session material, test accounts, public canary, mobile/app runtime, fixture data, or cross-account permission. List the exact missing inputs and stop retesting until they exist.",
    "- `reject` is required for scanner-only output, public metadata only, header-only issues without impact, escaped reflection without execution, error-body-only CORS, normal redirects, or behavior with no attacker-controlled security boundary crossed.",
    "- `pivot-adjacent` is required when the candidate is not report-ready but a nearby asset/surface/class has a concrete next test.",
    "- `rotate-lane` is required when two focused cycles add no new evidence or capability in the same lane.",
    "- For every candidate, include both `Why continue` and `Why stop/rotate` so the advisor can avoid loops.",
    role === "report-writer" || role === "evidence"
      ? "- If there is no `report-ready` candidate, do not write a submission-style report. Update only the candidate ledger, evidence map, dashboard summary, and missing-input checklist."
      : "- Output must include: candidate id, lane, status, evidence added, missing proof, attacker capability, concrete impact, decision, and next handoff."
  ];
}

function artifactRules(runbook: Runbook, role: string): string[] {
  if (runbook.profile === "ctf") {
    return [
      "- CTF deliverables: when a flag is found, output FLAG, exploit code, reproduction steps, and writeup.",
      "- If no flag is found yet, output hypotheses tried, commands run, blockers, and the next concrete attempt.",
      role === "writeup" || role === "solver"
        ? "- Use sections: Flag, Exploit Code, How It Works, Reproduction, Failed Attempts, Next Steps."
        : role === "ctf-validator" || role === "validator"
          ? "- Validator output should record: PoC reproduced (yes/no), exact command run, observed flag or failure, environment notes, and follow-up action for the solver."
          : "- Save details that the solver/writeup worker can use later."
    ];
  }
  if (runbook.program?.platform === "hackerone") {
    return [
      "- HackerOne deliverables must map to the HackerOne report form: Asset, Weakness, Severity, Description, Impact, Attachments.",
      "- Description must include: Summary, test accounts/IPs used, and Steps to Reproduce with Burp request/response snippets.",
      "- Impact must include a concise impact summary, affected users/data/actions, and business/security consequence.",
      "- Evidence must include PoC code or HTTP requests, response snippets, screenshots/video paths, timestamps, and tested account/context.",
      "- Weakness should use the HackerOne weakness type/External ID where applicable.",
      role === "report-writer"
        ? "- Use sections: Asset, Weakness, Severity, Description, Impact, Attachments, PoC Code, Evidence Checklist."
        : "- Return findings in a form the report-writer can directly paste into the HackerOne form."
    ];
  }
  if (runbook.program?.platform === "bugcrowd") {
    return [
      "- Bugcrowd deliverables must map to the Bugcrowd submission form: Summary title, Target, Technical severity, VRT Category, Vulnerability details, Attachments, Confirmation.",
      "- Technical severity and VRT Category should use the Bugcrowd VRT JSON when configured.",
      "- Vulnerability details must include URL/location, description, impact, proof of concept, replication steps, and evidence.",
      "- Evidence must include PoC code or HTTP requests, response snippets, screenshots/video paths, timestamps, and tested account/context.",
      role === "report-writer"
        ? "- Use sections: Summary Title, Target, Technical Severity, VRT Category, Vulnerability Details, PoC, Evidence, Attachments, Confirmation Checklist."
        : "- Return findings in a form the report-writer can directly paste into the Bugcrowd form."
    ];
  }
  return [
    "- Bug bounty deliverables: report draft, PoC code or HTTP requests, evidence, impact, affected scope, and remediation.",
    "- Evidence should include exact request/response snippets, screenshots or file paths when available, timestamps, and tested account/context.",
    "- If a report template is provided, follow that structure and put extra notes under an Additional Notes section.",
    role === "report-writer"
      ? "- Use sections: Title, Summary, Scope, Severity, VRT/CWE, Steps to Reproduce, PoC, Evidence, Impact, Remediation, Limitations."
      : "- Return findings in a form the report-writer can directly paste into the final report."
  ];
}

async function safeRead(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function extractJsonObject(value: string): string {
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const start = value.search(/\{\s*"(response|summary|next_tasks|held_tasks|auto_actions)"/);
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) return value.slice(start, end + 1);
  throw new Error("Advisor output did not contain a JSON object");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
