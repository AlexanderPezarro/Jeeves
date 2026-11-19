import { useId, useState } from "react";
import { api } from "../api";
import type { Decision } from "../types";
import { Badge, ErrorBox, Field, fmtDateTime } from "../ui";
import { useEditorData } from "./context";

/** "What would happen if this event arrived (at this time)?" Evaluates triggers only; nothing runs. */
export function SimulatePanel({ workflowId, defaultEvent }: { workflowId: string; defaultEvent?: string }) {
  const { eventTypes } = useEditorData();
  const listId = useId();
  const [eventType, setEventType] = useState(defaultEvent ?? "wifi.connected");
  const [payload, setPayload] = useState('{\n  "ssid": "home"\n}');
  const [at, setAt] = useState("");
  const [result, setResult] = useState<{ at: string; decisions: Decision[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    let body: Record<string, unknown>;
    try {
      body = payload.trim() ? JSON.parse(payload) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("the payload must be a JSON object");
    } catch (x) {
      return setErr(new Error(`Payload: ${(x as Error).message}`));
    }
    setBusy(true);
    try {
      setResult(await api.simulate(eventType, body, at ? new Date(at).toISOString() : undefined));
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack-sm" onSubmit={run}>
      <p className="small muted">Checks which workflows' triggers would fire for an event. Uses the saved config; nothing runs and nothing is recorded.</p>
      <div className="grid2">
        <Field label="Event type">
          <input aria-label="Simulated event type" className="mono" list={listId} value={eventType} onChange={(e) => setEventType(e.target.value.trim())} />
          <datalist id={listId}>
            {eventTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field label="At (optional, defaults to now)">
          <input aria-label="Simulated time" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
      </div>
      <Field label="Payload (JSON)">
        <textarea aria-label="Simulated payload" className="mono" rows={4} value={payload} onChange={(e) => setPayload(e.target.value)} />
      </Field>
      <div>
        <button type="submit" disabled={busy || !eventType}>
          {busy ? "Simulating…" : "Simulate"}
        </button>
      </div>
      <ErrorBox error={err} />
      {result && (
        <div>
          <div className="small muted">At {fmtDateTime(result.at)}:</div>
          {result.decisions.length === 0 ? (
            <p className="muted">No workflow listens for {eventType}.</p>
          ) : (
            <ul className="plain">
              {result.decisions.map((d) => (
                <li key={d.workflow_id} className={d.workflow_id === workflowId ? "highlight" : ""}>
                  <Badge status={d.fired ? "fired" : "skipped"}>{d.fired ? "would fire" : "would skip"}</Badge> <strong>{d.workflow_id}</strong>
                  {d.reason && <span className="muted small"> — {d.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
