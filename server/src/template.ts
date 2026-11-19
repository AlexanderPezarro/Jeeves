/**
 * Minimal templating for workflow steps: `{{event.x}}` and `{{steps.<id>.y}}` with dotted lookup.
 * No expressions or helpers on purpose. Unknown paths render as "" and are reported as warnings.
 */

export interface TemplateContext {
  event: Record<string, unknown>;
  steps: Record<string, unknown>;
}

const TEMPLATE_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Dotted lookup; returns undefined for any missing segment. Array indexes work too ("items.0"). */
export function lookup(ctx: TemplateContext, path: string): unknown {
  let cur: unknown = ctx;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const allowed = (path: string) => path === "event" || path.startsWith("event.") || path.startsWith("steps.");

export function render(str: string, ctx: TemplateContext, warnings: string[] = []): string {
  return str.replace(TEMPLATE_RE, (_m, path: string) => {
    const value = allowed(path) ? lookup(ctx, path) : undefined;
    if (value === undefined || value === null) {
      warnings.push(`{{${path}}} is empty`);
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/**
 * Renders every string inside a value (objects and arrays included). A string that is exactly one
 * `{{ref}}` keeps the referenced value's type, so `task_id: "{{event.task_id}}"` stays a number.
 */
export function renderDeep<T>(value: T, ctx: TemplateContext, warnings: string[] = []): T {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([^}]*?)\s*\}\}$/.exec(value);
    if (whole && allowed(whole[1])) {
      const v = lookup(ctx, whole[1]);
      if (v !== undefined && v !== null && typeof v !== "string") return v as T;
    }
    return render(value, ctx, warnings) as T;
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx, warnings)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx, warnings)])) as T;
  }
  return value;
}
