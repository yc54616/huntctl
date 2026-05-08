import blessed from "blessed";
import { readEvents, readState } from "./store.js";
import { askAdvisor, assignWorkerTask, stopTarget } from "./orchestrator.js";
import { truncate } from "./utils.js";
import { getDockerSummary } from "./docker.js";
import { loadRunbook } from "./runbook.js";
import path from "node:path";

export async function runDashboard(runDir: string): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: "huntctl"
  });

  const status = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 5,
    tags: true,
    border: "line",
    label: " Run "
  });

  const agents = blessed.box({
    top: 5,
    left: 0,
    width: "45%",
    height: "55%-5",
    tags: true,
    border: "line",
    label: " Workers ",
    scrollable: true,
    alwaysScroll: true
  });

  const summary = blessed.box({
    top: 5,
    left: "45%",
    width: "55%",
    height: "55%-5",
    tags: true,
    border: "line",
    label: " Advisor Summary ",
    scrollable: true,
    alwaysScroll: true
  });

  const events = blessed.box({
    top: "55%",
    left: 0,
    width: "100%",
    height: "100%-55%-3",
    tags: true,
    border: "line",
    label: " Events ",
    scrollable: true,
    alwaysScroll: true
  });

  const input = blessed.textbox({
    bottom: 0,
    left: 0,
    height: 3,
    width: "100%",
    border: "line",
    label: " Command ",
    inputOnFocus: true
  });

  screen.append(status);
  screen.append(agents);
  screen.append(summary);
  screen.append(events);
  screen.append(input);
  input.focus();

  let dockerMessage = "docker checking...";
  let lastDockerCheck = 0;

  screen.key(["C-c", "q"], () => process.exit(0));
  input.key("enter", async () => {
    const value = input.getValue().trim();
    input.clearValue();
    screen.render();
    if (!value) return;
    await handleCommand(runDir, value);
    await refresh();
    input.focus();
  });

  async function refresh(): Promise<void> {
    try {
      const state = await readState(runDir);
      if (Date.now() - lastDockerCheck > 10000) {
        lastDockerCheck = Date.now();
        loadRunbook(path.join(runDir, "runbook.yml"))
          .then((runbook) => getDockerSummary(runbook))
          .then((summary) => {
            dockerMessage = summary.message;
          })
          .catch((error) => {
            dockerMessage = `docker error: ${error instanceof Error ? error.message : String(error)}`;
          });
      }
      const recent = await readEvents(runDir, 40);
      status.setContent(
        [
          `{bold}${state.runId}{/bold}  ${state.profile}  ${state.status}  sandbox=${state.sandboxMode}`,
          `updated=${state.updatedAt}  advisor=${state.advisor.status} cycles=${state.advisor.cycles}`,
          `docker ${dockerMessage}`
        ].join("\n")
      );
      agents.setContent(
        Object.values(state.agents)
          .map((agent) => {
            const status = agent.id === "advisor" ? state.advisor.status : agent.status;
            const task = agent.currentTaskId ? ` task=${agent.currentTaskId}` : "";
            const message = agent.lastMessage ? `\n  ${truncate(agent.lastMessage.replace(/\s+/g, " "), 180)}` : "";
            return `{bold}${agent.id}{/bold} ${status} role=${agent.role}${task}${message}`;
          })
          .join("\n\n")
      );
      summary.setContent(
        [
          state.advisor.lastSummary || "No advisor summary yet.",
          state.advisor.lastResponse ? `\n{cyan-fg}RESPONSE{/cyan-fg}\n${state.advisor.lastResponse}` : "",
          state.heldTasks.length ? `\n{yellow-fg}HELD{/yellow-fg}\n${state.heldTasks.slice(-8).join("\n")}` : "",
          state.autoActions.length ? `\n{green-fg}AUTO ACTIONS{/green-fg}\n${state.autoActions.slice(-8).join("\n")}` : "",
          visibleErrors(state).length ? `\n{red-fg}ERRORS{/red-fg}\n${visibleErrors(state).slice(-5).join("\n")}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
      events.setContent(
        recent
          .map((event) => {
            const agent = event.agentId ? ` ${event.agentId}` : "";
            const msg = event.message ? ` - ${truncate(event.message.replace(/\s+/g, " "), 140)}` : "";
            return `${event.time} ${event.source}/${event.type}${agent}${msg}`;
          })
          .join("\n")
      );
      screen.render();
    } catch (error) {
      status.setContent(`Dashboard error: ${error instanceof Error ? error.message : String(error)}`);
      screen.render();
    }
  }

  await refresh();
  setInterval(refresh, 2000).unref();
}

function visibleErrors(state: Awaited<ReturnType<typeof readState>>): string[] {
  return state.errors.filter((error) => {
    if (error.startsWith("advisor parse failed:") && state.status === "running") return false;
    if (error.includes("EACCES: permission denied") && /\/codex-home(?:-[^/]+)?\/config\.toml/.test(error)) return false;
    return true;
  });
}

async function handleCommand(runDir: string, value: string): Promise<void> {
  if (value === "/summary") {
    await askAdvisor({ runDir, message: "Refresh the current summary and next actions." });
    return;
  }
  if (value.startsWith("/stop ")) {
    await stopTarget({ runDir, target: value.slice("/stop ".length).trim() });
    return;
  }
  if (value.startsWith("/assign ")) {
    const rest = value.slice("/assign ".length).trim();
    const [agentId, ...message] = rest.split(/\s+/);
    if (!agentId || message.length === 0) return;
    await assignWorkerTask({ runDir, agentId, prompt: message.join(" "), source: "user" });
    return;
  }
  await askAdvisor({ runDir, message: value });
}
