import { createContext, useContext } from "react";
import type { EventInfo, JsonSchema, Step, Tool, Trigger } from "../types";

export interface EditorData {
  tools: Tool[];
  toolsError: string | null;
  eventTypes: string[];
  /** Described events (built-in and from plugin manifests), with payload schemas. */
  events: EventInfo[];
  timezone: string;
  /** Every step id in the workflow, for generating unique ids. */
  allStepIds: Set<string>;
  /** `event.<field>` and `steps.<id>.<field>` paths this workflow can use in conditions and templates. */
  fieldPaths: string[];
}

export const EditorDataContext = createContext<EditorData>({
  tools: [],
  toolsError: null,
  eventTypes: [],
  events: [],
  timezone: "UTC",
  allStepIds: new Set(),
  fieldPaths: [],
});
export const useEditorData = () => useContext(EditorDataContext);

/** The <datalist> id condition path inputs use; WorkflowEditor renders it once. */
export const FIELD_PATHS_LIST = "jeeves-field-paths";

export function collectStepIds(steps: Step[], out = new Set<string>()): Set<string> {
  for (const s of steps ?? []) {
    if (s && typeof s.id === "string") out.add(s.id);
    if (s && "if" in s) {
      collectStepIds(s.then ?? [], out);
      collectStepIds(s.else ?? [], out);
    }
  }
  return out;
}

/** Field paths under `prefix` from a JSON Schema: object properties, and `.0` for an array's items. Two levels deep. */
export function schemaPaths(schema: JsonSchema | null | undefined, prefix: string, depth = 2): string[] {
  if (!schema || depth < 0) return [];
  const out: string[] = [];
  const type = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (type.includes("array") && schema.items) {
    out.push(`${prefix}.0`);
    out.push(...schemaPaths(schema.items as JsonSchema, `${prefix}.0`, depth));
  }
  for (const [k, v] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
    out.push(`${prefix}.${k}`);
    if (depth > 0) out.push(...schemaPaths(v, `${prefix}.${k}`, depth - 1));
  }
  return out;
}

/** What `event.*` and `steps.*` hold in this workflow, from its triggers' events and its call steps' tools. */
export function collectFieldPaths(triggers: Trigger[], steps: Step[], tools: Tool[], events: EventInfo[]): string[] {
  const out = new Set<string>();
  for (const t of triggers ?? []) {
    if (t && "event" in t) for (const p of schemaPaths(events.find((e) => e.type === t.event)?.payload_schema, "event")) out.add(p);
  }
  const walk = (list: Step[]) => {
    for (const s of list ?? []) {
      if (!s) continue;
      if ("call" in s && s.call && typeof s.id === "string") {
        const tool = tools.find((t) => t.plugin === s.call.plugin && t.tool === s.call.tool);
        for (const p of schemaPaths(tool?.output_schema, `steps.${s.id}`)) out.add(p);
      }
      if ("if" in s) {
        walk(s.then ?? []);
        walk(s.else ?? []);
      }
    }
  };
  walk(steps);
  return [...out];
}

export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Built-in tools Claude steps can be allowed besides plugin tools. */
export const BUILTIN_CLAUDE_TOOLS = [
  { name: "send_message", description: "Send you a message (the plan)" },
  { name: "schedule_followup", description: "Schedule a follow-up message" },
  { name: "set_reminder", description: "Set a one-off reminder at a date and time" },
  { name: "list_reminders", description: "List one-off reminders" },
  { name: "cancel_reminder", description: "Cancel a one-off reminder" },
];
