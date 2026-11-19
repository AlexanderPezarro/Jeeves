import { Ajv, type ErrorObject } from "ajv";
import { z } from "zod";

/**
 * The optional plugin contract beyond MCP tools: `GET <base>/jeeves/manifest` describes settings,
 * a UI page, the events the plugin posts to /plugin-events, and whether it serves the Today list.
 * A plugin without one (404 or invalid) is a tools-only plugin and still works.
 */
export const manifestSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  version: z.string(),
  settings_schema: z.record(z.string(), z.unknown()).nullable().optional(),
  ui: z.object({ path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/, "an absolute path"), title: z.string() }).nullable().optional(),
  events: z.array(z.string().regex(/^[a-z0-9_.-]+$/)).default([]),
  today: z.boolean().default(false),
});

export type Manifest = z.infer<typeof manifestSchema>;

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
