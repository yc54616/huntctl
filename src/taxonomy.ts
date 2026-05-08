import { readFile } from "node:fs/promises";
import type { Runbook } from "./types.js";
import { truncate } from "./utils.js";

interface VrtNode {
  id?: string;
  name?: string;
  type?: string;
  priority?: number;
  children?: VrtNode[];
}

export async function taxonomyContext(runbook: Runbook): Promise<string> {
  if (runbook.profile !== "bug-bounty") return "";
  const program = runbook.program;
  if (!program) return "";

  const lines: string[] = [];
  lines.push(`Report platform: ${program.platform ?? "custom"}`);
  if (program.platform === "hackerone" || program.hackerone_weaknesses_url) {
    lines.push(`HackerOne weakness types URL: ${program.hackerone_weaknesses_url ?? "https://docs.hackerone.com/en/articles/8475337-types-of-weaknesses"}`);
    lines.push("Use HackerOne weakness names and External IDs where applicable.");
  }
  if (program.platform === "bugcrowd" || program.bugcrowd_vrt_path) {
    lines.push(program.bugcrowd_vrt_path ? await bugcrowdVrtSummary(program.bugcrowd_vrt_path) : "Bugcrowd VRT path not configured.");
  }
  return lines.filter(Boolean).join("\n");
}

export function taxonomyReferenceContext(runbook: Runbook): string {
  if (runbook.profile !== "bug-bounty") return "";
  const program = runbook.program;
  if (!program) return "";

  const lines: string[] = [];
  lines.push(`Report platform: ${program.platform ?? "custom"}`);
  if (program.hackerone_weaknesses_url || program.platform === "hackerone") {
    lines.push(`HackerOne weakness reference: ${program.hackerone_weaknesses_url ?? "https://docs.hackerone.com/en/articles/8475337-types-of-weaknesses"}`);
  }
  if (program.bugcrowd_vrt_path || program.platform === "bugcrowd") {
    lines.push(`Bugcrowd VRT reference: ${program.bugcrowd_vrt_path ?? "not configured"}`);
  }
  if (program.vrt.length) {
    lines.push(`Configured VRT hints: ${program.vrt.slice(0, 12).join(", ")}${program.vrt.length > 12 ? ` (+${program.vrt.length - 12} more)` : ""}`);
  }
  if (program.weaknesses.length) {
    lines.push(
      `Configured weakness hints: ${program.weaknesses.slice(0, 12).join(", ")}${
        program.weaknesses.length > 12 ? ` (+${program.weaknesses.length - 12} more)` : ""
      }`
    );
  }
  return lines.filter(Boolean).join("\n");
}

async function bugcrowdVrtSummary(filePath: string): Promise<string> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { metadata?: { release_date?: string }; content?: VrtNode[] };
    const categories = (parsed.content ?? []).map((node) => node.name).filter(Boolean);
    const priorityExamples = priorityVariantExamples(parsed.content ?? [], [1, 2, 3, 4], 8);
    const fallbackExamples = collectVariantExamples(parsed.content ?? [], 16);
    return [
      `Bugcrowd VRT file: ${filePath}`,
      `Bugcrowd VRT release: ${parsed.metadata?.release_date ?? "unknown"}`,
      `Bugcrowd VRT top-level categories (${categories.length}): ${categories.join(", ")}`,
      priorityExamples.length
        ? `Bugcrowd VRT priority coverage examples: ${priorityExamples.join(" | ")}`
        : fallbackExamples.length
          ? `Bugcrowd VRT examples to include in coverage planning: ${fallbackExamples.join("; ")}`
          : "",
      "Coverage rule: include P1, P2, P3, and P4 in the VRT coverage ledger; switch to depth mode immediately when any priority produces a plausible reportable lead."
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    return `Bugcrowd VRT file configured but could not be read: ${filePath} (${truncate(error instanceof Error ? error.message : String(error), 120)})`;
  }
}

function priorityVariantExamples(nodes: VrtNode[], priorities: number[], perPriority: number): string[] {
  return priorities
    .map((priority) => {
      const examples = collectVariantExamples(nodes, perPriority, [], (node) => node.priority === priority);
      return examples.length ? `P${priority}: ${examples.join("; ")}` : `P${priority}: no examples found`;
    })
    .filter(Boolean);
}

function collectVariantExamples(
  nodes: VrtNode[],
  limit: number,
  prefix: string[] = [],
  predicate: (node: VrtNode) => boolean = () => true
): string[] {
  const output: string[] = [];
  for (const node of nodes) {
    const path = [...prefix, node.name ?? node.id ?? "unknown"];
    if (node.type === "variant" && predicate(node)) {
      output.push(`${path.join(" > ")}${node.priority ? ` (P${node.priority})` : ""}`);
    }
    if (output.length >= limit) break;
    if (node.children) {
      output.push(...collectVariantExamples(node.children, limit - output.length, path, predicate));
    }
    if (output.length >= limit) break;
  }
  return output;
}
