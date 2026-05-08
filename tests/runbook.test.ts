import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadRunbook } from "../src/runbook.js";
import { evaluateTaskPolicy } from "../src/policy.js";
import { assignWorkerTask, runAdvisorLoop, startInteractiveSession, startRun } from "../src/orchestrator.js";
import { latestRunId, readState, runDirFor } from "../src/store.js";
import { buildAdvisorPrompt, buildInitialTaskPrompt, buildWorkerPrompt, parseAdvisorDecision } from "../src/prompts.js";
import { reasoningEffortForAgent } from "../src/reasoning.js";
import { pathExists } from "../src/utils.js";
import type { RunState, Runbook } from "../src/types.js";

async function writeRunbook(value: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huntctl-test-"));
  const file = path.join(dir, "runbook.yml");
  await writeFile(file, value, "utf8");
  return file;
}

describe("runbook validation", () => {
  it("accepts ctf runbooks with challenge input", async () => {
    const file = await writeRunbook(`
profile: ctf
challenge:
  name: baby
  description: solve it
    `);
    const runbook = await loadRunbook(file);
    assert.equal(runbook.profile, "ctf");
    assert.equal(runbook.agents.some((agent) => agent.role === "advisor"), true);
  });

  it("accepts bug bounty runbooks without scope", async () => {
    const file = await writeRunbook(`
profile: bug-bounty
target:
  name: example
  scope: []
`);
    const runbook = await loadRunbook(file);
    assert.equal(runbook.profile, "bug-bounty");
    assert.equal(runbook.target?.scope.length, 0);
  });

  it("accepts direct Docker sandbox configuration", async () => {
    const file = await writeRunbook(`
profile: ctf
sandbox:
  mode: docker
  image: ctf-sandbox:latest
challenge:
  name: baby
  description: solve it
`);
    const runbook = await loadRunbook(file);
    assert.equal(runbook.sandbox.mode, "docker");
    assert.equal(runbook.sandbox.image, "ctf-sandbox:latest");
  });

  it("maps direct investigation workers to xhigh reasoning by default", () => {
    assert.equal(reasoningEffortForAgent({ id: "advisor", role: "advisor" }), "low");
    assert.equal(reasoningEffortForAgent({ id: "recon-1", role: "recon" }), "xhigh");
    assert.equal(reasoningEffortForAgent({ id: "solver-1", role: "solver" }), "xhigh");
    assert.equal(reasoningEffortForAgent({ id: "validator-1", role: "validator" }), "xhigh");
    assert.equal(reasoningEffortForAgent({ id: "reporter-1", role: "report-writer" }), "medium");
    assert.equal(reasoningEffortForAgent({ id: "custom-1", role: "custom", reasoning_effort: "xhigh" }), "xhigh");
  });
});

describe("policy guard", () => {
  it("does not hard-block out-of-scope bug bounty URLs", async () => {
    const file = await writeRunbook(`
profile: bug-bounty
target:
  name: example
  scope:
    - https://app.example.com
  out_of_scope:
    - https://admin.example.com
program:
  rules:
    destructive_testing: false
`);
    const runbook = await loadRunbook(file);
    assert.equal(evaluateTaskPolicy(runbook, "check https://admin.example.com/debug").allowed, true);
  });

  it("treats scope patterns as context instead of hard blockers", async () => {
    const file = await writeRunbook(`
profile: bug-bounty
target:
  name: example
  scope:
    - https://*.example.com
  out_of_scope:
    - https://*.example.com/blog*
program:
  rules:
    destructive_testing: false
`);
    const runbook = await loadRunbook(file);
    assert.equal(evaluateTaskPolicy(runbook, "check https://www.example.com/account safely").allowed, true);
    assert.equal(evaluateTaskPolicy(runbook, "check https://www.example.com/blog/post").allowed, true);
    assert.equal(evaluateTaskPolicy(runbook, "check https://other.example.net").allowed, true);
  });

  it("does not hard-block high-risk wording inside allowed task prompts", async () => {
    const file = await writeRunbook(`
profile: bug-bounty
target:
  name: example
  scope:
    - https://app.example.com
program:
  rules:
    destructive_testing: false
`);
    const runbook = await loadRunbook(file);
    assert.equal(evaluateTaskPolicy(runbook, "Review https://app.example.com only. Do not brute force or DoS.").allowed, true);
    assert.equal(evaluateTaskPolicy(runbook, "reproduce login rate limit behavior on https://app.example.com/login").allowed, true);
    assert.equal(evaluateTaskPolicy(runbook, "brute force https://app.example.com/login").allowed, true);
  });

  it("allows CTF task prompts", async () => {
    const file = await writeRunbook(`
profile: ctf
challenge:
  name: baby
  description: local challenge
`);
    const runbook = await loadRunbook(file);
    assert.equal(evaluateTaskPolicy(runbook, "analyze local files").allowed, true);
  });
});

