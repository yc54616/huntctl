import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AgentConfig, Runbook } from "./types.js";

const AgentSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  model: z.string().optional(),
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  prompt_file: z.string().optional()
});

const AdvisorSchema = z
  .object({
    mode: z.enum(["auto", "manual"]).default("auto"),
    interval_seconds: z.number().int().positive().default(60),
    can_assign_workers: z.boolean().default(true),
    can_stop_workers: z.boolean().default(true)
  })
  .default({
    mode: "auto",
    interval_seconds: 60,
    can_assign_workers: true,
    can_stop_workers: true
  });

const LimitsSchema = z
  .object({
    max_parallel_agents: z.number().int().positive().default(3),
    timeout_minutes: z.number().int().positive().default(45),
    rate_limit: z.enum(["conservative", "normal", "aggressive"]).optional()
  })
  .default({
    max_parallel_agents: 3,
    timeout_minutes: 45
  });

const ChallengeSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  files: z.array(z.string()).default([]),
  category: z.string().optional()
});

const TargetSchema = z.object({
  name: z.string().min(1),
  scope: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([])
});

const ProgramSchema = z
  .object({
    description: z.string().optional(),
    platform: z.enum(["hackerone", "bugcrowd", "custom"]).default("custom"),
    report_template: z.string().optional(),
    hackerone_weaknesses_url: z.string().optional(),
    bugcrowd_vrt_path: z.string().optional(),
    vrt: z.array(z.string()).default([]),
    weaknesses: z.array(z.string()).default([]),
    rules: z.record(z.string(), z.unknown()).default({})
  })
  .default({
    platform: "custom",
    vrt: [],
    weaknesses: [],
    rules: {}
  });

const BountyLaneSchema = z.object({
  label: z.string().min(1),
  goal: z.string().min(1),
  recon: z.string().min(1),
  validator: z.string().min(1),
  report: z.string().min(1)
});

const RunbookSchema = z
  .object({
    profile: z.enum(["ctf", "bug-bounty"]),
    interactive: z.boolean().default(false),
    danger: z.boolean().default(false),
    challenge: ChallengeSchema.optional(),
    target: TargetSchema.optional(),
    program: ProgramSchema.optional(),
    advisor: AdvisorSchema,
    limits: LimitsSchema,
    agents: z.array(AgentSchema).optional(),
    evidence_dir: z.string().default(".huntctl/evidence"),
    sandbox: z
      .object({
        mode: z.enum(["auto", "host", "docker"]).default("auto"),
        image: z.string().min(1).optional(),
        strict: z.boolean().default(false)
      })
      .default({
        mode: "auto",
        strict: false
      }),
    bounty_lanes: z.array(BountyLaneSchema).optional()
  })
  .superRefine((value, ctx) => {
    if (value.profile === "ctf" && !value.challenge && !value.interactive) {
      ctx.addIssue({
        code: "custom",
        path: ["challenge"],
        message: "profile: ctf requires a challenge block"
      });
    }
    if (value.profile === "ctf" && value.challenge && !value.challenge.description && value.challenge.files.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["challenge"],
        message: "CTF challenge needs a description, files, or both"
      });
    }
  });

export async function loadRunbook(filePath: string): Promise<Runbook> {
  const raw = await readFile(filePath, "utf8");
  const parsed = YAML.parse(raw) as unknown;
  const result = RunbookSchema.parse(parsed);
  if (result.program?.report_template && !path.isAbsolute(result.program.report_template)) {
    result.program.report_template = path.resolve(path.dirname(filePath), result.program.report_template);
  }
  if (result.program?.bugcrowd_vrt_path && !path.isAbsolute(result.program.bugcrowd_vrt_path)) {
    result.program.bugcrowd_vrt_path = path.resolve(path.dirname(filePath), result.program.bugcrowd_vrt_path);
  }
  const agents = withDefaultAgents(result.profile, result.agents ?? []);
  ensureUniqueAgentIds(agents);
  return {
    ...result,
    agents,
    evidence_dir: result.evidence_dir || ".huntctl/evidence",
    sandbox: result.sandbox
      ? { mode: result.sandbox.mode, image: result.sandbox.image, strict: Boolean(result.sandbox.strict) }
      : { mode: "auto", strict: false },
    bounty_lanes: result.bounty_lanes
  };
}

