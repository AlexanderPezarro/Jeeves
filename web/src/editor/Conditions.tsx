import { useEffect, useState } from "react";
import type { CondExpr, Condition, Path } from "../types";
import { FieldIssues } from "../ui";
import { FIELD_PATHS_LIST } from "./context";

const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"] as const;
type Op = (typeof OPS)[number];
const OP_LABEL: Record<Op, string> = { eq: "equals", ne: "is not", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", exists: "exists" };

function opOf(c: Condition): Op {
  return OPS.find((o) => o in c) ?? "eq";
}

function showValue(v: unknown): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function parseValue(op: Op, s: string): unknown {
  if (op === "exists") return s !== "false";
  if (["gt", "gte", "lt", "lte"].includes(op)) return s.trim() === "" ? undefined : Number(s);
  if (s.trim() === "") return "";
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function ConditionRow({ value, onChange, onRemove, path, pathPrefix = "event." }: { value: Condition; onChange: (c: Condition) => void; onRemove?: () => void; path: Path; pathPrefix?: string }) {
  const op = opOf(value);
  const [text, setText] = useState(showValue(value[op]));
  useEffect(() => {
    // Resync only when the value changed from outside, so typing isn't reformatted under the cursor.
    if (JSON.stringify(parseValue(op, text)) !== JSON.stringify(value[op])) setText(showValue(value[op]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, op]);
  const rebuild = (o: Op, v: unknown) => {
    const c: Condition = { path: value.path };
    (c as Record<string, unknown>)[o] = v;
    onChange(c);
  };
  return (
    <div className="cond">
      <div className="row gap wrap">
        <input aria-label="Condition path" className="mono grow" list={FIELD_PATHS_LIST} placeholder={`${pathPrefix}field`} value={value.path ?? ""} onChange={(e) => onChange({ ...value, path: e.target.value })} />
        <select aria-label="Operator" value={op} onChange={(e) => rebuild(e.target.value as Op, e.target.value === "exists" ? true : parseValue(e.target.value as Op, text))}>
          {OPS.map((o) => (
            <option key={o} value={o}>
              {OP_LABEL[o]}
            </option>
          ))}
        </select>
        {op === "exists" ? (
          <select aria-label="Exists" value={value.exists === false ? "false" : "true"} onChange={(e) => rebuild("exists", e.target.value === "true")}>
            <option value="true">yes</option>
            <option value="false">no</option>
          </select>
        ) : (
          <input
            aria-label="Value"
            className="mono"
            placeholder={["gt", "gte", "lt", "lte"].includes(op) ? "number" : 'value, e.g. home or 5 or true'}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              rebuild(op, parseValue(op, e.target.value));
            }}
          />
        )}
        {onRemove && (
          <button type="button" className="icon" aria-label="Remove condition" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
      <FieldIssues path={path} />
      <FieldIssues path={[...path, "path"]} />
    </div>
  );
}

/** A flat list of conditions (trigger `when.conditions`). */
export function ConditionList({ value, onChange, path }: { value: Condition[]; onChange: (v: Condition[] | undefined) => void; path: Path }) {
  return (
    <div className="stack-sm">
      {value.map((c, i) => (
        <ConditionRow
          key={i}
          value={c}
          path={[...path, i]}
          onChange={(nc) => onChange(value.map((x, j) => (j === i ? nc : x)))}
          onRemove={() => {
            const next = value.filter((_, j) => j !== i);
            onChange(next.length ? next : undefined);
          }}
        />
      ))}
      <button type="button" className="small-btn" onClick={() => onChange([...value, { path: "event.", eq: "" }])}>
        + Condition
      </button>
      <FieldIssues path={path} />
    </div>
  );
}

/** An `if` condition: one condition, or all/any of nested conditions. */
export function CondExprEditor({ value, onChange, path }: { value: CondExpr; onChange: (v: CondExpr) => void; path: Path }) {
  const mode = value && "all" in value ? "all" : value && "any" in value ? "any" : "single";
  const setMode = (m: string) => {
    if (m === mode) return;
    const children: CondExpr[] = mode === "single" ? [value] : (value as { all?: CondExpr[]; any?: CondExpr[] })[mode] ?? [];
    if (m === "single") onChange(children[0] ?? { path: "event.", eq: "" });
    else onChange(m === "all" ? { all: children } : { any: children });
  };
  return (
    <div className="cond-expr">
      <select aria-label="Condition mode" value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="single">Condition</option>
        <option value="all">All of</option>
        <option value="any">Any of</option>
      </select>
      {mode === "single" ? (
        <ConditionRow value={(value as Condition) ?? { path: "event." }} onChange={onChange} path={path} pathPrefix="event. or steps.<id>." />
      ) : (
        <div className="cond-group">
          {((value as Record<string, CondExpr[]>)[mode] ?? []).map((c, i, arr) => (
            <div key={i} className="row gap top">
              <div className="grow">
                <CondExprEditor value={c} path={[...path, mode, i]} onChange={(nc) => onChange({ [mode]: arr.map((x, j) => (j === i ? nc : x)) } as CondExpr)} />
              </div>
              <button type="button" className="icon" aria-label="Remove" onClick={() => onChange({ [mode]: arr.filter((_, j) => j !== i) } as CondExpr)}>
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="small-btn"
            onClick={() => onChange({ [mode]: [...((value as Record<string, CondExpr[]>)[mode] ?? []), { path: "event.", eq: "" }] } as CondExpr)}
          >
            + Condition
          </button>
          <FieldIssues path={[...path, mode]} />
        </div>
      )}
      {mode !== "single" && <FieldIssues path={path} />}
    </div>
  );
}