describe("orchestration lifecycle", () => {
  it("completes a foreground mock CTF run", async () => {
    const previous = process.env.HUNTCTL_FAKE_CODEX;
    process.env.HUNTCTL_FAKE_CODEX = "1";
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "huntctl-life-"));
      const file = path.join(dir, "runbook.yml");
      await writeFile(
        file,
        `
profile: ctf
challenge:
  name: baby
  description: local challenge
advisor:
  mode: manual
agents:
  - id: advisor
    role: advisor
  - id: triage-1
    role: file-triage
`,
        "utf8"
      );

      const { runDir } = await startRun({
        runbookPath: file,
        workspace: dir,
        sandboxMode: "host",
        foreground: true
      });
      const state = await readState(runDir);
      assert.equal(state.status, "completed");
      assert.equal(state.agents["triage-1"].status, "done");
    } finally {
      if (previous === undefined) {
        delete process.env.HUNTCTL_FAKE_CODEX;
      } else {
        process.env.HUNTCTL_FAKE_CODEX = previous;
      }
    }
  });

  it("keeps an interactive run alive after a worker becomes idle", async () => {
    const previous = process.env.HUNTCTL_FAKE_CODEX;
    process.env.HUNTCTL_FAKE_CODEX = "1";
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "huntctl-interactive-"));
      const { runDir } = await startInteractiveSession({
        profile: "ctf",
        workers: 1,
        sandboxMode: "host",
        workspace: dir,
        description: "local challenge"
      });
      await assignWorkerTask({
        runDir,
        agentId: "file-triage-1",
        prompt: "analyze local challenge files",
        source: "user"
      });

      let state = await readState(runDir);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        state = await readState(runDir);
        if (Object.values(state.tasks).every((task) => ["done", "failed", "blocked", "stopped"].includes(task.status))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.equal(state.status, "running");
      assert.equal(state.agents["file-triage-1"].status, "done");
    } finally {
      if (previous === undefined) {
        delete process.env.HUNTCTL_FAKE_CODEX;
      } else {
        process.env.HUNTCTL_FAKE_CODEX = previous;
      }
    }
  });

  it("creates an isolated target workspace for interactive sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "huntctl-target-workspace-"));
    const { runId, runDir } = await startInteractiveSession({
      profile: "bug-bounty",
      workers: 1,
      sandboxMode: "host",
      workspace: dir,
      targetName: "Acme Example",
      scope: ["https://app.example.com"]
    });

    const state = await readState(runDir);
    assert.equal(state.workspace.startsWith(path.join(dir, "targets", "acme-example-")), true);
    assert.equal(state.runId, runId);
    assert.equal(await pathExists(path.join(state.workspace, "evidence")), true);
    assert.equal(await pathExists(path.join(state.workspace, "notes")), true);
    assert.equal(await pathExists(path.join(state.workspace, `huntctl-session-${runId}.md`)), true);
    assert.equal((await loadRunbook(path.join(runDir, "runbook.yml"))).evidence_dir, "evidence");
    assert.equal(await latestRunId(dir), runId);
    assert.equal((await readState(runDirFor(runId, dir))).workspace, state.workspace);
  });

  it("auto-assigns idle interactive bug bounty workers when advisor returns no tasks", async () => {
    const previous = process.env.HUNTCTL_FAKE_CODEX;
    process.env.HUNTCTL_FAKE_CODEX = "1";
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "huntctl-auto-bounty-"));
      const { runDir } = await startInteractiveSession({
        profile: "bug-bounty",
        workers: 2,
        sandboxMode: "host",
        workspace: dir,
        scope: ["https://app.example.com"],
        outOfScope: ["https://help.example.com"],
        description: "authorized test program"
      });

      await runAdvisorLoop({ runDir, once: true });

      const state = await readState(runDir);
      const advisorTasks = Object.values(state.tasks).filter((task) => task.source === "advisor");
      assert.equal(advisorTasks.length > 0, true);
      assert.equal(advisorTasks.some((task) => task.agentId === "recon-1" || task.agentId === "validator-2"), true);
      assert.equal(advisorTasks.some((task) => task.prompt.includes("이번 작업 lane")), true);
      assert.equal(advisorTasks.some((task) => task.prompt.includes("candidate ledger")), true);
      assert.equal(advisorTasks.some((task) => task.prompt.includes("Decision: report-ready | keep | blocked | reject | pivot-adjacent | rotate-lane")), true);
      assert.equal(state.status, "running");
    } finally {
      if (previous === undefined) {
        delete process.env.HUNTCTL_FAKE_CODEX;
      } else {
        process.env.HUNTCTL_FAKE_CODEX = previous;
      }
    }
  });

  it("continues automatic worker assignment when configured Docker image is missing", async () => {
    const previous = process.env.HUNTCTL_FAKE_CODEX;
    process.env.HUNTCTL_FAKE_CODEX = "1";
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "huntctl-docker-hold-"));
      const { runDir } = await startInteractiveSession({
        profile: "bug-bounty",
        workers: 1,
        sandboxMode: "docker",
        dockerImage: "huntctl-missing-test-image:latest",
        workspace: dir,
        scope: ["https://app.example.com"],
        description: "authorized test program"
      });

      await runAdvisorLoop({ runDir, once: true });

      const state = await readState(runDir);
      assert.equal(Object.values(state.tasks).length > 0, true);
      assert.equal(state.heldTasks.some((task) => task.includes("Docker worker image")), false);
    } finally {
      if (previous === undefined) {
        delete process.env.HUNTCTL_FAKE_CODEX;
      } else {
        process.env.HUNTCTL_FAKE_CODEX = previous;
      }
    }
  });
});

