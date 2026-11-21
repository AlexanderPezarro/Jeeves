import { useEffect, useState } from "react";
import { api, type ActivityQuery } from "../api";
import { RunDetail } from "../RunDetail";
import { Link } from "../router";
import type { FeedItem } from "../types";
import { Badge, ErrorBox, fmtDateTime, json, Spinner, useLoad } from "../ui";

const KINDS = [
  { key: "workflow_run", label: "Runs" },
  { key: "evaluation", label: "Trigger checks" },
  { key: "config", label: "Config" },
  { key: "plugin", label: "Plugins" },
  { key: "reminder", label: "Reminders" },
];
const STATUSES = ["ok", "failed", "waiting", "running", "stopped", "capped", "cancelled", "fired", "skipped"];

/** <input type="date"> value → ISO at the start (or end) of that local day. */
function dayBound(date: string, end: boolean): string | undefined {
  if (!date) return undefined;
  const [y, m, d] = date.split("-").map(Number);
  return (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
}

const itemKey = (i: FeedItem) => `${i.kind}-${i.id}`;

export function ActivityPage() {
  const workflows = useLoad(() => api.workflows());
  const [workflow, setWorkflow] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const query = (c?: string | null): ActivityQuery => ({
    workflow: workflow || undefined,
    kind: kinds.join(",") || undefined,
    status: status || undefined,
    from: dayBound(from, false),
    to: dayBound(to, true),
    limit: 50,
    cursor: c ?? undefined,
  });

  const load = async (more: boolean) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.activity(query(more ? cursor : null));
      setItems((prev) => {
        if (!more) return r.items;
        const seen = new Set(prev.map(itemKey));
        return [...prev, ...r.items.filter((i) => !seen.has(itemKey(i)))];
      });
      setCursor(r.next_cursor);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(false), [workflow, kinds.join(","), status, from, to]);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Activity</h1>
        <button type="button" onClick={() => load(false)} disabled={loading}>
          Refresh
        </button>
      </div>
      <div className="card filters">
        <label className="field">
          <span className="field-label">Workflow</span>
          <select aria-label="Filter by workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            <option value="">All</option>
            {workflows.data?.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Kind</span>
          <div className="row gap wrap">
            {KINDS.map((k) => (
              <label key={k.key} className="check">
                <input type="checkbox" checked={kinds.includes(k.key)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k.key] : kinds.filter((x) => x !== k.key))} />
                {k.label}
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">Status</span>
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <ErrorBox error={err} onRetry={() => load(false)} />
      {!loading && items.length === 0 && !err && <p className="muted">Nothing matches.</p>}
      <ul className="feed">
        {items.map((i) => (
          <FeedRow key={itemKey(i)} item={i} />
        ))}
      </ul>
      {loading && <Spinner />}
      {cursor && !loading && (
        <button type="button" onClick={() => load(true)}>
          Load more
        </button>
      )}
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const wfLink = (id: string) => <Link to={`/workflows/${encodeURIComponent(id)}`}>{id}</Link>;
  let summary;
  let body: React.ReactNode = null;
  switch (item.kind) {
    case "workflow_run": {
      const failed = item.steps.find((s) => s.status === "failed");
      const tokens = item.steps.reduce((n, s) => n + (s.claude_run?.input_tokens ?? 0) + (s.claude_run?.output_tokens ?? 0), 0);
      summary = (
        <>
          <Badge status={item.status} />
          <span>Run of {wfLink(item.workflow_id)}</span>
          <span className="small muted">
            {item.trigger}
            {item.dry_run ? " · dry run" : ""} · {item.steps.length} step(s)
            {tokens ? ` · ${tokens.toLocaleString()} tokens` : ""}
            {failed ? ` · failed at ${failed.step_id}` : ""}
          </span>
        </>
      );
      body = <RunDetail run={item} />;
      break;
    }
    case "evaluation":
      summary = (
        <>
          <Badge status={item.fired ? "fired" : "skipped"} />
          <span>
            {wfLink(item.workflow_id)} {item.trigger_kind === "schedule" ? "schedule" : "event"} check
          </span>
          <span className="small muted">{item.reason}</span>
          {item.simulated && <Badge status="info">simulated</Badge>}
        </>
      );
      break;
    default: {
      const label: Record<string, string> = {
        config_reload: "Config reloaded",
        config_error: "Config error",
        plugin_connect: "Plugin connected",
        plugin_disconnect: "Plugin disconnected",
        reminder_fired: "Reminder fired",
        item_action: "Button tapped",
      };
      const bad = item.kind === "config_error" || item.kind === "plugin_disconnect";
      summary = (
        <>
          <Badge status={bad ? "failed" : "ok"}>{label[item.kind] ?? item.kind}</Badge>
          {item.subject && <code>{item.subject}</code>}
          <span className="small muted ellipsis">{describeDetail(item.detail)}</span>
        </>
      );
      if (item.detail != null) body = <pre className="mono small">{json(item.detail)}</pre>;
    }
  }
  return (
    <li className={`feed-item ${open ? "open" : ""}`}>
      <div className="row gap feed-summary">
        <span className="time small">{fmtDateTime(item.at)}</span>
        {summary}
        <span className="grow" />
        {body && (
          <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Details"}
          </button>
        )}
      </div>
      {open && body && <div className="feed-body">{body}</div>}
    </li>
  );
}

function describeDetail(d: unknown): string {
  if (!d || typeof d !== "object") return d == null ? "" : String(d);
  const o = d as Record<string, unknown>;
  if (typeof o.error === "string") return o.error;
  const parts: string[] = [];
  for (const k of ["added", "removed", "changed"]) {
    const v = o[k];
    if (Array.isArray(v) && v.length) parts.push(`${k}: ${v.join(", ")}`);
  }
  return parts.join(" · ");
}
