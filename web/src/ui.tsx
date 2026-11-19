import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, AuthError } from "./api";
import type { Issue, Path } from "./types";

// ---------------------------------------------------------------------------
// Data loading

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fnRef.current();
      if (n === seq.current) setState({ data, loading: false });
    } catch (error) {
      if (n === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void reload(), deps);
  return { ...state, reload, setData: (data: T) => setState({ data, loading: false }) };
}

// ---------------------------------------------------------------------------
// Formatting

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFmt.format(d);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFmt.format(d);
}

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "min"],
  ];
  for (const [ms, u] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff < 0 ? `${n}${u === "min" ? " min" : u} ago` : `in ${n}${u === "min" ? " min" : u}`;
    }
  }
  return diff < 0 ? "just now" : "in under a minute";
}

export const fmtNumber = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

export function json(v: unknown): string {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Small components

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className={`notice ${error instanceof AuthError ? "warn" : "error"}`} role="alert">
      {errorText(error)}
      {onRetry && (
        <button type="button" className="link" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  ok: "good",
  will_run: "good",
  fired: "good",
  reachable: "good",
  failed: "bad",
  error: "bad",
  capped: "warn",
  cap_reached: "warn",
  waiting: "info",
  running: "info",
  will_skip: "muted",
  skipped: "muted",
  disabled: "muted",
  stopped: "muted",
  cancelled: "muted",
  refused: "warn",
  info: "info",
};

export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? "muted"}`}>{children ?? status.replace(/_/g, " ")}</span>;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="muted small">{label}</div>;
}

export function Json({ value, label }: { value: unknown; label: string }) {
  if (value === undefined || value === null) return null;
  return (
    <details className="json">
      <summary>{label}</summary>
      <pre>{json(value)}</pre>
    </details>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** The 409 prompt: the file changed on disk (or in another tab) since it was loaded. */
export function StaleDialog({ onReload, onKeep, onOverwrite }: { onReload: () => void; onKeep: () => void; onOverwrite?: () => void }) {
  return (
    <Modal title="This file changed elsewhere" onClose={onKeep}>
      <p>This file changed elsewhere — reload? Reloading shows the version on disk and discards your unsaved changes here.</p>
      <div className="row gap">
        <button type="button" className="primary" onClick={onReload}>
          Reload
        </button>
        <button type="button" onClick={onKeep}>
          Keep editing
        </button>
        {onOverwrite && (
          <button type="button" className="danger" onClick={onOverwrite}>
            Overwrite with mine
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Validation issues by zod path

const pathKey = (p: Path) => p.map(String).join(".");

const IssueContext = createContext<{ issues: Issue[]; prefix: Path }>({ issues: [], prefix: [] });

export function IssueProvider({ issues, prefix = [], children }: { issues: Issue[]; prefix?: Path; children: ReactNode }) {
  return <IssueContext.Provider value={{ issues, prefix }}>{children}</IssueContext.Provider>;
}

/** Issues whose path is exactly `path` (relative to the provider's prefix). */
export function useIssues(path: Path): string[] {
  const { issues, prefix } = useContext(IssueContext);
  const key = pathKey([...prefix, ...path]);
  return issues.filter((i) => pathKey(i.path) === key).map((i) => i.message);
}

export function FieldIssues({ path }: { path: Path }) {
  const msgs = useIssues(path);
  if (!msgs.length) return null;
  return (
    <div className="field-issues" role="alert">
      {msgs.map((m, i) => (
        <div key={i}>{m}</div>
      ))}
    </div>
  );
}

export function IssueSummary({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <div className="notice error" role="alert">
      <strong>The server rejected this:</strong>
      <ul>
        {issues.map((i, n) => (
          <li key={n}>
            {i.path.length ? <code>{i.path.join(".")}</code> : null} {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Field({ label, hint, path, children, className }: { label: ReactNode; hint?: ReactNode; path?: Path; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className ?? ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {path && <FieldIssues path={path} />}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Immutable helpers

export function setIn<T>(obj: T, path: Path, value: unknown): T {
  if (!path.length) return value as T;
  const [head, ...rest] = path;
  const base: unknown = obj ?? (typeof head === "number" ? [] : {});
  if (Array.isArray(base)) {
    const copy = [...base];
    copy[head as number] = setIn(copy[head as number], rest, value);
    return copy as T;
  }
  const copy = { ...(base as Record<string, unknown>) };
  const next = setIn(copy[head as string], rest, value);
  if (next === undefined) delete copy[head as string];
  else copy[head as string] = next;
  return copy as T;
}

/** Drops keys whose value is undefined or "" (empty optional fields aren't written to YAML). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") out[k] = v;
  return out as T;
}
