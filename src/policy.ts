import type { Runbook } from "./types.js";

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
  warnings: string[];
  outOfScopeUrls: string[];
  unscopedUrls: string[];
}

export function evaluateTaskPolicy(runbook: Runbook, prompt: string): PolicyResult {
  const target = runbook.target;
  const urls = uniqueUrls(extractUrls(prompt));
  const result: PolicyResult = {
    allowed: true,
    warnings: [],
    outOfScopeUrls: [],
    unscopedUrls: []
  };

  if (runbook.profile !== "bug-bounty" || !target) return result;

  const inScope = target.scope ?? [];
  const outOfScope = target.out_of_scope ?? [];

  for (const url of urls) {
    if (matchesAny(url, outOfScope)) {
      result.outOfScopeUrls.push(url);
      continue;
    }
    if (inScope.length > 0 && !matchesAny(url, inScope)) {
      result.unscopedUrls.push(url);
    }
  }

  if (result.outOfScopeUrls.length) {
    result.warnings.push(
      `out-of-scope URL이 prompt에 포함됐습니다: ${result.outOfScopeUrls.join(", ")}. ` +
        "worker는 out-of-scope 자산에 직접 요청을 보내지 말고, 보고서 context로만 다루세요."
    );
  }
  if (result.unscopedUrls.length) {
    result.warnings.push(
      `정의된 in-scope에 포함되지 않은 URL이 prompt에 있습니다: ${result.unscopedUrls.join(", ")}. ` +
        "필요하면 사용자에게 추가 in-scope 권한을 확인한 뒤 요청하세요."
    );
  }
  return result;
}

export function applyPolicyWarningsToPrompt(prompt: string, warnings: string[]): string {
  if (!warnings.length) return prompt;
  const banner = ["[huntctl policy] scope 경고:", ...warnings.map((line) => `- ${line}`), ""].join("\n");
  return `${banner}\n${prompt}`;
}

export function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(/https?:\/\/[^\s)"'<>]+/g)).map((match) => match[0].replace(/[),.;]+$/, ""));
}

function uniqueUrls(urls: string[]): string[] {
  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)));
}

function matchesAny(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesScope(url, pattern));
}

function matchesScope(url: string, pattern: string): boolean {
  if (!pattern.startsWith("http://") && !pattern.startsWith("https://")) return false;
  const match = pattern.match(/^(https?:\/\/)([^/?#]+)([/?#].*)?$/i);
  if (!match) return url.startsWith(pattern);
  const [, scheme, hostGlob, suffix] = match;
  const pathGlob = suffix && suffix !== "/" ? suffix : "(?:[/?#].*)?";
  const port = "(?::[0-9]+)?";
  const host = globToRegex(hostGlob);
  const path = suffix && suffix !== "/" ? pathGlobToRegex(pathGlob) : pathGlob;
  return new RegExp(`^${escapeRegex(scheme)}${host}${port}${path}$`, "i").test(url);
}

function globToRegex(value: string): string {
  return value
    .split("*")
    .map(escapeRegex)
    .join("[^/]*");
}

function pathGlobToRegex(value: string): string {
  return value
    .split("*")
    .map(escapeRegex)
    .join(".*");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
