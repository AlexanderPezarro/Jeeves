import { Ajv, type ErrorObject } from "ajv";
import { z } from "zod";

/**
 * The optional plugin contract beyond MCP tools: `GET <base>/jeeves/manifest` describes settings,
 * a UI page, the events the plugin posts to /plugin-events, and whether it serves the Today list.
 * A plugin without one (404 or invalid) is a tools-only plugin and still works.
 */
const eventName = z.string().regex(/^[a-z0-9_.-]+$/);
const ID = /^[a-z0-9_.-]{1,64}$/;

/** A button on an item: the app posts `{item, action: id, args}` to the plugin when it is tapped. */
export const itemActionSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().min(1).max(40),
  style: z.enum(["primary", "secondary", "text"]).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

/** One row of a plugin view. `actions` are this item's buttons right now (they can depend on its state). */
export const viewItemSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string(),
  /** Short right-hand text, e.g. "10 min". */
  meta: z.string().nullable().optional(),
  /** A status line under the title, e.g. "Overdue by 2 days". */
  note: z.string().nullable().optional(),
  /** Shown when the item is expanded. */
  detail: z.array(z.string()).default([]),
  /** Finished items are greyed out. */
  finished: z.boolean().default(false),
  actions: z.array(itemActionSchema).max(4).default([]),
});
export type ViewItem = z.output<typeof viewItemSchema>;
const jsonSchema = z.record(z.string(), z.unknown());

/** An event the plugin posts, with what the workflow editor shows for it. */
export interface EventInfo {
  type: string;
  title: string | null;
  description: string | null;
  /** JSON Schema of the payload: its properties are the `event.<field>` paths conditions and templates can use. */
  payload_schema: Record<string, unknown> | null;
}

export const manifestSchema = z
  .object({
    name: z.string(),
    display_name: z.string(),
    version: z.string(),
    settings_schema: jsonSchema.nullable().optional(),
    ui: z.object({ path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/, "an absolute path"), title: z.string() }).nullable().optional(),
    /** Plain names, or objects describing the event and its payload. */
    events: z
      .array(
        z.union([
          eventName,
          z.object({ type: eventName, title: z.string().optional(), description: z.string().optional(), payload_schema: jsonSchema.optional() }),
        ]),
      )
      .default([]),
    /**
     * Workflow steps are the plugin's MCP tools. Per tool name, optionally: a friendlier `title` (else
     * the MCP tool title) and the JSON Schema of its result (`output_schema`), whose fields later steps
     * can use as `steps.<id>.<field>`.
     */
    steps: z.record(z.string(), z.object({ title: z.string().optional(), output_schema: jsonSchema.optional() })).default({}),
    /** Lists the app shows (e.g. "Today"), served at `GET <base>/jeeves/views/<id>` as `{items: ViewItem[]}`. */
    views: z.array(z.object({ id: z.string().regex(ID), title: z.string(), empty_text: z.string().optional() })).default([]),
    /** Buttons on notifications about one of this plugin's items; tapped ones go to `POST <base>/jeeves/actions`. */
    item_actions: z.array(itemActionSchema).max(3).default([]),
  })
  .transform(({ events, ...m }) => {
    const event_info: EventInfo[] = events.map((e) =>
      typeof e === "string"
        ? { type: e, title: null, description: null, payload_schema: null }
        : { type: e.type, title: e.title ?? null, description: e.description ?? null, payload_schema: e.payload_schema ?? null },
    );
    // `events` stays a list of names for older clients; the details are in `event_info`.
    return { ...m, events: event_info.map((e) => e.type), event_info };
  });

export type Manifest = z.output<typeof manifestSchema>;
/** What a plugin serves at GET /jeeves/manifest (before normalising). */
export type ManifestInput = z.input<typeof manifestSchema>;

/** A plugin's base URL: its MCP URL without the trailing /mcp. */
export function pluginBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/mcp$/, "");
}

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; format?: string; items?: JsonSchema; [k: string]: unknown };

/** Property names whose schema says `format: "secret"` (top level only, like the UIs render). */
export function secretKeys(schema: Record<string, unknown> | null | undefined): string[] {
  const props = ((schema as JsonSchema | null)?.properties ?? {}) as Record<string, JsonSchema>;
  return Object.entries(props)
    .filter(([, p]) => p?.format === "secret")
    .map(([k]) => k);
}

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat("secret", () => true);

/**
 * Validates stored settings values against a plugin's JSON Schema. Secret fields must be stored
 * as `{env: "VAR_NAME"}` (never a literal); they are checked against the schema as a placeholder.
 */
export function validateSettings(schema: Record<string, unknown> | null | undefined, values: Record<string, unknown>): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const secrets = secretKeys(schema);
  const probe: Record<string, unknown> = { ...values };
  for (const key of secrets) {
    if (!(key in values) || values[key] === null) {
      delete probe[key];
      continue;
    }
    const v = values[key] as { env?: unknown } | null;
    if (!v || typeof v !== "object" || typeof v.env !== "string" || !ENV_NAME.test(v.env) || Object.keys(v).length !== 1) {
      issues.push({ path: [key], message: 'secrets are stored as {env: "VAR_NAME"}; put the value itself in .env' });
      delete probe[key];
    } else {
      probe[key] = "secret";
    }
  }
  if (!schema) return issues;
  const validate = ajv.compile(schema);
  if (!validate(probe)) {
    for (const e of validate.errors ?? []) issues.push({ path: errorPath(e), message: e.message ?? "invalid" });
  }
  return issues;
}

function errorPath(e: ErrorObject): (string | number)[] {
  const parts = e.instancePath
    .split("/")
    .slice(1)
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p.replace(/~1/g, "/").replace(/~0/g, "~")));
  if (e.keyword === "required" || e.keyword === "additionalProperties") {
    const prop = (e.params as { missingProperty?: string; additionalProperty?: string }).missingProperty ?? (e.params as { additionalProperty?: string }).additionalProperty;
    if (prop) parts.push(prop);
  }
  return parts;
}

/** Replaces `{env: NAME}` secret references with the environment's values, for pushing to the plugin. */
export function resolveSecrets(schema: Record<string, unknown> | null | undefined, values: Record<string, unknown>, env: NodeJS.ProcessEnv): { values: Record<string, unknown>; missing: string[] } {
  const out: Record<string, unknown> = { ...values };
  const missing: string[] = [];
  for (const key of secretKeys(schema)) {
    const ref = values[key] as { env?: string } | undefined;
    if (!ref?.env) continue;
    const v = env[ref.env];
    if (v === undefined) {
      missing.push(ref.env);
      delete out[key];
    } else out[key] = v;
  }
  return { values: out, missing };
}