describe("advisor parsing", () => {
  it("does not treat arbitrary braces as advisor JSON", () => {
    assert.throws(() => parseAdvisorDecision("Use curl {id} carefully"), /JSON object/);
  });

  it("parses fenced advisor JSON", () => {
    const parsed = parseAdvisorDecision(`
\`\`\`json
{"response":"ok","summary":"ready","next_tasks":[],"held_tasks":[],"auto_actions":[]}
\`\`\`
`);
    assert.equal(parsed.response, "ok");
    assert.equal(parsed.summary, "ready");
  });
});

describe("prompt caching layout", () => {
  it("keeps advisor volatile state after the cacheable prefix", async () => {
    const runbook: Runbook = {
      profile: "bug-bounty",
      interactive: true,
      danger: true,
      target: {
        name: "example",
        scope: ["https://app.example.com"],
        out_of_scope: []
      },
      program: {
        description: "authorized",
        platform: "custom",
        vrt: [],
        weaknesses: [],
        rules: {}
      },
      advisor: {
        mode: "manual",
        interval_seconds: 45,
        can_assign_workers: true,
        can_stop_workers: true
      },
      limits: {
        max_parallel_agents: 2,
        timeout_minutes: 45,
        rate_limit: "conservative"
      },
      agents: [
        { id: "advisor", role: "advisor" },
        { id: "recon-1", role: "recon" }
      ],
      evidence_dir: ".huntctl/evidence",
      sandbox: {
        mode: "host"
      }
    };
    const state: RunState = {
      runId: "bb-test",
      profile: "bug-bounty",
      status: "running",
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:01:00.000Z",
      runbookPath: "/tmp/interactive",
      workspace: "/tmp/work",
      sandboxMode: "host",
      danger: true,
      agents: {
        advisor: { id: "advisor", role: "advisor", status: "running", taskCount: 0 },
        "recon-1": { id: "recon-1", role: "recon", status: "done", taskCount: 1, lastMessage: "x".repeat(5000) }
      },
      tasks: {
        t1: {
          id: "t1",
          agentId: "recon-1",
          role: "recon",
          source: "advisor",
          status: "done",
          prompt: "scan ".repeat(2000),
          lastMessage: "result ".repeat(2000)
        }
      },
      advisor: {
        status: "running",
        cycles: 2,
        lastResponse: "response ".repeat(1000)
      },
      findings: [],
      heldTasks: [],
      autoActions: [],
      errors: []
    };

    const prompt = await buildAdvisorPrompt({ runbook, state, recentEvents: "recent event" });
    assert.equal(prompt.includes("huntctl cacheable advisor prompt prefix v2"), true);
    assert.equal(prompt.indexOf("Return only JSON with this exact shape:") < prompt.indexOf("Volatile run data begins below."), true);
    assert.equal(prompt.includes("x".repeat(1000)), false);
    assert.equal(prompt.includes("scan ".repeat(500)), false);
  });

  it("uses different search strategy for CTF and bug bounty", async () => {
    const ctfRunbook: Runbook = {
      profile: "ctf",
      challenge: {
        name: "baby",
        description: "local challenge",
        files: ["baby.zip"]
      },
      advisor: {
        mode: "manual",
        interval_seconds: 45,
        can_assign_workers: true,
        can_stop_workers: true
      },
      limits: {
        max_parallel_agents: 2,
        timeout_minutes: 45
      },
      agents: [
        { id: "advisor", role: "advisor" },
        { id: "solver-1", role: "solver" }
      ],
      evidence_dir: ".huntctl/evidence",
      sandbox: {
        mode: "host"
      }
    };
    const bountyRunbook: Runbook = {
      profile: "bug-bounty",
      target: {
        name: "example",
        scope: ["https://app.example.com"],
        out_of_scope: []
      },
      program: {
        description: "authorized",
        platform: "custom",
        vrt: [],
        weaknesses: [],
        rules: {}
      },
      advisor: {
        mode: "manual",
        interval_seconds: 45,
        can_assign_workers: true,
        can_stop_workers: true
      },
      limits: {
        max_parallel_agents: 2,
        timeout_minutes: 45
      },
      agents: [
        { id: "advisor", role: "advisor" },
        { id: "validator-1", role: "validator" }
      ],
      evidence_dir: ".huntctl/evidence",
      sandbox: {
        mode: "host"
      }
    };

    const ctfPrompt = await buildWorkerPrompt({
      runbook: ctfRunbook,
      agent: { id: "solver-1", role: "solver" },
      taskPrompt: buildInitialTaskPrompt(ctfRunbook, { id: "solver-1", role: "solver" })
    });
    const bountyPrompt = await buildWorkerPrompt({
      runbook: bountyRunbook,
      agent: { id: "validator-1", role: "validator" },
      taskPrompt: buildInitialTaskPrompt(bountyRunbook, { id: "validator-1", role: "validator" })
    });

    assert.match(ctfPrompt, /known answer/i);
    assert.match(ctfPrompt, /pivot/i);
    assert.match(ctfPrompt, /Decision: solved \| continue \| pivot \| blocked/i);
    assert.match(bountyPrompt, /deep-dive/i);
    assert.match(bountyPrompt, /Do not pivot just because the first request is inconclusive/i);
    assert.match(bountyPrompt, /candidate ledger/i);
    assert.match(bountyPrompt, /depth budget/i);
    assert.match(bountyPrompt, /lane rotation/i);
    assert.match(bountyPrompt, /Decision: report-ready \| keep \| blocked \| reject \| pivot-adjacent \| rotate-lane/i);
    assert.match(bountyPrompt, /blocked.*user-provided authorization/i);
  });

  it("keeps report templates out of recon prompts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "huntctl-prompt-diet-"));
    const templatePath = path.join(dir, "report-template.md");
    await writeFile(templatePath, "UNIQUE_REPORT_TEMPLATE_SENTINEL\n## Steps to Reproduce", "utf8");
    const runbook: Runbook = {
      profile: "bug-bounty",
      target: {
        name: "example",
        scope: Array.from({ length: 50 }, (_, index) => `https://asset-${index}.example.com`),
        out_of_scope: []
      },
      program: {
        description: "authorized",
        platform: "hackerone",
        report_template: templatePath,
        vrt: [],
        weaknesses: ["CWE-79"],
        rules: {}
      },
      advisor: {
        mode: "manual",
        interval_seconds: 45,
        can_assign_workers: true,
        can_stop_workers: true
      },
      limits: {
        max_parallel_agents: 2,
        timeout_minutes: 45
      },
      agents: [
        { id: "advisor", role: "advisor" },
        { id: "recon-1", role: "recon" },
        { id: "report-writer-1", role: "report-writer" }
      ],
      evidence_dir: ".huntctl/evidence",
      sandbox: {
        mode: "host"
      }
    };

    const reconPrompt = await buildWorkerPrompt({
      runbook,
      agent: { id: "recon-1", role: "recon" },
      taskPrompt: "map candidate endpoints",
      runbookPath: path.join(dir, "runbook.yml")
    });
    const reportPrompt = await buildWorkerPrompt({
      runbook,
      agent: { id: "report-writer-1", role: "report-writer" },
      taskPrompt: "prepare report draft",
      runbookPath: path.join(dir, "runbook.yml")
    });

    assert.equal(reconPrompt.includes("UNIQUE_REPORT_TEMPLATE_SENTINEL"), false);
    assert.match(reconPrompt, /report-template\.md/);
    assert.match(reconPrompt, /\.\.\. \+30 more in runbook/);
    assert.match(reportPrompt, /UNIQUE_REPORT_TEMPLATE_SENTINEL/);
  });
});
