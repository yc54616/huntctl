export type Profile = "ctf" | "bug-bounty";
export type SandboxMode = "auto" | "host" | "docker";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type TaskStatus = "queued" | "starting" | "running" | "done" | "failed" | "blocked" | "stopped";
export type AgentStatus = "idle" | "queued" | "running" | "done" | "failed" | "blocked" | "stopped";
export type RunStatus = "running" | "completed" | "failed" | "stopped";

export interface AgentConfig {
  id: string;
  role: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  prompt_file?: string;
}

export interface AdvisorConfig {
  mode: "auto" | "manual";
  interval_seconds: number;
  can_assign_workers: boolean;
  can_stop_workers: boolean;
}

export interface LimitsConfig {
  max_parallel_agents: number;
  timeout_minutes: number;
  rate_limit?: "conservative" | "normal" | "aggressive";
}

export interface ChallengeConfig {
  name: string;
  description: string;
  files: string[];
  category?: string;
}

export interface TargetConfig {
  name: string;
  scope: string[];
  out_of_scope: string[];
  files?: string[];
}

export interface ProgramConfig {
  description?: string;
  platform?: "hackerone" | "bugcrowd" | "custom";
  report_template?: string;
  hackerone_weaknesses_url?: string;
  bugcrowd_vrt_path?: string;
  vrt: string[];
  weaknesses: string[];
  rules: Record<string, unknown>;
}

export interface BountyLane {
  label: string;
  goal: string;
  vrt?: string[];
  recon: string;
  validator: string;
  report: string;
}

export interface Runbook {
  profile: Profile;
  interactive?: boolean;
  danger?: boolean;
  challenge?: ChallengeConfig;
  target?: TargetConfig;
  program?: ProgramConfig;
  advisor: AdvisorConfig;
  limits: LimitsConfig;
  agents: AgentConfig[];
  evidence_dir: string;
  sandbox: {
    mode: SandboxMode;
    image?: string;
    strict?: boolean;
  };
  bounty_lanes?: BountyLane[];
}

export interface AgentState {
  id: string;
  role: string;
  status: AgentStatus;
  pid?: number;
  currentTaskId?: string;
  lastUpdate?: string;
  lastMessage?: string;
  taskCount: number;
}

export interface TaskState {
  id: string;
  agentId: string;
  role: string;
  source: "initial" | "user" | "advisor";
  status: TaskStatus;
  prompt: string;
  reason?: string;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
  lastMessage?: string;
  exitCode?: number | null;
}

export interface AdvisorState {
  status: AgentStatus;
  pid?: number;
  lastRunAt?: string;
  lastSummary?: string;
  lastResponse?: string;
  cycles: number;
  lastHeartbeatAt?: string;
}

export type CandidateStatus =
  | "report-ready"
  | "keep"
  | "blocked"
  | "reject"
  | "pivot-adjacent"
  | "rotate-lane"
  | "solved"
  | "continue"
  | "pivot";

export interface Candidate {
  id: string;
  lane?: string;
  vulnClass?: string;
  asset?: string;
  status: CandidateStatus;
  capability?: string;
  impact?: string;
  evidenceRefs: string[];
  missingProof?: string;
  lastDecisionAt: string;
  lastTaskId?: string;
  lastAgentId?: string;
  notes?: string;
}

export interface RunState {
  runId: string;
  profile: Profile;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  runbookPath: string;
  workspace: string;
  sandboxMode: SandboxMode;
  danger: boolean;
  agents: Record<string, AgentState>;
  tasks: Record<string, TaskState>;
  advisor: AdvisorState;
  findings: string[];
  heldTasks: string[];
  autoActions: string[];
  errors: string[];
  candidates: Record<string, Candidate>;
  policyWarnings: string[];
  sandboxFallbacks: string[];
}

export interface HuntEvent {
  time: string;
  runId: string;
  type: string;
  source: "orchestrator" | "advisor" | "worker" | "user" | "policy" | "system";
  agentId?: string;
  taskId?: string;
  message?: string;
  data?: unknown;
}

export interface AdvisorDecision {
  response?: string;
  summary: string;
  next_tasks: Array<{
    worker_role?: string;
    worker_id?: string;
    task: string;
    reason?: string;
  }>;
  held_tasks: string[];
  auto_actions: string[];
}
