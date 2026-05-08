import type { AgentConfig, ReasoningEffort } from "./types.js";

export function reasoningEffortForAgent(agent: AgentConfig): ReasoningEffort {
  if (agent.reasoning_effort) return agent.reasoning_effort;
  return defaultReasoningEffortForRole(agent.role);
}

export function defaultReasoningEffortForRole(role: string): ReasoningEffort {
  const normalized = role.toLowerCase();
  if (normalized === "advisor") return "low";
  if (normalized.includes("report") || normalized.includes("writeup")) return "medium";
  if (normalized.includes("evidence")) return "high";
  if (isDirectInvestigationRole(normalized)) return "xhigh";
  return "high";
}

function isDirectInvestigationRole(role: string): boolean {
  return [
    "recon",
    "endpoint",
    "mapper",
    "triage",
    "worker",
    "solver",
    "validator",
    "web",
    "reverse",
    "crypto",
    "pwn",
    "mobile",
    "android",
    "api",
    "exploit",
    "fuzz"
  ].some((keyword) => role.includes(keyword));
}
