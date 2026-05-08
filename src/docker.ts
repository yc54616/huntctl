import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Runbook } from "./types.js";
import { commandExists, truncate } from "./utils.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_WORKER_IMAGE = "huntctl-worker:full-next";
export const PREVIOUS_WORKER_IMAGE = "huntctl-worker:latest";
export const LEGACY_WORKER_IMAGE = "ctf-sandbox:latest";
export const WORKER_IMAGE_CANDIDATES = [DEFAULT_WORKER_IMAGE, PREVIOUS_WORKER_IMAGE, LEGACY_WORKER_IMAGE] as const;

export interface DockerSummary {
  installed: boolean;
  image?: string;
  imagePresent?: boolean;
  codexAuth: "host-config-copy" | "env" | "missing";
  message: string;
}

export async function getDockerSummary(runbook?: Pick<Runbook, "sandbox">): Promise<DockerSummary> {
  const installed = await commandExists("docker");
  const image = runbook?.sandbox.image;
  const codexAuth = detectCodexAuth();
  if (!installed) {
    return {
      installed: false,
      image,
      codexAuth,
      message: "docker 미설치"
    };
  }

  const imagePresent = image ? await hasDockerImage(image) : undefined;
  const pieces = [
    "docker 설치됨",
    image ? `image=${image}` : "image=미지정",
    image ? `image-status=${imagePresent ? "있음" : "없음"}` : "",
    `codex 인증=${codexAuthKo(codexAuth)}`
  ].filter(Boolean);

  return {
    installed,
    image,
    imagePresent,
    codexAuth,
    message: pieces.join(" ")
  };
}

export async function hasDockerImage(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", image], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function detectCodexAuth(): DockerSummary["codexAuth"] {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_AGENT_IDENTITY) return "env";
  return existsSync(path.join(os.homedir(), ".codex")) ? "host-config-copy" : "missing";
}

function codexAuthKo(value: DockerSummary["codexAuth"]): string {
  const map: Record<DockerSummary["codexAuth"], string> = {
    "host-config-copy": "호스트 ~/.codex 복사",
    env: "환경변수",
    missing: "없음"
  };
  return map[value];
}

export async function assertDockerImage(image: string): Promise<void> {
  if (!(await commandExists("docker"))) {
    throw new Error("Docker is required for --sandbox docker. Install Docker or use --sandbox host.");
  }
  if (!(await hasDockerImage(image))) {
    throw new Error(`Docker image not found: ${image}. Build/pull it or pass --image <image>.`);
  }
}

export function dockerErrorMessage(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 500);
}

export async function buildWorkerImage(options: { image?: string; dockerfile?: string; context?: string; audit?: boolean } = {}): Promise<void> {
  const image = options.image ?? DEFAULT_WORKER_IMAGE;
  const dockerfile = options.dockerfile ?? "sandbox/Dockerfile.sandbox";
  const context = options.context ?? ".";
  await runInherited("docker", ["build", "--progress=plain", "-f", dockerfile, "-t", image, context], {
    DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT ?? "1"
  });
  if (options.audit === false) return;
  await runInherited("docker", ["run", "--rm", image, "bash", "-lc", "ctf-tool-audit && ctf-mcp-configure >/tmp/ctf-mcp-configure.log && ctf-mcp-doctor"]);
}

function runInherited(command: string, args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
