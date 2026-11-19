import { useEffect, useId, useMemo, useState } from "react";
import { api, StaleError, ValidationError } from "../api";
import type { Globals, Issue } from "../types";
import { ErrorBox, Field, fmtDateTime, IssueProvider, IssueSummary, Spinner, StaleDialog, useLoad } from "../ui";

const KEYS = ["timezone", "model", "effort", "max_runs_per_day", "about_me", "activity_retention_days"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function SettingsPage() {
  const globals = useLoad(() => api.globals());
  const errors = useLoad(() => api.configErrors());
  const [form, setForm] = useState<Partial<Globals>>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const tzList = useId();
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (globals.data) setForm(Object.fromEntries(KEYS.map((k) => [k, globals.data!.parsed[k]])) as Partial<Globals>);
  }, [globals.data]);

  const patch = useMemo(() => {
    const p: Record<string, unknown> = {};
    if (!globals.data) return p;
    for (const k of KEYS) if (JSON.stringify(form[k]) !== JSON.stringify(globals.data.parsed[k])) p[k] = form[k];
    return p;
  }, [form, globals.data]);
  const dirty = Object.keys(patch).length > 0;

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!globals.data) return;
    setBusy(true);
    setIssues([]);
    setErr(null);
    setNotice(null);
    try {
      const r = await api.saveGlobals(patch as Partial<Globals>, globals.data.hash);
      globals.setData(r);
      setNotice("Saved. The server picks it up straight away.");
      errors.reload();
    } catch (x) {
      if (x instanceof ValidationError) setIssues(x.issues.length ? x.issues : [{ path: [], message: x.message }]);
      else if (x instanceof StaleError) setStale(true);
      else setErr(x);
    } finally {
      setBusy(false);
    }
  };

  const num = (k: "max_runs_per_day" | "activity_retention_days") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value === "" ? undefined : Math.round(Number(e.target.value)) });

  return (
    <div className="stack">
      <h1>Settings</h1>
      <section className="card">
        <h2>Globals</h2>
        <p className="small muted">
          Saved to <code>config/jeeves.yaml</code>; comments and other keys are kept.
        </p>
        <ErrorBox error={globals.error} onRetry={globals.reload} />
        {!globals.data && !globals.error && <Spinner />}
        {globals.data && (
          <IssueProvider issues={issues}>
            <form className="stack-sm" onSubmit={save}>
              <div className="grid2">
                <Field label="Time zone" path={["timezone"]} hint="IANA name, e.g. Europe/London">
                  <input aria-label="Time zone" list={tzList} value={form.timezone ?? ""} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
                  <datalist id={tzList}>
                    {zones.map((z) => (
                      <option key={z} value={z} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Model" path={["model"]}>
                  <input aria-label="Model" className="mono" value={form.model ?? ""} onChange={(e) => setForm({ ...form, model: e.target.value })} />
                </Field>
                <Field label="Effort" path={["effort"]}>
                  <select aria-label="Effort" value={form.effort ?? "low"} onChange={(e) => setForm({ ...form, effort: e.target.value as Globals["effort"] })}>
                    {EFFORTS.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Max Claude runs per day" path={["max_runs_per_day"]} hint="A cost guard; runs beyond it are capped">
                  <input aria-label="Max runs per day" type="number" min={1} value={form.max_runs_per_day ?? ""} onChange={num("max_runs_per_day")} />
                </Field>
                <Field label="Keep activity for (days)" path={["activity_retention_days"]}>
                  <input aria-label="Activity retention days" type="number" min={1} value={form.activity_retention_days ?? ""} onChange={num("activity_retention_days")} />
                </Field>
              </div>
              <Field label="About me" path={["about_me"]} hint="Context every planning run sees">
                <textarea aria-label="About me" rows={5} value={form.about_me ?? ""} onChange={(e) => setForm({ ...form, about_me: e.target.value })} />
              </Field>
              {notice && <div className="notice good">{notice}</div>}
              <ErrorBox error={err} />
              <IssueSummary issues={issues.filter((i) => !i.path.length || !KEYS.includes(i.path[0] as (typeof KEYS)[number]))} />
              <div className="row gap">
                <button type="submit" className="primary" disabled={!dirty || busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
                {dirty && (
                  <button type="button" onClick={() => globals.data && setForm(Object.fromEntries(KEYS.map((k) => [k, globals.data!.parsed[k]])) as Partial<Globals>)}>
                    Discard changes
                  </button>
                )}
              </div>
            </form>
          </IssueProvider>
        )}
      </section>

      <section className="card">
        <div className="row between">
          <h2>Config errors</h2>
          <button type="button" onClick={errors.reload}>
            Refresh
          </button>
        </div>
        <ErrorBox error={errors.error} />
        {errors.data && errors.data.errors.length === 0 && <p className="muted">Every config file loads.</p>}
        <ul className="plain">
          {errors.data?.errors.map((e, i) => (
            <li key={i} className="config-error">
              <code>{e.file}</code> <span className="small muted">{fmtDateTime(e.at)}</span>
              <div className="error-text pre-wrap">{e.error}</div>
            </li>
          ))}
        </ul>
        {errors.data && errors.data.errors.length > 0 && <p className="small muted">A broken file keeps its last good version running until it's fixed.</p>}
      </section>

      {stale && (
        <StaleDialog
          onReload={() => {
            setStale(false);
            globals.reload();
          }}
          onKeep={() => setStale(false)}
        />
      )}
    </div>
  );
}
