import type { CondExpr, Condition } from "./config.js";
import { lookup, type TemplateContext } from "./template.js";

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function compare(a: unknown, b: number, op: (x: number, y: number) => boolean): boolean {
  const n = typeof a === "number" ? a : typeof a === "string" && a.trim() !== "" ? Number(a) : NaN;
  return !Number.isNaN(n) && op(n, b);
}

/**
 * True when every operator given on the condition holds. A condition with no operator checks that
 * the value is truthy. Shared by `if` steps, trigger `when.conditions` and simulate.
 */
export function evalCondition(cond: Condition, ctx: TemplateContext): boolean {
  const v = lookup(ctx, cond.path);
  const checks: boolean[] = [];
  if ("eq" in cond) checks.push(same(v, cond.eq));
  if ("ne" in cond) checks.push(!same(v, cond.ne));
  if (cond.gt !== undefined) checks.push(compare(v, cond.gt, (x, y) => x > y));
  if (cond.gte !== undefined) checks.push(compare(v, cond.gte, (x, y) => x >= y));
  if (cond.lt !== undefined) checks.push(compare(v, cond.lt, (x, y) => x < y));
  if (cond.lte !== undefined) checks.push(compare(v, cond.lte, (x, y) => x <= y));
  if ("contains" in cond) {
    checks.push(
      typeof v === "string" ? v.includes(String(cond.contains)) : Array.isArray(v) ? v.some((x) => same(x, cond.contains)) : false,
    );
  }
  if (cond.exists !== undefined) checks.push((v !== undefined && v !== null) === cond.exists);
  return checks.length ? checks.every(Boolean) : Boolean(v);
}

export function evalCondExpr(expr: CondExpr, ctx: TemplateContext): boolean {
  if ("all" in expr) return expr.all.every((e) => evalCondExpr(e, ctx));
  if ("any" in expr) return expr.any.some((e) => evalCondExpr(e, ctx));
  return evalCondition(expr, ctx);
}

/** Plain-English rendering of a condition, for skip reasons and the UI. */
export function describeCondition(c: Condition): string {
  const parts: string[] = [];
  if ("eq" in c) parts.push(`is ${JSON.stringify(c.eq)}`);
  if ("ne" in c) parts.push(`is not ${JSON.stringify(c.ne)}`);
  if (c.gt !== undefined) parts.push(`> ${c.gt}`);
  if (c.gte !== undefined) parts.push(`>= ${c.gte}`);
  if (c.lt !== undefined) parts.push(`< ${c.lt}`);
  if (c.lte !== undefined) parts.push(`<= ${c.lte}`);
  if ("contains" in c) parts.push(`contains ${JSON.stringify(c.contains)}`);
  if (c.exists !== undefined) parts.push(c.exists ? "is set" : "is not set");
  return `${c.path} ${parts.length ? parts.join(" and ") : "is truthy"}`;
}
