import { useEffect, useState, type KeyboardEvent } from "react";
import type { JsonSchema, Path } from "./types";
import { Field, FieldIssues, json } from "./ui";

/**
 * An in-house JSON Schema form for the same subset the Android app renders:
 * string, number/integer, boolean, enum → select, arrays of primitives → chip list,
 * `format: "secret"` → environment variable name (stored as {env: "VAR"}).
 * Anything else falls back to a raw JSON textarea (per field, or for the whole value).
 */

const PRIMITIVES = ["string", "number", "integer", "boolean"];

function typeOf(s: JsonSchema | undefined): string | undefined {
  if (!s) return undefined;
  if (Array.isArray(s.type)) return s.type.find((t) => t !== "null");
  if (s.type) return s.type;
  if (s.enum) return "enum";
  return undefined;
}

export type FieldKind = "enum" | "secret" | "string" | "number" | "boolean" | "chips" | "json";

export function fieldKind(s: JsonSchema): FieldKind {
  if (Array.isArray(s.enum) && s.enum.length && s.enum.every((v) => ["string", "number", "boolean"].includes(typeof v))) return "enum";
  const t = typeOf(s);
  if (t === "string" && s.format === "secret") return "secret";
  if (t === "string") return "string";
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  if (t === "array" && s.items && (PRIMITIVES.includes(typeOf(s.items) ?? "") || Array.isArray(s.items.enum))) return "chips";
  return "json";
}

export const isObjectSchema = (s: JsonSchema | null | undefined): s is JsonSchema & { properties: Record<string, JsonSchema> } =>
  !!s && typeOf(s) === "object" && !!s.properties && typeof s.properties === "object";

export function SchemaForm({
  schema,
  value,
  onChange,
  issuePath = [],
  templates = false,
}: {
  schema: JsonSchema | null | undefined;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  /** Where these values sit in the server's issue paths, e.g. ["values"] or ["steps", 0, "call", "args"]. */
  issuePath?: Path;
  /** Workflow `call` args: number fields also accept {{templates}}. */
  templates?: boolean;
}) {
  if (!isObjectSchema(schema)) {
    return (
      <Field label="Values (JSON)" path={issuePath}>
        <JsonTextarea value={value} onChange={(v) => onChange((v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>)} />
      </Field>
    );
  }
  const required = new Set(schema.required ?? []);
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const props = Object.entries(schema.properties);
  const known = new Set(props.map(([k]) => k));
  const extra = Object.keys(value).filter((k) => !known.has(k));
  return (
    <div className="schema-form">
      {props.map(([key, prop]) => (
        <SchemaField key={key} name={key} schema={prop} required={required.has(key)} value={value[key]} onChange={(v) => set(key, v)} path={[...issuePath, key]} templates={templates} />
      ))}
      {extra.length > 0 && (
        <p className="hint">
          Also set (not in the schema, kept as is): {extra.map((k) => <code key={k}>{k}</code>)}
        </p>
      )}
      <FieldIssues path={issuePath} />
    </div>
  );
}

function SchemaField({
  name,
  schema,
  required,
  value,
  onChange,
  path,
  templates,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  path: Path;
  templates: boolean;
}) {
  const kind = fieldKind(schema);
  const label = (
    <>
      {schema.title ?? name}
      {required && <span className="req"> *</span>}
      {schema.title && schema.title !== name && <code className="key">{name}</code>}
    </>
  );
  const placeholder = schema.default !== undefined ? `default: ${typeof schema.default === "string" ? schema.default : JSON.stringify(schema.default)}` : undefined;
  const hint = schema.description;

  switch (kind) {
    case "enum": {
      const opts = schema.enum as (string | number | boolean)[];
      const idx = opts.findIndex((o) => o === value);
      return (
        <Field label={label} hint={hint} path={path}>
          <select aria-label={name} value={idx < 0 ? "" : String(idx)} onChange={(e) => onChange(e.target.value === "" ? undefined : opts[Number(e.target.value)])}>
            <option value="">{schema.default !== undefined ? `(default: ${String(schema.default)})` : "(not set)"}</option>
            {opts.map((o, i) => (
              <option key={i} value={i}>
                {String(o)}
              </option>
            ))}
          </select>
        </Field>
      );
    }
    case "secret": {
      const env = value && typeof value === "object" ? String((value as { env?: unknown }).env ?? "") : "";
      return (
        <Field
          label={label}
          path={path}
          hint={
            <>
              {hint && <>{hint} </>}
              Secret: enter the <em>name</em> of an environment variable. Put the value itself in the server's <code>.env</code>
              {env ? (
                <>
                  {" "}
                  as <code>{env}=…</code>
                </>
              ) : null}
              .
            </>
          }
        >
          <input
            aria-label={name}
            placeholder="ENV_VAR_NAME"
            value={env}
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
              onChange(v ? { env: v } : undefined);
            }}
          />
        </Field>
      );
    }
    case "string": {
      const long = (typeof schema.maxLength === "number" && schema.maxLength > 200) || schema.format === "textarea" || (typeof value === "string" && value.length > 80);
      const v = typeof value === "string" ? value : value === undefined ? "" : String(value);
      return (
        <Field label={label} hint={hint} path={path}>
          {long ? (
            <textarea aria-label={name} rows={3} value={v} placeholder={placeholder} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
          ) : (
            <input aria-label={name} value={v} placeholder={placeholder} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
          )}
        </Field>
      );
    }
    case "number":
      return (
        <Field label={label} hint={hint} path={path}>
          <NumberInput name={name} value={value} placeholder={placeholder} integer={typeOf(schema) === "integer"} templates={templates} onChange={onChange} />
        </Field>
      );
    case "boolean":
      return (
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              aria-label={name}
              checked={value === undefined ? schema.default === true : value === true}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span>{label}</span>
            {value === undefined && schema.default !== undefined && <span className="hint"> (default)</span>}
          </label>
          {hint && <span className="hint">{hint}</span>}
          <FieldIssues path={path} />
        </div>
      );
    case "chips":
      return (
        <Field label={label} hint={hint} path={path}>
          <ChipList name={name} items={schema.items!} value={Array.isArray(value) ? value : []} onChange={(v) => onChange(v.length ? v : undefined)} />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={<>{hint && <>{hint} </>}Edited as JSON (this field's type isn't supported by the form).</>} path={path}>
          <JsonTextarea value={value} allowEmpty onChange={onChange} />
        </Field>
      );
  }
}

