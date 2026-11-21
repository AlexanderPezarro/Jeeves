import { useState } from "react";
import { api, StaleError } from "../api";
import { RunDetail } from "../RunDetail";
import { Link, navigate } from "../router";
import type { Trigger, WorkflowRun, WorkflowSummary } from "../types";
import { Badge, ErrorBox, relTime, Spinner, useLoad } from "../ui";

export function triggerSummary(t: Trigger): string {
  return "schedule" in t ? `⏰ ${t.schedule}` : `⚡ ${t.event}`;
}

/** Run now / Dry run buttons with the result shown underneath. */
export function RunButtons({ id, disabled }: { id: string; disabled?: boolean }) {
  const [busy, setBusy] = useState<"run" | "dry" | null>(null);
  const [result, setResult] = useState<WorkflowRun | null>(null);
  const [startedId, setStartedId] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const go = async (dry: boolean) => {
    if (!dry && !window.confirm(`Run ${id} now for real? Messages will be sent and plugin tools called.`)) return;
    setBusy(dry ? "dry" : "run");
    setErr(null);
    setResult(null);
    try {
      const r = await api.runWorkflow(id, dry);
      setStartedId(r.workflow_run_id);
      // Real runs return straight away; fetch the latest state once so the user sees progress.
      setResult(r.run ?? (await api.workflowRun(r.workflow_run_id)));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => startedId && setResult(await api.workflowRun(startedId).catch(() => result));

  return (
    <div className="run-buttons">
      <div className="row gap">
        <button type="button" onClick={() => go(true)} disabled={disabled || !!busy} title="Messages are recorded, not sent; only read-only tools are called">
          {busy === "dry" ? "Dry-running…" : "Dry run"}
        </button>
        <button type="button" onClick={() => go(false)} disabled={disabled || !!busy}>
          {busy === "run" ? "Starting…" : "Run now"}
        </button>
      </div>
      <ErrorBox error={err} />
      {result && (
        <div className="run-result">
          <div className="row gap">
            <Badge status={result.status} />
            <span className="small">{result.dry_run ? "Dry run finished" : `Run #${result.id} ${result.status === "running" ? "started" : result.status}`}</span>
            {!result.dry_run && (
              <button type="button" className="link" onClick={refresh}>
                Refresh
              </button>
            )}
            <button type="button" className="link" onClick={() => setResult(null)}>
              Close
            </button>
          </div>
          <RunDetail run={result} />
        </div>
      )}
    </div>
  );
}

export function WorkflowsPage() {
  const list = useLoad(() => api.workflows());
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = async (w: WorkflowSummary) => {
    setErr(null);
    try {
      await api.setEnabled(w.id, !w.enabled, w.hash);
    } catch (e) {
      setErr(e instanceof StaleError ? new Error(`${w.id} changed elsewhere; the list has been reloaded, try again.`) : e);
    }
    list.reload();
  };
  const remove = async (w: WorkflowSummary) => {
    if (!window.confirm(`Delete workflow ${w.id}? This removes workflows/${w.id}.yaml.`)) return;
    setErr(null);
    try {
      await api.deleteWorkflow(w.id, w.hash);
    } catch (e) {
      setErr(e instanceof StaleError ? new Error(`${w.id} changed elsewhere; reload and try again.`) : e);
    }
    list.reload();
  };
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const id = newId.trim();
    if (!/^[a-z0-9-]+$/.test(id)) return setErr(new Error("Workflow ids use lowercase letters, digits and dashes."));
    if (list.data?.workflows.some((w) => w.id === id)) return setErr(new Error(`A workflow called ${id} already exists.`));
    navigate(`/workflows/${encodeURIComponent(id)}?new=1`);
  };

  return (
    <div className="stack">
      <div className="row between wrap">
        <h1>Workflows</h1>
        <form className="row gap" onSubmit={create}>
          <input aria-label="New workflow id" placeholder="new-workflow-id" value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} />
          <button type="submit" className="primary">
            New workflow
          </button>
        </form>
      </div>
      <ErrorBox error={list.error ?? err} onRetry={list.reload} />
      {!list.data && !list.error && <Spinner />}
      {list.data && list.data.workflows.length === 0 && <p className="muted">No workflows yet.</p>}
      <div className="card flush">
        <table className="table workflows-table">
          <thead>
            <tr>
              <th>On</th>
              <th>Workflow</th>
              <th>Triggers</th>
              <th>Steps</th>
              <th>Last run</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.workflows.map((w) => (
              <WorkflowRow key={w.id} w={w} expanded={expanded === w.id} onExpand={() => setExpanded(expanded === w.id ? null : w.id)} onToggle={() => toggle(w)} onDelete={() => remove(w)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkflowRow({ w, expanded, onExpand, onToggle, onDelete }: { w: WorkflowSummary; expanded: boolean; onExpand: () => void; onToggle: () => void; onDelete: () => void }) {
  return (
    <>
      <tr className={w.enabled ? "" : "dim"}>
        <td>
          <label className="switch" title={w.enabled ? "Enabled" : "Disabled"}>
            <input type="checkbox" aria-label={`Enable ${w.id}`} checked={w.enabled} disabled={!w.loaded} onChange={onToggle} />
            <span />
          </label>
        </td>
        <td>
          <Link to={`/workflows/${encodeURIComponent(w.id)}`}>
            <strong>{w.id}</strong>
          </Link>
          {w.description && <div className="small muted">{w.description}</div>}
          {w.error && <div className="small error-text">⚠ {w.error}</div>}
        </td>
        <td className="small">
          {w.triggers.map((t, i) => (
            <div key={i}>{triggerSummary(t)}</div>
          ))}
        </td>
        <td>{w.step_count}</td>
        <td className="small">
          {w.last_run ? (
            <>
              <Badge status={w.last_run.status} /> {relTime(w.last_run.started_at)}
              {w.last_run.error && <div className="error-text">{w.last_run.error}</div>}
            </>
          ) : (
            <span className="muted">never</span>
          )}
        </td>
        <td className="actions">
          <button type="button" onClick={onExpand} aria-expanded={expanded}>
            Run…
          </button>
          <Link to={`/workflows/${encodeURIComponent(w.id)}`} className="button">
            Edit
          </Link>
          <button type="button" className="danger" onClick={onDelete}>
            Delete
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <RunButtons id={w.id} disabled={!w.loaded} />
          </td>
        </tr>
      )}
    </>
  );
}
