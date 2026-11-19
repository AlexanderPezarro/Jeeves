import { useState } from "react";
import { api } from "../api";
import { Link } from "../router";
import type { UpcomingItem } from "../types";
import { Badge, ErrorBox, fmtNumber, fmtTime, relTime, Spinner, useLoad } from "../ui";

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short" });

export function DashboardPage() {
  const health = useLoad(() => api.health());
  const upcoming = useLoad(() => api.upcoming(48));
  const [cancelErr, setCancelErr] = useState<unknown>(null);

  const cancel = async (item: Extract<UpcomingItem, { job_id: number }>) => {
    const what = item.kind === "wait" ? `the waiting run of ${item.workflow_id}` : "this follow-up";
    if (!window.confirm(`Cancel ${what}?`)) return;
    setCancelErr(null);
    try {
      await api.cancelJob(item.job_id);
      upcoming.reload();
      health.reload();
    } catch (e) {
      setCancelErr(e);
    }
  };

  const h = health.data;
  const reachable = h?.plugins.filter((p) => p.reachable).length ?? 0;

  // Group upcoming items by local day.
  const groups: { day: string; items: UpcomingItem[] }[] = [];
  for (const it of upcoming.data?.items ?? []) {
    const day = dayFmt.format(new Date(it.at));
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(it);
  }

  return (
    <div className="stack">
      <h1>Dashboard</h1>
      <ErrorBox error={health.error} onRetry={health.reload} />
      {h ? (
        <div className="cards">
          <div className={`card stat ${h.runs_today >= h.max_runs_per_day ? "warn" : ""}`}>
            <div className="stat-label">Claude runs today</div>
            <div className="stat-value">
              {h.runs_today} <span className="muted">/ {h.max_runs_per_day}</span>
            </div>
            <div className="small muted">{h.runs_today >= h.max_runs_per_day ? "Daily cap reached" : `${h.max_runs_per_day - h.runs_today} left`}</div>
          </div>
          <div className="card stat">
            <div className="stat-label">Tokens, last 7 days</div>
            <div className="stat-value">{fmtNumber(h.tokens_7d.input_tokens + h.tokens_7d.output_tokens)}</div>
            <div className="small muted">
              {fmtNumber(h.tokens_7d.input_tokens)} in · {fmtNumber(h.tokens_7d.output_tokens)} out · {h.tokens_7d.runs} runs
            </div>
          </div>
          <Link to="/workflows" className="card stat">
            <div className="stat-label">Workflows</div>
            <div className="stat-value">
              {h.workflows.enabled} <span className="muted">/ {h.workflows.total} on</span>
            </div>
            <div className="small muted">{h.waiting_runs ? `${h.waiting_runs} run(s) waiting` : "none waiting"}</div>
          </Link>
          <Link to="/plugins" className={`card stat ${reachable < h.plugins.length ? "bad" : ""}`}>
            <div className="stat-label">Plugins</div>
            <div className="stat-value">
              {reachable} <span className="muted">/ {h.plugins.length} up</span>
            </div>
            <div className="small muted">{h.plugins.filter((p) => !p.reachable).map((p) => p.name).join(", ") || "all reachable"}</div>
          </Link>
          <Link to="/settings" className={`card stat ${h.config_errors.length ? "bad" : ""}`}>
            <div className="stat-label">Config errors</div>
            <div className="stat-value">{h.config_errors.length}</div>
            <div className="small muted">{h.config_errors.map((e) => e.file).join(", ") || "all files load"}</div>
          </Link>
          <div className="card stat">
            <div className="stat-label">Devices</div>
            {h.devices.length === 0 ? (
              <div className="small muted">No paired devices yet.</div>
            ) : (
              <ul className="plain small">
                {h.devices.map((d) => (
                  <li key={d.device_id}>
                    <strong>{d.name}</strong>: {d.last_event_type ?? "no events"} {d.last_event_at ? relTime(d.last_event_at) : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        !health.error && <Spinner />
      )}

      <section className="card">
        <div className="row between">
          <h2>Upcoming 48h</h2>
          <button type="button" onClick={upcoming.reload} disabled={upcoming.loading}>
            Refresh
          </button>
        </div>
        {h && <p className="small muted">Times shown in your browser's zone; workflows run in {h.timezone}.</p>}
        <ErrorBox error={upcoming.error ?? cancelErr} onRetry={upcoming.reload} />
        {upcoming.data && groups.length === 0 && <p className="muted">Nothing scheduled in the next 48 hours.</p>}
        {groups.map((g) => (
          <div key={g.day}>
            <h3 className="day">{g.day}</h3>
            <ul className="timeline">
              {g.items.map((it) => (
                <li key={`${it.kind}-${"job_id" in it ? it.job_id : it.workflow_id}-${it.at}`} className={it.kind === "schedule" && it.status !== "will_run" ? "dim" : ""}>
                  <span className="time">{fmtTime(it.at)}</span>
                  {it.kind === "schedule" && (
                    <>
                      <Badge status={it.status} />
                      <Link to={`/workflows/${encodeURIComponent(it.workflow_id)}`}>{it.workflow_id}</Link>
                      <code className="small muted">{it.schedule}</code>
                      {it.reason && <span className="muted small">— {it.reason}</span>}
                    </>
                  )}
                  {it.kind === "wait" && (
                    <>
                      <Badge status="waiting">resumes</Badge>
                      <Link to={`/workflows/${encodeURIComponent(it.workflow_id)}`}>{it.workflow_id}</Link>
                      <span className="small muted">
                        run #{it.workflow_run_id}, next step {it.next_step ? <code>{it.next_step}</code> : "(end)"}
                        {it.dry_run ? " · dry run" : ""}
                      </span>
                      <button type="button" className="small-btn" onClick={() => cancel(it)}>
                        Cancel
                      </button>
                    </>
                  )}
                  {it.kind === "followup" && (
                    <>
                      <Badge status="info">follow-up</Badge>
                      <span>{it.message}</span>
                      {it.task_id != null && <span className="small muted">task #{it.task_id}</span>}
                      <button type="button" className="small-btn" onClick={() => cancel(it)}>
                        Cancel
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Waiting for…</h2>
        {upcoming.data && upcoming.data.waiting_for.length === 0 && <p className="muted">No event triggers.</p>}
        <ul className="plain">
          {upcoming.data?.waiting_for.map((w, i) => (
            <li key={i} className={w.enabled ? "" : "dim"}>
              <Link to={`/workflows/${encodeURIComponent(w.workflow_id)}`}>{w.workflow_id}</Link>: {w.description}
              {!w.enabled && <Badge status="disabled" />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
