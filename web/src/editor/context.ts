import { createContext, useContext } from "react";
import type { Step, Tool } from "../types";

export interface EditorData {
  tools: Tool[];
  toolsError: string | null;
  eventTypes: string[];
  timezone: string;
  /** Every step id in the workflow, for generating unique ids. */
  allStepIds: Set<string>;
}

export const EditorDataContext = createContext<EditorData>({ tools: [], toolsError: null, eventTypes: [], timezone: "UTC", allStepIds: new Set() });
export const useEditorData = () => useContext(EditorDataContext);

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

export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Built-in tools Claude steps can be allowed besides plugin tools. */
export const BUILTIN_CLAUDE_TOOLS = [
  { name: "send_message", description: "Send you a message (the plan)" },
  { name: "schedule_followup", description: "Schedule a follow-up message" },
];
