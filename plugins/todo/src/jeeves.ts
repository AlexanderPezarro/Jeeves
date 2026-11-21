import { existsSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { TaskActions } from "./actions.js";
import type { ReminderScheduler } from "./reminders.js";
import { choreSchema, seedFromFile, slugify } from "./seed.js";
import { settingsJsonSchema } from "./settings.js";
import { ChoreExistsError, type Chore, type DueTask, type TodoStore } from "./store.js";
import { UI_CSS, UI_HTML, UI_JS } from "./ui.js";
import { VERSION } from "./version.js";

export interface JeevesRoutesOptions {
  store: TodoStore;
  token: string;
  /** chores.yaml used by the "Import from chores.yaml" button. */
  choresFile?: string;
  /** Re-synced after settings and chore changes. */
  reminders?: ReminderScheduler;
  /** Task actions for the Today view's and notifications' buttons (same side effects as the MCP tools). */
  actions: TaskActions;
}

export const UI_PATH = "/jeeves/ui";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

/** A task instance as the tools return it. */
const taskSchema = {
  type: "object",
  properties: {
    id: int("Task id, for start/complete/skip/snooze"),
    chore_id: str("Chore id"),
    due_date: str("YYYY-MM-DD"),
    state: { type: "string", enum: ["pending", "started", "done", "skipped"] },
    started_at: str("When it was started (ISO time)"),
    done_at: str("When it was finished (ISO time)"),
    snoozed_until: str("Hidden from the due list until (ISO time)"),
  },
};

const dueTaskSchema = {
  type: "object",
  properties: {
    ...taskSchema.properties,
    name: str("Chore name"),
    effort: int("1 (trivial) to 5 (hard)"),
    est_minutes: int("Estimated minutes"),
    how_to: { type: "array", items: { type: "string" }, description: "How-to steps" },
    overdue_days: int("Days past its due date"),
  },
};

const taskEventPayload = {
  type: "object",
  properties: { task_id: int("Task id"), chore_id: str("Chore id"), name: str("Chore name") },
};

export const manifest = {
  name: "todo",
  display_name: "Chores",
  version: VERSION,
  settings_schema: settingsJsonSchema,
  ui: { path: UI_PATH, title: "Chores" },
  events: [
    { type: "task_started", title: "Chore started", description: "A chore was started (timed chores begin their timer).", payload_schema: taskEventPayload },
    { type: "task_completed", title: "Chore done", description: "A chore was marked done.", payload_schema: taskEventPayload },
  ],
  // Every MCP tool is a workflow step; these give them names and describe what they return.
  steps: {
    list_due_tasks: { title: "List due chores", output_schema: { type: "array", items: dueTaskSchema } },
    get_chore: { title: "Get a chore" },
    start_task: {
      title: "Start a chore",
      output_schema: {
        type: "object",
        properties: {
          task: taskSchema,
          followups: { type: "array", items: { type: "object", properties: { at: str("ISO time"), message: str("Reminder text") } } },
        },
      },
    },
    complete_task: { title: "Mark a chore done", output_schema: taskSchema },
    skip_task: { title: "Skip a chore today", output_schema: taskSchema },
    snooze_task: { title: "Snooze a chore", output_schema: taskSchema },
  },
  // Added to Claude's system prompt whenever this plugin's tools are offered.
  instructions: [
    "This plugin owns the user's chores and tasks. Task ids are numbers; when a message item is a task,",
    'set plugin to "todo" and item_id to the task id as a string, so the phone shows Done / Snooze / Skip.',
    "When asked for a plan or to-do list: look at the due tasks, then send one message listing them easiest",
    "first so the user builds momentum. Leave out anything that won't fit the time they have. Give each item",
    "2-4 concrete steps from the chore's how-to notes. Mention overdue tasks gently. If nothing is due, say so",
    "briefly instead of inventing work.",
    "Starting a timed chore schedules its follow-up reminders automatically; don't schedule them again.",
  ].join("\n"),
  // Lists the app shows (GET /jeeves/views/<id>); each item carries its own buttons.
  views: [{ id: "today", title: "Today", empty_text: "Nothing due. Enjoy your evening." }],
  // Buttons on notifications about one of this plugin's items (POST /jeeves/actions).
  item_actions: [
    { id: "done", label: "Done", style: "primary" },
    { id: "snooze", label: "Snooze 15 min", args: { minutes: 15 } },
    { id: "skip", label: "Skip", style: "text" },
  ],
};

/** A due task as a generic view item: Start / Done / Skip until it is finished. */
export function taskItem(t: DueTask) {
  const finished = t.state === "done" || t.state === "skipped";
  const note =
    t.state === "done"
      ? "Done"
      : t.state === "skipped"
        ? "Skipped"
        : t.state === "started"
          ? "In progress"
          : t.overdue_days > 0
            ? `Overdue by ${t.overdue_days} day${t.overdue_days > 1 ? "s" : ""}`
            : null;
  return {
    id: String(t.id),
    title: t.name,
    meta: `${t.est_minutes} min · ${"●".repeat(t.effort)}`,
    note,
    detail: t.how_to,
    finished,
    actions: finished
      ? []
      : [
          ...(t.state === "started" ? [] : [{ id: "start", label: "Start", style: "secondary" }]),
          { id: "done", label: "Done", style: "primary" },
          { id: "skip", label: "Skip", style: "text" },
        ],
  };
}

const actionBody = z.object({
  item: z.string().regex(/^\d+$/, "a task id"),
  action: z.enum(["start", "done", "skip", "snooze"]),
  args: z.object({ minutes: z.number().int().min(1).max(24 * 60).optional() }).default({}),
});

type IdParams = { Params: { id: string } };

function badRequest(reply: FastifyReply, e: ZodError) {
  return reply.code(400).send({
    error: "invalid request",
    issues: e.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
  });
}

/**
 * Everything Jeeves talks to besides MCP: the manifest, settings, and the chore manager UI with its
 * JSON API. Registered under /jeeves and guarded by the same bearer token as /mcp.
 */
export async function jeevesRoutes(app: FastifyInstance, { store, token, choresFile, reminders, actions }: JeevesRoutesOptions) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/manifest", async () => manifest);

  app.get("/views/:id", async (req, reply) => {
    if ((req.params as { id: string }).id !== "today") return reply.code(404).send({ error: "no such view" });
    return { items: actions.listDue().map(taskItem) };
  });

  /** A button tap in the app. `resolved` tells Jeeves the item is finished, so it drops follow-ups about it. */
  app.post("/actions", async (req, reply) => {
    const body = actionBody.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const { item, action, args } = body.data;
    const id = Number(item);
    try {
      if (action === "start") {
        const { task } = await actions.start(id);
        return { ok: true, resolved: false, message: `Started ${store.getChore(task.chore_id)?.name ?? "it"}` };
      }
      if (action === "snooze") {
        await actions.snooze(id, args.minutes);
        return { ok: true, resolved: false };
      }
      await (action === "done" ? actions.complete(id) : actions.skip(id));
      return { ok: true, resolved: true };
    } catch (e) {
      return reply.code(/no task/i.test((e as Error).message) ? 404 : 409).send({ error: (e as Error).message });
    }
  });

  app.get("/settings", async () => store.settings());
  app.put("/settings", async (req, reply) => {
    try {
      const values = store.setSettings(req.body ?? {});
      await reminders?.sync();
      return { ok: true, values };
    } catch (e) {
      if (e instanceof ZodError) return badRequest(reply, e);
      throw e;
    }
  });

  // --- Chore handlers, shared by the UI's GET/POST API and the REST form. ---

  const listChores = async () => ({ chores: store.listChores() });

  const createChore = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const withId =
      typeof body === "object" && body.id === undefined && typeof body.name === "string"
        ? { ...body, id: slugify(body.name) }
        : body;
    const parsed = choreSchema.safeParse(withId);
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const chore = store.createChore(parsed.data as Chore);
      await reminders?.sync();
      return reply.code(201).send({ chore });
    } catch (e) {
      if (e instanceof ChoreExistsError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  };

  const updateChore = async (req: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const { id } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.id !== undefined && body.id !== id) {
      return reply.code(400).send({ error: "a chore's id can't be changed; delete it and add a new one" });
    }
    const parsed = choreSchema.safeParse({ ...body, id });
    if (!parsed.success) return badRequest(reply, parsed.error);
    const chore = store.updateChore(parsed.data as Chore);
    if (!chore) return reply.code(404).send({ error: `No chore with id ${id}` });
    await reminders?.sync();
    return { chore };
  };

  const deleteChore = async (req: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const { id } = req.params;
    if (!store.deleteChore(id)) return reply.code(404).send({ error: `No chore with id ${id}` });
    await reminders?.sync();
    return { ok: true };
  };

  const importChores = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!choresFile || !existsSync(choresFile)) {
      return reply.code(404).send({ error: `No chores file at ${choresFile ?? "(not configured)"}` });
    }
    try {
      const result = seedFromFile(store, choresFile);
      await reminders?.sync();
      return result;
    } catch (e) {
      if (e instanceof ZodError) return badRequest(reply, e);
      return reply.code(400).send({ error: `Could not read ${choresFile}: ${(e as Error).message}` });
    }
  };

  // --- Chore manager UI. Jeeves proxies only GET/POST under /jeeves/ui/, so the page's API lives here. ---

  // Relative redirect so it also works behind Jeeves' proxy prefix.
  app.get("/ui", async (_req, reply) => reply.redirect("ui/"));
  app.get("/ui/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(UI_HTML));
  app.get("/ui/app.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(UI_JS));
  app.get("/ui/app.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(UI_CSS));

  app.get("/ui/api/chores", listChores);
  app.post("/ui/api/chores", createChore);
  app.post<IdParams>("/ui/api/chores/:id", updateChore);
  app.post<IdParams>("/ui/api/chores/:id/delete", deleteChore);
  app.post("/ui/api/import", importChores);

  // --- REST form for direct use. ---

  app.get("/api/chores", listChores);
  app.post("/api/chores", createChore);
  app.put<IdParams>("/api/chores/:id", updateChore);
  app.delete<IdParams>("/api/chores/:id", deleteChore);
  app.post("/api/import", importChores);
}
