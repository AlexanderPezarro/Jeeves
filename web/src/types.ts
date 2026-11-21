// Shapes returned by the server's /admin/api routes (see server/src/api.ts, timeline.ts, pluginapi.ts).

export type Path = (string | number)[];
export interface Issue {
  path: Path;
  message: string;
}

// Workflow documents as edited by the form. Loosely typed on purpose: the form edits whatever the
// YAML file holds and the server's zod schema has the final say.
export type Condition = {
  path: string;
  eq?: unknown;
  ne?: unknown;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  contains?: unknown;
  exists?: boolean;
};
export type CondExpr = Condition | { all: CondExpr[] } | { any: CondExpr[] };

export interface When {
  /** One network, or a list where any of them matches. */
  ssid?: string | string[];
  after?: string;
  before?: string;
  days?: string[];
  min_away_minutes?: number;
  conditions?: Condition[];
}

/** An event a paused run waits for (message `until`, workflow `cancel_on`). */
export interface Listener {
  event: string;
  conditions?: Condition[];
}

export type Trigger = { event: string; when?: When } | { schedule: string; when?: When };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Step =
  | { id: string; call: { plugin: string; tool: string; args?: Record<string, unknown> } }
  | { id: string; claude: { prompt: string; tools?: string[]; model?: string; effort?: Effort; history?: boolean } }
  | {
      id: string;
      message: {
        text: string;
        items?: unknown[];
        level?: "notify" | "loud" | "alarm";
        repeat?: { every_minutes: number; max?: number };
        until?: Listener;
      };
    }
  | { id: string; wait: { minutes: number } | { until: string } }
  | { id: string; if: CondExpr; then: Step[]; else?: Step[] }
  | { id: string; stop: { reason?: string } | null };

export type StepType = "call" | "claude" | "message" | "wait" | "if" | "stop";
export const STEP_TYPES: StepType[] = ["message", "claude", "call", "wait", "if", "stop"];

export function stepType(step: Step): StepType | null {
  for (const t of STEP_TYPES) if (t in step) return t;
  return null;
}

export interface WorkflowDoc {
  id: string;
  description?: string;
  enabled?: boolean;
  cooldown?: "daily" | number;
  notify_on_failure?: boolean;
  triggers: Trigger[];
  cancel_on?: Listener[];
  steps: Step[];
  [extra: string]: unknown;
}

export interface WorkflowSummary {
  id: string;
  description: string | null;
  enabled: boolean;
  hash: string | null;
  loaded: boolean;
  error: string | null;
  triggers: Trigger[];
  step_count: number;
  last_run: { id: number; status: RunStatus; started_at: string; finished_at: string | null; error: string | null } | null;
}

export interface WorkflowFile {
  yaml: string;
  parsed: WorkflowDoc | null;
  hash: string;
  error?: string | null;
}

export type RunStatus = "running" | "waiting" | "ok" | "failed" | "stopped" | "capped" | "cancelled";

export interface MessageRow {
  id: number;
  direction: "in" | "out";
  text: string;
  items: { plugin?: string; item_id?: string; title: string; steps?: string[]; minutes?: number }[] | null;
  run_id: number | null;
  created_at: string;
}

export interface StepRun {
  id: number;
  workflow_run_id: number;
  step_id: string;
  path: string;
  type: string;
  status: string;
  input: unknown;
  output: unknown;
  warnings: string[];
  run_id: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  claude_run: { id: number; status: string; model: string; input_tokens: number | null; output_tokens: number | null; error: string | null } | null;
  messages: MessageRow[];
}

export interface WorkflowRun {
  kind: "workflow_run";
  at: string;
  id: number;
  workflow_id: string;
  trigger: string;
  event_id: number | null;
  status: RunStatus;
  dry_run: boolean;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  local_date: string;
  steps: StepRun[];
}

export interface Evaluation {
  kind: "evaluation";
  at: string;
  id: number;
  workflow_id: string;
  trigger_kind: "event" | "schedule";
  event_id: number | null;
  fired: boolean;
  reason: string;
  simulated: boolean;
}

export interface ActivityRow {
  kind: "config_reload" | "config_error" | "plugin_connect" | "plugin_disconnect" | "reminder_fired" | "item_action";
  at: string;
  id: number;
  subject: string | null;
  detail: unknown;
}

export type FeedItem = WorkflowRun | Evaluation | ActivityRow;

export interface ClaudeRun {
  id: number;
  status: string;
  model?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  error?: string | null;
  transcript: unknown;
  messages: MessageRow[];
  [k: string]: unknown;
}

export type UpcomingStatus = "will_run" | "will_skip" | "disabled" | "cap_reached";
export type UpcomingItem =
  | { kind: "schedule"; at: string; workflow_id: string; schedule: string; status: UpcomingStatus; reason: string | null }
  | { kind: "wait"; at: string; job_id: number; workflow_id: string; workflow_run_id: number; next_step: string | null; dry_run: boolean }
  | { kind: "followup"; at: string; job_id: number; message: string; plugin: string | null; item_id: string | null }
  | { kind: "reminder"; at: string; job_id: number; plugin: string; key: string; level: string; text: string; item_id: string | null };

export interface Upcoming {
  from: string;
  to: string;
  items: UpcomingItem[];
  waiting_for: { workflow_id: string; enabled: boolean; event: string; description: string }[];
}

export interface PluginStatus {
  name: string;
  url: string;
  reachable: boolean | null;
  tool_count: number;
  last_error: string | null;
  last_seen: string | null;
}

export interface ConfigError {
  file: string;
  error: string;
  at: string;
}

export interface Health {
  now: string;
  local_date: string;
  timezone: string;
  runs_today: number;
  max_runs_per_day: number;
  tokens_7d: { input_tokens: number; output_tokens: number; runs: number };
  workflows: { total: number; enabled: number };
  waiting_runs: number;
  plugins: PluginStatus[];
  config_errors: ConfigError[];
  devices: { device_id: number; name: string; last_event_type: string | null; last_event_at: string | null }[];
}

export interface Tool {
  name: string;
  plugin: string;
  tool: string;
  description: string;
  input_schema: JsonSchema;
  read_only: boolean;
  /** Friendly step name from the plugin (manifest or MCP title). */
  title?: string | null;
  /** What the tool returns; its fields are offered as `steps.<id>.<field>`. */
  output_schema?: JsonSchema | null;
  /** The plugin's display name. */
  plugin_title?: string;
}

/** An event a trigger can wait for, with what its payload holds (`event.<field>`). */
export interface EventInfo {
  type: string;
  title: string | null;
  description: string | null;
  payload_schema: JsonSchema | null;
  /** "builtin" or the plugin's name. */
  source: string;
}

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [k: string]: unknown;
}

export interface Manifest {
  name: string;
  display_name: string;
  version: string;
  settings_schema?: JsonSchema | null;
  ui?: { path: string; title: string } | null;
  events: string[];
  views?: { id: string; title: string }[];
  item_actions?: { id: string; label: string }[];
}

export interface PluginEntry {
  name: string;
  url: string;
  token_env: string;
  manifest: Manifest | null;
  status: PluginStatus | null;
}

export interface PluginSettings {
  values: Record<string, unknown>;
  hash: string;
  schema: JsonSchema | null;
  secrets: string[];
}

export interface Globals {
  timezone: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  max_runs_per_day: number;
  about_me: string;
  activity_retention_days: number;
  [k: string]: unknown;
}

export interface Decision {
  workflow_id: string;
  fired: boolean;
  reason: string | null;
}
