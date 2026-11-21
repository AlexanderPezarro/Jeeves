import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { taskActions, type ActionDeps } from "./actions.js";
import { VERSION } from "./version.js";

export type McpDeps = ActionDeps;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/** Runs a task action, turning a thrown error (unknown task, bad transition) into a tool error. */
const attempt = async (fn: () => Promise<unknown>) => {
  try {
    return json(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
};

/**
 * Builds the MCP server the Jeeves control plane talks to. A fresh server is built per request
 * (stateless HTTP), so this must stay cheap.
 */
export function buildMcpServer(deps: McpDeps): McpServer {
  const { store } = deps;
  const actions = taskActions(deps);
  const server = new McpServer({ name: "jeeves-todo", version: VERSION });

  server.registerTool(
    "list_due_tasks",
    {
      description:
        "List today's chores plus unfinished ones from the last few days, easiest first. " +
        "Each task has an id, effort (1-5), estimated minutes, how-to steps, state and overdue_days.",
      inputSchema: { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => json(actions.listDue(date)),
  );

  server.registerTool(
    "get_chore",
    {
      description: "Full details for one chore, including how-to steps, timer steps and recent history.",
      inputSchema: { chore_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ chore_id }) => {
      const chore = store.getChore(chore_id);
      if (!chore) return fail(`No chore with id ${chore_id}`);
      return json({ ...chore, history: store.history(chore_id) });
    },
  );

  server.registerTool(
    "start_task",
    {
      description:
        "Mark a task as started. Returns the chore's timer steps with absolute due times as `followups`. " +
        "Followups with scheduled: true are already set up as reminders on Jeeves, so do NOT call " +
        "schedule_followup for them; only schedule the ones with scheduled: false.",
      inputSchema: { task_id: z.number().int() },
    },
    async ({ task_id }) => attempt(() => actions.start(task_id)),
  );

  server.registerTool(
    "complete_task",
    { description: "Mark a task as done.", inputSchema: { task_id: z.number().int() } },
    async ({ task_id }) => attempt(() => actions.complete(task_id)),
  );

  server.registerTool(
    "skip_task",
    { description: "Skip a task for today.", inputSchema: { task_id: z.number().int() } },
    async ({ task_id }) => attempt(() => actions.skip(task_id)),
  );

  server.registerTool(
    "snooze_task",
    {
      description:
        "Hide a task from the due list for a number of minutes (defaults to the plugin's default snooze).",
      inputSchema: {
        task_id: z.number().int(),
        minutes: z.number().int().min(1).max(24 * 60).optional(),
      },
    },
    async ({ task_id, minutes }) => attempt(() => actions.snooze(task_id, minutes)),
  );

  return server;
}