function NumberInput({
  name,
  value,
  placeholder,
  integer,
  templates,
  onChange,
}: {
  name: string;
  value: unknown;
  placeholder?: string;
  integer: boolean;
  templates: boolean;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    if (String(value ?? "") !== text && Number(text) !== value) setText(value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      aria-label={name}
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      placeholder={placeholder ?? (templates ? "a number or {{event.x}}" : undefined)}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") return onChange(undefined);
        const n = Number(t);
        if (Number.isFinite(n) && /^-?\d*\.?\d+(e-?\d+)?$/i.test(t.trim())) onChange(n);
        else onChange(templates || Number.isNaN(n) ? t : n);
      }}
    />
  );
}

function ChipList({ name, items, value, onChange }: { name: string; items: JsonSchema; value: unknown[]; onChange: (v: unknown[]) => void }) {
  const [draft, setDraft] = useState("");
  const t = typeOf(items);
  const options = Array.isArray(items.enum) ? (items.enum as unknown[]) : null;
  const parse = (s: string): unknown => {
    if (t === "number" || t === "integer") return Number(s);
    if (t === "boolean") return s === "true";
    return s;
  };
  const add = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    const v = parse(s);
    if ((t === "number" || t === "integer") && !Number.isFinite(v as number)) return;
    if (!value.some((x) => x === v)) onChange([...value, v]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="chips">
      {value.map((v, i) => (
        <span className="chip" key={i}>
          {String(v)}
          <button type="button" aria-label={`Remove ${String(v)}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ×
          </button>
        </span>
      ))}
      {options ? (
        <select aria-label={`Add to ${name}`} value="" onChange={(e) => e.target.value !== "" && onChange([...value, options[Number(e.target.value)]])}>
          <option value="">Add…</option>
          {options.map((o, i) =>
            value.includes(o) ? null : (
              <option key={i} value={i}>
                {String(o)}
              </option>
            ),
          )}
        </select>
      ) : (
        <input aria-label={`Add to ${name}`} placeholder="Type and press Enter" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => add(draft)} />
      )}
    </div>
  );
}

/** A JSON textarea that only reports parseable values; shows the parse error otherwise. */
export function JsonTextarea({ value, onChange, rows = 5, allowEmpty = false, label }: { value: unknown; onChange: (v: unknown) => void; rows?: number; allowEmpty?: boolean; label?: string }) {
  const [text, setText] = useState(() => (value === undefined ? "" : json(value)));
  const [err, setErr] = useState<string | null>(null);
  const last = useState({ v: value })[0];
  useEffect(() => {
    // Only resync from outside when the value really changed (not on our own edits).
    if (JSON.stringify(value) !== JSON.stringify(last.v)) {
      last.v = value;
      setText(value === undefined ? "" : json(value));
      setErr(null);
    }
  }, [value, last]);
  return (
    <>
      <textarea
        aria-label={label}
        className="mono"
        rows={rows}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (!t.trim() && allowEmpty) {
            setErr(null);
            last.v = undefined;
            return onChange(undefined);
          }
          try {
            const v = JSON.parse(t);
            setErr(null);
            last.v = v;
            onChange(v);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      />
      {err && <span className="field-issues">Not valid JSON yet: {err}</span>}
    </>
  );
}
