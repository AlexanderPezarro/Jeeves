import { existsSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { choreSchema, seedFromFile, slugify } from "./seed.js";
import { settingsJsonSchema } from "./settings.js";
import { ChoreExistsError, type Chore, type TodoStore } from "./store.js";
import { UI_CSS, UI_HTML, UI_JS } from "./ui.js";
import { VERSION } from "./version.js";

export interface JeevesRoutesOptions {
  store: TodoStore;
  token: string;
  /** chores.yaml used by the "Import from chores.yaml" button. */
  choresFile?: string;
}

export const UI_PATH = "/jeeves/ui";

export const manifest = {
  name: "todo",
  display_name: "Chores",
  version: VERSION,
  settings_schema: settingsJsonSchema,
  ui: { path: UI_PATH, title: "Chores" },
  events: ["task_started", "task_completed"],
  today: true,
};

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
export async function jeevesRoutes(app: FastifyInstance, { store, token, choresFile }: JeevesRoutesOptions) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/manifest", async () => manifest);

  app.get("/settings", async () => store.settings());
  app.put("/settings", async (req, reply) => {
    try {
      return { ok: true, values: store.setSettings(req.body ?? {}) };
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
      return reply.code(201).send({ chore: store.createChore(parsed.data as Chore) });
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
    return { chore };
  };

  const deleteChore = async (req: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const { id } = req.params;
    if (!store.deleteChore(id)) return reply.code(404).send({ error: `No chore with id ${id}` });
    return { ok: true };
  };

  const importChores = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!choresFile || !existsSync(choresFile)) {
      return reply.code(404).send({ error: `No chores file at ${choresFile ?? "(not configured)"}` });
    }
    try {
      return seedFromFile(store, choresFile);
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
