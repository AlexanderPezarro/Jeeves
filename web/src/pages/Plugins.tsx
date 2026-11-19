import { useEffect, useState } from "react";
import { api, StaleError, UpstreamError, ValidationError } from "../api";
import { Link, navigate } from "../router";
import { SchemaForm } from "../SchemaForm";
import type { Issue, PluginEntry, PluginSettings } from "../types";
import { Badge, ErrorBox, Field, IssueProvider, IssueSummary, relTime, Spinner, StaleDialog, useLoad } from "../ui";

export function PluginsPage({ selected }: { selected?: string }) {
  const list = useLoad(() => api.plugins());
  const [err, setErr] = useState<unknown>(null);

  const remove = async (p: PluginEntry) => {
    if (!window.confirm(`Remove plugin ${p.name} from jeeves.yaml? Its settings file stays.`)) return;
    setErr(null);
    try {
      await api.removePlugin(p.name, list.data?.hash ?? null);
      if (selected === p.name) navigate("/plugins");
    } catch (e) {
      setErr(e instanceof StaleError ? new Error("jeeves.yaml changed elsewhere; the list was reloaded, try again.") : e);
    }
    list.reload();
  };

  const current = list.data?.plugins.find((p) => p.name === selected);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Plugins</h1>
        <button type="button" onClick={list.reload} disabled={list.loading}>
          Refresh
        </button>
      </div>
      <ErrorBox error={list.error ?? err} onRetry={list.reload} />
      {!list.data && !list.error && <Spinner />}
      {list.data && (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Status</th>
                <th>Tools</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.plugins.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No plugins configured.
                  </td>
                </tr>
              )}
              {list.data.plugins.map((p) => (
                <tr key={p.name} className={p.name === selected ? "selected" : ""}>
                  <td>
                    <Link to={`/plugins/${encodeURIComponent(p.name)}`}>
                      <strong>{p.manifest?.display_name ?? p.name}</strong>
                    </Link>{" "}
                    {p.manifest && <span className="small muted">v{p.manifest.version}</span>}
                    <div className="small muted mono">
                      {p.name} · {p.url} · token from <code>{p.token_env}</code>
                    </div>
                  </td>
                  <td>
                    {p.status?.reachable ? <Badge status="ok">reachable</Badge> : p.status?.reachable === false ? <Badge status="failed">unreachable</Badge> : <Badge status="muted">unknown</Badge>}
                    {p.status?.last_error && <div className="small error-text">{p.status.last_error}</div>}
                  </td>
                  <td>{p.status?.tool_count ?? "—"}</td>
                  <td className="small">{relTime(p.status?.last_seen)}</td>
                  <td className="actions">
                    <Link to={`/plugins/${encodeURIComponent(p.name)}`} className="button">
                      Open
                    </Link>
                    <button type="button" className="danger" onClick={() => remove(p)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && list.data && !current && <div className="notice warn">No plugin called {selected}.</div>}
      {current && <PluginDetail key={current.name} plugin={current} />}
      {list.data && <AddPlugin hash={list.data.hash} onAdded={list.reload} />}
    </div>
  );
}

function AddPlugin({ hash, onAdded }: { hash: string; onAdded: () => void }) {
  const [form, setForm] = useState({ name: "", url: "http://", token_env: "" });
  const [issues, setIssues] = useState<Issue[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssues([]);
    setErr(null);
    try {
      await api.addPlugin(form, hash);
      setForm({ name: "", url: "http://", token_env: "" });
      onAdded();
    } catch (x) {
      if (x instanceof ValidationError) setIssues(x.issues.length ? x.issues : [{ path: [], message: x.message }]);
      else if (x instanceof StaleError) {
        setErr(new Error("jeeves.yaml changed elsewhere; reloaded. Submit again."));
        onAdded();
      } else setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Add a plugin</h2>
      <IssueProvider issues={issues}>
        <form className="stack-sm" onSubmit={submit}>
          <div className="grid3">
            <Field label="Name" path={["name"]} hint="lowercase, digits, underscores">
              <input aria-label="Plugin name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="MCP URL" path={["url"]} hint="e.g. http://todo:8081/mcp">
              <input aria-label="Plugin URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </Field>
            <Field label="Token env var" path={["token_env"]} hint="The bearer token's value goes in .env">
              <input
                aria-label="Token env var"
                className="mono"
                value={form.token_env}
                onChange={(e) => setForm({ ...form, token_env: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
              />
            </Field>
          </div>
          <ErrorBox error={err} />
          {issues.some((i) => !i.path.length) && <IssueSummary issues={issues.filter((i) => !i.path.length)} />}
          <div>
            <button type="submit" className="primary" disabled={busy || !form.name || !form.token_env}>
              Add plugin
            </button>
          </div>
        </form>
      </IssueProvider>
    </section>
  );
}

function PluginDetail({ plugin }: { plugin: PluginEntry }) {
  const m = plugin.manifest;
  return (
    <div className="stack">
      <section className="card">
        <h2>{m?.display_name ?? plugin.name} settings</h2>
        {!m && <p className="muted">This plugin has no manifest (tools only), so there is nothing to configure here.</p>}
        {m && !m.settings_schema && <p className="muted">This plugin has no settings.</p>}
        {m?.settings_schema && <SettingsForm name={plugin.name} />}
        {m && (
          <div className="small muted">
            {m.events.length > 0 && (
              <div>
                Events it can send:{" "}
                {m.events.map((e) => (
                  <code key={e}>
                    {plugin.name}.{e}
                  </code>
                ))}
              </div>
            )}
            {m.today && <div>Provides the app's Today list.</div>}
          </div>
        )}
      </section>
      {m?.ui && (
        <section className="card">
          <div className="row between">
            <h2>{m.ui.title}</h2>
            <a href={api.pluginUiUrl(plugin.name)} target="_blank" rel="noreferrer" className="small">
              Open in new tab ↗
            </a>
          </div>
          <iframe className="plugin-frame" src={api.pluginUiUrl(plugin.name)} title={m.ui.title} />
        </section>
      )}
    </div>
  );
}

function SettingsForm({ name }: { name: string }) {
  const [data, setData] = useState<PluginSettings | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoadErr(null);
    try {
      const s = await api.pluginSettings(name);
      setData(s);
      setValues(s.values ?? {});
      setIssues([]);
    } catch (e) {
      setLoadErr(e);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [name]);

  const save = async (hash = data?.hash ?? null) => {
    setBusy(true);
    setIssues([]);
    setErr(null);
    setNotice(null);
    try {
      const s = await api.savePluginSettings(name, values, hash || null);
      setData(s);
      setValues(s.values ?? {});
      setNotice("Saved and sent to the plugin.");
    } catch (e) {
      if (e instanceof ValidationError) setIssues(e.issues.length ? e.issues : [{ path: [], message: e.message }]);
      else if (e instanceof StaleError) setStale(true);
      else if (e instanceof UpstreamError) {
        // Saved to config/plugins/<name>.yaml, but the plugin refused or was unreachable.
        if (data && typeof e.body.hash === "string") setData({ ...data, hash: e.body.hash });
        setErr(e);
      } else setErr(e);
    } finally {
      setBusy(false);
    }
  };

  if (loadErr) return <ErrorBox error={loadErr} onRetry={load} />;
  if (!data) return <Spinner />;
  return (
    <IssueProvider issues={issues}>
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SchemaForm schema={data.schema} value={values} onChange={setValues} issuePath={["values"]} />
        {notice && <div className="notice good">{notice}</div>}
        <ErrorBox error={err} />
        <IssueSummary issues={issues.filter((i) => i.path.length <= 1)} />
        <div className="row gap">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          <button type="button" onClick={() => setValues(data.values ?? {})} disabled={busy}>
            Reset
          </button>
        </div>
        <p className="hint">
          Stored in <code>config/plugins/{name}.yaml</code>.
        </p>
      </form>
      {stale && (
        <StaleDialog
          onReload={() => {
            setStale(false);
            void load();
          }}
          onKeep={() => setStale(false)}
        />
      )}
    </IssueProvider>
  );
}
