import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseDocument } from "yaml";
import { api, ApiError, StaleError, ValidationError } from "../api";
import { collectFieldPaths, collectStepIds, EditorDataContext, FIELD_PATHS_LIST, type EditorData } from "../editor/context";
import { SimulatePanel } from "../editor/Simulate";
import { StepList } from "../editor/Steps";
import { TriggersEditor } from "../editor/Triggers";
import { applyToYaml, parseWorkflowYaml, toYaml } from "../editor/yamlSync";
import { Link, navigate, setNavigationGuard } from "../router";
import type { Issue, WorkflowDoc } from "../types";
import { ErrorBox, errorText, Field, FieldIssues, IssueProvider, IssueSummary, Spinner, StaleDialog } from "../ui";
import { RunButtons } from "./Workflows";

type Tab = "form" | "yaml";

function template(id: string): WorkflowDoc {
  return {
    id,
    description: "",
    triggers: [{ event: "manual.plan" }],
    steps: [{ id: "hello", message: { text: "Hello from Jeeves" } }],
  };
}

export function WorkflowEditorPage({ id, isNew }: { id: string; isNew: boolean }) {
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [savedYaml, setSavedYaml] = useState("");
  const [base, setBase] = useState<WorkflowDoc | null>(null);
  const [draft, setDraft] = useState<WorkflowDoc>(() => template(id));
  const [yamlDraft, setYamlDraft] = useState("");
  const [formDirty, setFormDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("form");
  const [tabErr, setTabErr] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [stale, setStale] = useState<StaleError | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exists, setExists] = useState(!isNew);

  const [data, setData] = useState<Omit<EditorData, "allStepIds" | "fieldPaths">>({ tools: [], toolsError: null, eventTypes: [], events: [], timezone: "UTC" });

  /** Takes a file as it is on disk as the new baseline. */
  const init = useCallback(
    (yaml: string, h: string | null, serverError?: string | null) => {
      setSavedYaml(yaml);
      setYamlDraft(yaml);
      setHash(h);
      setFormDirty(false);
      setIssues([]);
      setSaveErr(null);
      setFileError(serverError ?? null);
      const parsed = parseWorkflowYaml(yaml);
      if ("doc" in parsed) {
        const doc = { ...parsed.doc, id };
        setDraft(doc);
        setBase(doc);
        setTabErr(null);
      } else {
        setTab("yaml");
        setTabErr(`The form can't show this file until the YAML parses: ${parsed.error}`);
      }
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .workflow(id)
      .then((f) => {
        if (cancelled) return;
        setExists(true);
        init(f.yaml, f.hash, f.error);
        if (isNew) setNotice(`A workflow called ${id} already exists; editing it.`);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404 && isNew) {
          const t = template(id);
          setExists(false);
          setDraft(t);
          setBase(null);
          setSavedYaml("");
          setYamlDraft(toYaml(t));
          setFormDirty(true);
          setHash(null);
        } else setLoadErr(e);
      })
      .finally(() => !cancelled && setLoading(false));
    api
      .tools()
      .then((r) => setData((d) => ({ ...d, tools: r.tools, toolsError: null })))
      .catch((e) => setData((d) => ({ ...d, toolsError: errorText(e) })));
    api
      .eventTypes()
      .then((r) => setData((d) => ({ ...d, eventTypes: r.event_types, events: r.events ?? [] })))
      .catch(() => {});
    api
      .globals()
      .then((r) => setData((d) => ({ ...d, timezone: r.parsed.timezone })))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, isNew, init]);

  const dirty = formDirty || yamlDraft !== savedYaml;

  // Warn before leaving with unsaved changes.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    setNavigationGuard(() => !dirtyRef.current || window.confirm("You have unsaved changes. Leave anyway?"));
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      setNavigationGuard(null);
    };
  }, []);

  const editForm = (next: WorkflowDoc) => {
    setDraft(next);
    setFormDirty(true);
    setNotice(null);
  };

  /** Optional top-level keys: leave them out of the YAML when they equal the default and weren't there. */
  const setOptional = (key: string, value: unknown, dflt: unknown) => {
    const next = { ...draft };
    if (value === dflt && !(base && key in base)) delete next[key];
    else next[key] = value;
    editForm(next);
  };

  const switchTab = (to: Tab) => {
    if (to === tab) return;
    if (to === "yaml") {
      if (formDirty) {
        setYamlDraft(applyToYaml(yamlDraft || savedYaml, draft));
        setFormDirty(false);
      }
      setTabErr(null);
      setTab("yaml");
    } else {
      const parsed = parseWorkflowYaml(yamlDraft);
      if ("error" in parsed) return setTabErr(`Fix the YAML before switching to the form: ${parsed.error}`);
      setDraft({ ...parsed.doc, id });
      setTabErr(null);
      setTab("form");
    }
  };

  const save = async (overrideHash?: string | null) => {
    setSaving(true);
    setIssues([]);
    setSaveErr(null);
    setNotice(null);
    const h = overrideHash !== undefined ? overrideHash : hash;
    try {
      let body: Parameters<typeof api.saveWorkflow>[1];
      if (tab === "yaml") body = { yaml: yamlDraft, hash: h };
      // Text edited in the YAML tab (e.g. new comments) is kept by merging the form into it.
      else if (yamlDraft !== savedYaml && exists) body = { yaml: applyToYaml(yamlDraft, { ...draft, id }), hash: h };
      else body = { workflow: { ...draft, id }, hash: h };
      const res = await api.saveWorkflow(id, body);
      init(res.yaml, res.hash);
      dirtyRef.current = false;
      setExists(true);
      setNotice("Saved.");
      if (isNew) navigate(`/workflows/${encodeURIComponent(id)}`, { replace: true });
    } catch (e) {
      if (e instanceof StaleError) setStale(e);
      else if (e instanceof ValidationError) {
        setIssues(e.issues.length ? e.issues : [{ path: [], message: e.message }]);
      } else setSaveErr(e);
    } finally {
      setSaving(false);
    }
  };

  const yamlParseError = useMemo(() => {
    if (tab !== "yaml") return null;
    const d = parseDocument(yamlDraft);
    return d.errors.length ? d.errors.map((e) => e.message).join("; ") : null;
  }, [tab, yamlDraft]);

  const editorData: EditorData = useMemo(
    () => ({
      ...data,
      allStepIds: collectStepIds(draft.steps),
      fieldPaths: collectFieldPaths(draft.triggers, draft.steps, data.tools, data.events),
    }),
    [data, draft.steps, draft.triggers],
  );

  if (loading) return <Spinner />;
  if (loadErr)
    return (
      <div className="stack">
        <Link to="/workflows">← Workflows</Link>
        <ErrorBox error={loadErr} />
      </div>
    );

  const cooldown = draft.cooldown ?? "daily";
  const firstEvent = draft.triggers.find((t): t is { event: string } => "event" in t)?.event;

  return (
    <EditorDataContext.Provider value={editorData}>
      <IssueProvider issues={issues}>
        <div className="stack">
          <div className="row between wrap">
            <div>
              <Link to="/workflows" className="small">
                ← Workflows
              </Link>
              <h1>
                {id} {!exists && <span className="badge info">new</span>}
              </h1>
            </div>
            <div className="row gap">
              {dirty && <span className="small muted">Unsaved changes</span>}
              <button type="button" className="primary" onClick={() => save()} disabled={saving || (tab === "yaml" && !!yamlParseError)}>
                {saving ? "Saving…" : exists ? "Save" : "Create"}
              </button>
            </div>
          </div>

          {notice && (
            <div className="notice good" role="status">
              {notice}
            </div>
          )}
          {fileError && (
            <div className="notice warn">
              The file on disk doesn't load right now (the last good version keeps running): {fileError}
            </div>
          )}
          <ErrorBox error={saveErr} />
          <IssueSummary issues={issues} />

          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "form"} className={tab === "form" ? "active" : ""} onClick={() => switchTab("form")}>
              Form
            </button>
            <button type="button" role="tab" aria-selected={tab === "yaml"} className={tab === "yaml" ? "active" : ""} onClick={() => switchTab("yaml")}>
              YAML
            </button>
          </div>
          {tabErr && <div className="notice warn">{tabErr}</div>}

          {tab === "form" ? (
            <div className="stack">
              <p className="small muted">
                Form saves keep comments on the parts you don't change. Adding, removing or reordering steps or triggers rewrites that list, which can drop comments inside it;
                use the YAML tab for comment-heavy files.
              </p>
              <section className="card">
                <h2>Basics</h2>
                <div className="grid2">
                  <Field label="Description" path={["description"]}>
                    <input aria-label="Description" value={draft.description ?? ""} onChange={(e) => setOptional("description", e.target.value || undefined, undefined)} />
                  </Field>
                  <Field label="Cooldown" path={["cooldown"]} hint="How often it may fire at most">
                    <div className="row gap">
                      <select
                        aria-label="Cooldown kind"
                        value={cooldown === "daily" ? "daily" : "minutes"}
                        onChange={(e) => setOptional("cooldown", e.target.value === "daily" ? "daily" : 60, "daily")}
                      >
                        <option value="daily">Once a day</option>
                        <option value="minutes">Every N minutes</option>
                      </select>
                      {cooldown !== "daily" && (
                        <input
                          aria-label="Cooldown minutes"
                          type="number"
                          min={0}
                          value={cooldown}
                          onChange={(e) => setOptional("cooldown", Math.max(0, Math.round(Number(e.target.value))), "daily")}
                        />
                      )}
                    </div>
                  </Field>
                </div>
                <div className="row gap wrap">
                  <label className="check">
                    <input type="checkbox" aria-label="Enabled" checked={draft.enabled !== false} onChange={(e) => setOptional("enabled", e.target.checked, true)} />
                    Enabled
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={draft.notify_on_failure !== false} onChange={(e) => setOptional("notify_on_failure", e.target.checked, true)} />
                    Message me if it fails
                  </label>
                </div>
                <FieldIssues path={["enabled"]} />
                <FieldIssues path={["id"]} />
                <FieldIssues path={[]} />
              </section>
              <section className="card">
                <h2>Triggers</h2>
                <TriggersEditor value={draft.triggers} onChange={(t) => editForm({ ...draft, triggers: t })} />
              </section>
              <section className="card">
                <h2>Steps</h2>
                <StepList steps={draft.steps} path={["steps"]} label="steps" onChange={(s) => editForm({ ...draft, steps: s })} />
              </section>
            </div>
          ) : (
            <section className="card">
              <textarea
                aria-label="Workflow YAML"
                className="mono yaml-editor"
                spellCheck={false}
                value={yamlDraft}
                onChange={(e) => {
                  setYamlDraft(e.target.value);
                  setNotice(null);
                }}
              />
              {yamlParseError ? <div className="field-issues">YAML error: {yamlParseError}</div> : <div className="hint">Saved verbatim, comments and all, if it validates.</div>}
            </section>
          )}

          <div className="grid2 top">
            <section className="card">
              <h2>Run</h2>
              {dirty && <p className="small muted">Runs use the saved version.</p>}
              <RunButtons id={id} disabled={!exists} />
            </section>
            <section className="card">
              <h2>Simulate</h2>
              <SimulatePanel workflowId={id} defaultEvent={firstEvent} />
            </section>
          </div>
        </div>

        {stale && (
          <StaleDialog
            onReload={() => {
              const cur = stale.current;
              setStale(null);
              if (cur) {
                init(cur.yaml, cur.hash);
                setNotice("Reloaded the version on disk.");
              } else {
                setExists(false);
                setHash(null);
                setSaveErr(new Error("The file was deleted elsewhere. Saving will create it again."));
              }
            }}
            onKeep={() => setStale(null)}
            onOverwrite={() => {
              const cur = stale.current;
              setStale(null);
              void save(cur?.hash ?? null);
            }}
          />
        )}
      </IssueProvider>
      <datalist id={FIELD_PATHS_LIST}>
        {editorData.fieldPaths.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </EditorDataContext.Provider>
  );
}