export function createInteractiveRunbook(params: {
  profile: Runbook["profile"];
  workers: number;
  roles?: string[];
  sandboxMode: Runbook["sandbox"]["mode"];
  dockerImage?: string;
  danger?: boolean;
  targetName?: string;
  description?: string;
  scope?: string[];
  outOfScope?: string[];
  files?: string[];
  evidenceDir?: string;
  vrt?: string[];
  weaknesses?: string[];
  reportTemplate?: string;
  platform?: "hackerone" | "bugcrowd" | "custom";
  hackeroneWeaknessesUrl?: string;
  bugcrowdVrtPath?: string;
  strictSandbox?: boolean;
}): Runbook {
  const agents = [
    { id: "advisor", role: "advisor" },
    ...createWorkerAgents(params.profile, params.workers, params.roles)
  ];

  if (params.profile === "ctf") {
    return {
      profile: "ctf",
      interactive: true,
      danger: Boolean(params.danger),
      challenge: {
        name: params.targetName || "interactive-ctf",
        description: params.description || "Interactive CTF session. Ask the advisor what to inspect next.",
        files: params.files ?? []
      },
      advisor: {
        mode: "manual",
        interval_seconds: 45,
        can_assign_workers: true,
        can_stop_workers: true
      },
      limits: {
        max_parallel_agents: Math.max(1, params.workers),
        timeout_minutes: 45
      },
      agents,
      evidence_dir: params.evidenceDir ?? "evidence",
      sandbox: {
        mode: params.sandboxMode,
        image: params.dockerImage,
        strict: Boolean(params.strictSandbox)
      }
    };
  }

  return {
    profile: "bug-bounty",
    interactive: true,
    danger: Boolean(params.danger),
    target: {
      name: params.targetName || "interactive-target",
      scope: params.scope ?? [],
      out_of_scope: params.outOfScope ?? []
    },
    program: {
      platform: params.platform ?? "custom",
      description: params.description || "Interactive authorized bug bounty session.",
      vrt: params.vrt ?? [],
      weaknesses: params.weaknesses ?? [],
      report_template: params.reportTemplate,
      hackerone_weaknesses_url: params.hackeroneWeaknessesUrl,
      bugcrowd_vrt_path: params.bugcrowdVrtPath,
      rules: {
        rate_limit: "conservative",
        destructive_testing: false
      }
    },
    advisor: {
      mode: "manual",
      interval_seconds: 45,
      can_assign_workers: true,
      can_stop_workers: true
    },
    limits: {
      max_parallel_agents: Math.max(1, params.workers),
      timeout_minutes: 45,
      rate_limit: "conservative"
    },
    agents,
    evidence_dir: params.evidenceDir ?? "evidence",
    sandbox: {
      mode: params.sandboxMode,
      image: params.dockerImage
    }
  };
}

export function runbookToYaml(runbook: Runbook): string {
  return YAML.stringify(runbook);
}

export function resolvePromptFile(runbookPath: string, promptFile?: string): string | undefined {
  if (!promptFile) return undefined;
  if (path.isAbsolute(promptFile)) return promptFile;
  return path.resolve(path.dirname(runbookPath), promptFile);
}

function withDefaultAgents(profile: Runbook["profile"], agents: AgentConfig[]): AgentConfig[] {
  if (agents.length > 0) return agents;
  if (profile === "ctf") {
    return [
      { id: "advisor", role: "advisor" },
      { id: "triage-1", role: "file-triage" },
      { id: "solver-1", role: "solver" },
      { id: "validator-1", role: "ctf-validator" },
      { id: "writeup-1", role: "writeup" }
    ];
  }
  return [
    { id: "advisor", role: "advisor" },
    { id: "recon-1", role: "recon" },
    { id: "validator-1", role: "validator" },
    { id: "reporter-1", role: "report-writer" }
  ];
}

function ensureUniqueAgentIds(agents: AgentConfig[]): void {
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) {
      throw new Error(`Duplicate agent id in runbook: ${agent.id}`);
    }
    seen.add(agent.id);
  }
}

function createWorkerAgents(profile: Runbook["profile"], workers: number, roles?: string[]): AgentConfig[] {
  const defaults =
    profile === "ctf"
      ? ["file-triage", "solver", "ctf-validator", "writeup", "web-recon", "reverse", "crypto", "pwn"]
      : ["recon", "validator", "report-writer", "endpoint-mapper", "evidence", "custom"];
  return Array.from({ length: Math.max(1, workers) }, (_, index) => {
    const role = roles?.[index] || defaults[index] || "custom";
    return {
      id: `${role.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-${index + 1}`,
      role
    };
  });
}
