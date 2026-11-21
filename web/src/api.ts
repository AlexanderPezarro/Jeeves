import type {
  ClaudeRun,
  ConfigError,
  Decision,
  EventInfo,
  FeedItem,
  Globals,
  Health,
  Issue,
  PluginEntry,
  PluginSettings,
  Tool,
  Upcoming,
  WorkflowDoc,
  WorkflowFile,
  WorkflowRun,
  WorkflowSummary,
} from "./types";
import { BASE_PATH } from "./env";

/**
 * Same-origin API. In the browser, Caddy + Authelia add Remote-User; in the phone app, the /app
 * cookie authenticates. The page itself sends no tokens either way.
 */
export const API_BASE = `${BASE_PATH}api`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
/** 400 with zod-style issues. */
export class ValidationError extends ApiError {
  get issues(): Issue[] {
    return Array.isArray(this.body.issues) ? (this.body.issues as Issue[]) : [];
  }
}
/** 409 stale: the file changed since it was loaded. `current` is what is on disk now. */
export class StaleError extends ApiError {
  get current(): { yaml: string; hash: string } | null {
    return (this.body.current as { yaml: string; hash: string } | null | undefined) ?? null;
  }
}
/** 401: Authelia session missing or expired. */
export class AuthError extends ApiError {}
/** 502: e.g. plugin settings saved but the plugin didn't accept them. */
export class UpstreamError extends ApiError {}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch (e) {
    throw new ApiError(0, `Network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (res.ok) return data as T;
  const b = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const message = String(b.message ?? b.error ?? `${res.status} ${res.statusText}`);
  if (res.status === 401) {
    unauthorizedListeners.forEach((fn) => fn());
    throw new AuthError(401, "You are signed out. Reload the page to sign in again.", b);
  }
  if (res.status === 400) throw new ValidationError(400, message, b);
  if (res.status === 409 && b.error === "stale") throw new StaleError(409, message, b);
  if (res.status === 502) throw new UpstreamError(502, message, b);
  throw new ApiError(res.status, message, b);
}

const enc = encodeURIComponent;
const qs = (q: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface ActivityQuery {
  from?: string;
  to?: string;
  workflow?: string;
  kind?: string;
  status?: string;
  limit?: number;
  cursor?: string | null;
}

export const api = {
  me: () => request<{ identity: { kind: "user" | "device"; name: string } }>("GET", "/me"),

  workflows: () => request<{ workflows: WorkflowSummary[] }>("GET", "/workflows"),
  workflow: (id: string) => request<WorkflowFile>("GET", `/workflows/${enc(id)}`),
  saveWorkflow: (id: string, body: { yaml: string; hash: string | null } | { workflow: WorkflowDoc; hash: string | null }) =>
    request<WorkflowFile>("PUT", `/workflows/${enc(id)}`, body),
  deleteWorkflow: (id: string, hash: string | null) => request<{ ok: true }>("DELETE", `/workflows/${enc(id)}${qs({ hash })}`),
  setEnabled: (id: string, enabled: boolean, hash: string | null) => request<WorkflowFile>("PATCH", `/workflows/${enc(id)}/enabled`, { enabled, hash }),
  runWorkflow: (id: string, dryRun: boolean, payload: Record<string, unknown> = {}) =>
    request<{ workflow_run_id: number; run: (WorkflowRun & { definition?: unknown }) | null }>("POST", `/workflows/${enc(id)}/run`, { dry_run: dryRun, payload }),

  configErrors: () => request<{ errors: ConfigError[] }>("GET", "/config/errors"),
  globals: () => request<{ yaml: string; parsed: Globals; hash: string }>("GET", "/config/globals"),
  saveGlobals: (patch: Partial<Globals>, hash: string | null) => request<{ yaml: string; parsed: Globals; hash: string }>("PUT", "/config/globals", { patch, hash }),

  upcoming: (hours = 48) => request<Upcoming>("GET", `/timeline/upcoming${qs({ hours })}`),
  activity: (q: ActivityQuery) => request<{ items: FeedItem[]; next_cursor: string | null }>("GET", `/activity${qs({ ...q })}`),
  workflowRun: (id: number) => request<WorkflowRun>("GET", `/workflow-runs/${id}`),
  run: (id: number) => request<ClaudeRun>("GET", `/runs/${id}`),
  health: () => request<Health>("GET", "/health/summary"),
  simulate: (event_type: string, payload: Record<string, unknown>, at?: string) =>
    request<{ at: string; decisions: Decision[] }>("POST", "/simulate", { event_type, payload, ...(at ? { at } : {}) }),
  cancelJob: (id: number) => request<{ ok: true }>("DELETE", `/jobs/${id}`),

  tools: () => request<{ tools: Tool[] }>("GET", "/tools"),
  eventTypes: () => request<{ event_types: string[]; events?: EventInfo[] }>("GET", "/event-types"),

  plugins: () => request<{ plugins: PluginEntry[]; hash: string }>("GET", "/plugins"),
  addPlugin: (p: { name: string; url: string; token_env: string }, hash: string | null) => request<{ plugin: unknown }>("POST", "/plugins", { ...p, hash }),
  removePlugin: (name: string, hash: string | null) => request<{ ok: true }>("DELETE", `/plugins/${enc(name)}${qs({ hash })}`),
  pluginSettings: (name: string) => request<PluginSettings>("GET", `/plugins/${enc(name)}/settings`),
  savePluginSettings: (name: string, values: Record<string, unknown>, hash: string | null) =>
    request<PluginSettings>("PUT", `/plugins/${enc(name)}/settings`, { values, hash }),
  pluginUiUrl: (name: string) => `${API_BASE}/plugins/${enc(name)}/ui/`,
};
