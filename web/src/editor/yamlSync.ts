import { Document, isMap, isSeq, parseDocument } from "yaml";
import type { WorkflowDoc } from "../types";

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Parses YAML text into a workflow object for the form, or explains why it can't. */
export function parseWorkflowYaml(text: string): { doc: WorkflowDoc } | { error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length) return { error: doc.errors.map((e) => e.message).join("; ") };
  const js = doc.toJS();
  if (!isPlainObject(js)) return { error: "The YAML must be a mapping (key: value pairs) to edit it in the form." };
  return {
    doc: {
      ...js,
      triggers: Array.isArray(js.triggers) ? js.triggers : [],
      steps: Array.isArray(js.steps) ? js.steps : [],
    } as WorkflowDoc,
  };
}

/**
 * The same merge the server does on a form save (server/src/configstore.ts applyValue): only the
 * changed nodes are touched, so comments on untouched parts survive. Used for the YAML tab preview
 * after form edits; the server's own result replaces it on save.
 */
function applyValue(doc: Document, path: (string | number)[], prev: unknown, next: unknown): void {
  if (same(prev, next)) return;
  if (isPlainObject(prev) && isPlainObject(next) && (path.length === 0 || isMap(doc.getIn(path, true)))) {
    for (const key of Object.keys(prev)) if (!(key in next)) doc.deleteIn([...path, key]);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) {
        if (key in prev) doc.deleteIn([...path, key]);
        continue;
      }
      if (key in prev) applyValue(doc, [...path, key], prev[key], value);
      else doc.setIn([...path, key], doc.createNode(value));
    }
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && isSeq(doc.getIn(path, true))) {
    next.forEach((v, i) => applyValue(doc, [...path, i], prev[i], v));
    return;
  }
  doc.setIn(path, doc.createNode(next));
}

export function applyToYaml(text: string, next: WorkflowDoc): string {
  const doc = parseDocument(text);
  const prev = doc.errors.length ? null : doc.toJS();
  if (isPlainObject(prev) && isMap(doc.contents)) {
    applyValue(doc, [], prev, next);
    return doc.toString();
  }
  return new Document(next).toString();
}

export function toYaml(obj: unknown): string {
  return new Document(obj).toString();
}
