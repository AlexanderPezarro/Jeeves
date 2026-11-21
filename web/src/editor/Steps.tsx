import { useState } from "react";
import { isObjectSchema, JsonTextarea, SchemaForm } from "../SchemaForm";
import { STEP_TYPES, stepType, type CondExpr, type Effort, type PhoneAction, type Path, type Step, type StepType } from "../types";
import { Field, FieldIssues } from "../ui";
import { CondExprEditor } from "./Conditions";
import { BUILTIN_CLAUDE_TOOLS, uniqueId, useEditorData } from "./context";

const TYPE_LABEL: Record<StepType, string> = {
  message: "Send a message",
  claude: "Ask Claude",
  call: "Call a plugin tool",
  wait: "Wait",
  if: "If / else",
  stop: "Stop",
  phone: "Phone action",
};

/** Suggested model ids for a step's override (any claude-* id is accepted). */
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];

/** How to insert values, plus the fields this workflow's events and steps provide (from their schemas). */
function TemplateHint() {
  const { fieldPaths } = useEditorData();
  const shown = fieldPaths.filter((p) => !/\.\d+$/.test(p)).slice(0, 8);
  return (
    <>
      Use {"{{event.field}}"} or {"{{steps.<earlier id>.field}}"} to insert values.
      {shown.length > 0 && (
        <>
          {" "}Available: {shown.map((p, i) => (
            <span key={p}>
              {i > 0 && ", "}
              <code>{p}</code>
            </span>
          ))}
          {fieldPaths.length > shown.length && " …"}
        </>
      )}
    </>
  );
}
const TEMPLATE_HINT = <TemplateHint />;

export function StepList({ steps, onChange, path, label }: { steps: Step[]; onChange: (s: Step[]) => void; path: Path; label: string }) {
  const { allStepIds, tools } = useEditorData();
  const [type, setType] = useState<StepType>("message");
  const add = () => {
    const id = uniqueId(type === "if" ? "check" : type, allStepIds);
    const first = tools[0];
    const step: Step =
      type === "message"
        ? { id, message: { text: "" } }
        : type === "claude"
          ? { id, claude: { prompt: "" } }
          : type === "call"
            ? { id, call: { plugin: first?.plugin ?? "", tool: first?.tool ?? "" } }
            : type === "phone"
              ? { id, phone: { action: "media", command: "pause" } }
              : type === "wait"
              ? { id, wait: { minutes: 10 } }
              : type === "if"
                ? { id, if: { path: "event.", eq: "" }, then: [] }
                : { id, stop: {} };
    onChange([...steps, step]);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="step-list">
      {steps.length === 0 && <p className="muted small">No steps{label === "steps" ? "" : ` in ${label}`}.</p>}
      {steps.map((s, i) => (
        <StepCard
          key={i}
          step={s}
          index={i}
          path={[...path, i]}
          onChange={(ns) => onChange(steps.map((x, j) => (j === i ? ns : x)))}
          onRemove={() => onChange(steps.filter((_, j) => j !== i))}
          onUp={i > 0 ? () => move(i, -1) : undefined}
          onDown={i < steps.length - 1 ? () => move(i, 1) : undefined}
        />
      ))}
      <div className="row gap add-step">
        <select aria-label={`New step type (${label})`} value={type} onChange={(e) => setType(e.target.value as StepType)}>
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]} ({t})
            </option>
          ))}
        </select>
        <button type="button" className="small-btn" onClick={add} aria-label={`Add step to ${label}`}>
          + Add step
        </button>
      </div>
      <FieldIssues path={path} />
    </div>
  );
}

function StepCard({
  step,
  index,
  path,
  onChange,
  onRemove,
  onUp,
  onDown,
}: {
  step: Step;
  index: number;
  path: Path;
  onChange: (s: Step) => void;
  onRemove: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const t = stepType(step);
  return (
    <div className={`step-card type-${t ?? "unknown"}`} data-step-id={step.id}>
      <div className="step-head row gap">
        <span className="step-num">{index + 1}</span>
        <span className="badge info">{t ?? "?"}</span>
        <input
          aria-label="Step id"
          className="mono step-id"
          value={step.id ?? ""}
          onChange={(e) => onChange({ ...step, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
        />
        <span className="grow" />
        <button type="button" className="icon" aria-label="Move step up" disabled={!onUp} onClick={onUp}>
          ↑
        </button>
        <button type="button" className="icon" aria-label="Move step down" disabled={!onDown} onClick={onDown}>
          ↓
        </button>
        <button
          type="button"
          className="icon danger"
          aria-label="Delete step"
          onClick={() => (t !== "if" || !("then" in step) || (step.then.length === 0 && !step.else?.length) || window.confirm("Delete this step and its branches?")) && onRemove()}
        >
          ✕
        </button>
      </div>
      <FieldIssues path={path} />
      <FieldIssues path={[...path, "id"]} />
      <div className="step-body">{t ? <StepBody step={step} onChange={onChange} path={path} /> : <UnknownStep step={step} onChange={onChange} />}</div>
    </div>
  );
}

function UnknownStep({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  return (
    <Field label="Step (JSON)" hint="This step has no known type key, so it is edited as JSON.">
      <JsonTextarea value={step} onChange={(v) => v && typeof v === "object" && onChange(v as Step)} />
    </Field>
  );
}

function StepBody({ step, onChange, path }: { step: Step; onChange: (s: Step) => void; path: Path }) {
  if ("message" in step) {
    const p = [...path, "message"];
    return (
      <Field label="Message text" path={[...p, "text"]} hint={TEMPLATE_HINT}>
        <textarea aria-label="Message text" rows={3} value={step.message?.text ?? ""} onChange={(e) => onChange({ ...step, message: { ...step.message, text: e.target.value } })} />
        {step.message?.items && <span className="hint">This message also has {step.message.items.length} fixed item(s); edit them in the YAML tab.</span>}
        <FieldIssues path={p} />
      </Field>
    );
  }
  if ("claude" in step) return <ClaudeStep step={step} onChange={onChange} path={path} />;
  if ("call" in step) return <CallStep step={step} onChange={onChange} path={path} />;
  if ("wait" in step) {
    const p = [...path, "wait"];
    const w = step.wait ?? { minutes: 10 };
    const mode = "until" in w ? "until" : "minutes";
    return (
      <div className="row gap wrap">
        <select aria-label="Wait mode" value={mode} onChange={(e) => onChange({ ...step, wait: e.target.value === "until" ? { until: "18:00" } : { minutes: 10 } })}>
          <option value="minutes">for some minutes</option>
          <option value="until">until a time of day</option>
        </select>
        {"until" in w ? (
          <Field label="Until (HH:MM, next occurrence)" path={[...p, "until"]}>
            <input aria-label="Wait until" type="time" value={w.until} onChange={(e) => onChange({ ...step, wait: { until: e.target.value } })} />
          </Field>
        ) : (
          <Field label="Minutes" path={[...p, "minutes"]}>
            <input aria-label="Wait minutes" type="number" min={1} max={10080} value={w.minutes ?? ""} onChange={(e) => onChange({ ...step, wait: { minutes: Math.round(Number(e.target.value)) } })} />
          </Field>
        )}
        <FieldIssues path={p} />
      </div>
    );
  }
  if ("if" in step) {
    return (
      <div className="stack-sm">
        <div className="field">
          <span className="field-label">If</span>
          <CondExprEditor value={step.if} path={[...path, "if"]} onChange={(c: CondExpr) => onChange({ ...step, if: c })} />
        </div>
        <div className="branch then">
          <div className="branch-label">Then</div>
          <StepList steps={step.then ?? []} path={[...path, "then"]} label={`then of ${step.id}`} onChange={(s) => onChange({ ...step, then: s })} />
        </div>
        {step.else ? (
          <div className="branch else">
            <div className="row between">
              <div className="branch-label">Else</div>
              <button
                type="button"
                className="link"
                onClick={() => {
                  const { else: _e, ...rest } = step;
                  onChange(rest as Step);
                }}
              >
                Remove else
              </button>
            </div>
            <StepList steps={step.else} path={[...path, "else"]} label={`else of ${step.id}`} onChange={(s) => onChange({ ...step, else: s })} />
          </div>
        ) : (
          <button type="button" className="small-btn" onClick={() => onChange({ ...step, else: [] })}>
            + Else branch
          </button>
        )}
      </div>
    );
  }
  if ("phone" in step) return <PhoneStep step={step} onChange={onChange} path={path} />;
  if ("stop" in step) {
    return (
      <Field label="Reason (optional)" path={[...path, "stop", "reason"]}>
        <input
          aria-label="Stop reason"
          value={step.stop?.reason ?? ""}
          onChange={(e) => onChange({ ...step, stop: e.target.value ? { reason: e.target.value } : {} })}
        />
      </Field>
    );
  }
  return null;
}

const PHONE_DEFAULTS: Record<PhoneAction["action"], PhoneAction> = {
  dnd: { action: "dnd", on: true },
  volume: { action: "volume", stream: "media", percent: 30 },
  media: { action: "media", command: "pause" },
};

function PhoneStep({ step, onChange, path }: { step: Extract<Step, { phone: unknown }>; onChange: (s: Step) => void; path: Path }) {
  const p = [...path, "phone"];
  const a = step.phone;
  const set = (phone: PhoneAction) => onChange({ ...step, phone });
  return (
    <>
      <Field label="Action" path={[...p, "action"]}>
        <select aria-label="Phone action" value={a.action} onChange={(e) => set(PHONE_DEFAULTS[e.target.value as PhoneAction["action"]])}>
          <option value="dnd">Do Not Disturb</option>
          <option value="volume">Set volume</option>
          <option value="media">Media control</option>
        </select>
      </Field>
      {a.action === "dnd" && (
        <Field label="Do Not Disturb on" path={[...p, "on"]}>
          <input type="checkbox" aria-label="Do Not Disturb on" checked={a.on} onChange={(e) => set({ action: "dnd", on: e.target.checked })} />
        </Field>
      )}
      {a.action === "volume" && (
        <>
          <Field label="Stream" path={[...p, "stream"]}>
            <select aria-label="Volume stream" value={a.stream} onChange={(e) => set({ ...a, stream: e.target.value as typeof a.stream })}>
              <option value="media">Media</option>
              <option value="ring">Ring</option>
              <option value="alarm">Alarm</option>
            </select>
          </Field>
          <Field label="Percent (0-100)" path={[...p, "percent"]}>
            <input
              type="number"
              min={0}
              max={100}
              aria-label="Volume percent"
              value={a.percent}
              onChange={(e) => set({ ...a, percent: e.target.value === "" ? 0 : Number(e.target.value) })}
            />
          </Field>
        </>
      )}
      {a.action === "media" && (
        <Field label="Command" path={[...p, "command"]}>
          <select aria-label="Media command" value={a.command} onChange={(e) => set({ ...a, command: e.target.value as typeof a.command })}>
            <option value="play">Play</option>
            <option value="pause">Pause</option>
            <option value="next">Next</option>
          </select>
        </Field>
      )}
    </>
  );
}

function ClaudeStep({ step, onChange, path }: { step: Extract<Step, { claude: unknown }>; onChange: (s: Step) => void; path: Path }) {
  const { tools, toolsError } = useEditorData();
  const p = [...path, "claude"];
  const c = step.claude ?? { prompt: "" };
  const all = c.tools === undefined;
  const options = [...BUILTIN_CLAUDE_TOOLS.map((b) => ({ name: b.name, description: b.description, read_only: false })), ...tools];
  const known = new Set(options.map((o) => o.name));
  const extra = (c.tools ?? []).filter((t) => !known.has(t));
  const setTools = (list: string[] | undefined) => {
    const { tools: _t, ...rest } = c;
    onChange({ ...step, claude: list === undefined ? rest : { ...rest, tools: list } });
  };
  /** Sets an optional field, dropping it when cleared so the file stays minimal. */
  const setOpt = <K extends "model" | "effort" | "history">(key: K, value: (typeof c)[K] | undefined) => {
    const next = { ...c } as Record<string, unknown>;
    if (value === undefined || value === "" || value === false) delete next[key];
    else next[key] = value;
    onChange({ ...step, claude: next as typeof c });
  };
  return (
    <div className="stack-sm">
      <Field label="Prompt" path={[...p, "prompt"]} hint={TEMPLATE_HINT}>
        <textarea aria-label="Claude prompt" rows={4} value={c.prompt ?? ""} onChange={(e) => onChange({ ...step, claude: { ...c, prompt: e.target.value } })} />
      </Field>
      <div className="grid2">
        <Field label="Model" path={[...p, "model"]} hint="Blank uses the global model from Settings.">
          <input aria-label="Claude model" className="mono" list="jeeves-claude-models" placeholder="global model" value={c.model ?? ""} onChange={(e) => setOpt("model", e.target.value.trim() || undefined)} />
          <datalist id="jeeves-claude-models">
            {CLAUDE_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Effort" path={[...p, "effort"]} hint="Higher thinks harder and costs more.">
          <select aria-label="Claude effort" value={c.effort ?? ""} onChange={(e) => setOpt("effort", (e.target.value || undefined) as Effort | undefined)}>
            <option value="">Global setting</option>
            {(["low", "medium", "high", "xhigh", "max"] as const).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={c.history ?? false} onChange={(e) => setOpt("history", e.target.checked)} />
        Include the recent chat (last 8 messages)
      </label>
      <div className="field">
        <span className="field-label">Tools Claude may use</span>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setTools(e.target.checked ? undefined : options.map((o) => o.name))} />
          All tools (no allowlist)
        </label>
        {!all && (
          <div className="tool-grid">
            {[...options, ...extra.map((name) => ({ name, description: "not currently offered by any plugin", read_only: false }))].map((o) => (
              <label key={o.name} className="check" title={o.description}>
                <input
                  type="checkbox"
                  checked={c.tools?.includes(o.name) ?? false}
                  onChange={(e) => setTools(e.target.checked ? [...(c.tools ?? []), o.name] : (c.tools ?? []).filter((x) => x !== o.name))}
                />
                <code>{o.name}</code>
                {o.read_only && <span className="badge muted">read-only</span>}
              </label>
            ))}
          </div>
        )}
        {toolsError && <span className="hint">Couldn't load plugin tools: {toolsError}</span>}
        <FieldIssues path={[...p, "tools"]} />
      </div>
      <FieldIssues path={p} />
    </div>
  );
}

function CallStep({ step, onChange, path }: { step: Extract<Step, { call: unknown }>; onChange: (s: Step) => void; path: Path }) {
  const { tools, toolsError } = useEditorData();
  const [asJson, setAsJson] = useState(false);
  const p = [...path, "call"];
  const c = step.call ?? { plugin: "", tool: "" };
  const key = `${c.plugin}/${c.tool}`;
  const tool = tools.find((t) => t.plugin === c.plugin && t.tool === c.tool);
  const setArgs = (args: Record<string, unknown> | undefined) => {
    const { args: _a, ...rest } = c;
    onChange({ ...step, call: args && Object.keys(args).length ? { ...rest, args } : rest });
  };
  const byPlugin = new Map<string, typeof tools>();
  for (const t of tools) byPlugin.set(t.plugin, [...(byPlugin.get(t.plugin) ?? []), t]);
  return (
    <div className="stack-sm">
      <Field label="Tool" path={[...p, "tool"]} hint={tool?.description}>
        <select
          aria-label="Tool"
          value={key}
          onChange={(e) => {
            const [plugin, ...rest] = e.target.value.split("/");
            onChange({ ...step, call: { plugin, tool: rest.join("/") } });
          }}
        >
          {!tool && <option value={key}>{c.plugin || c.tool ? `${c.plugin}/${c.tool} (not available now)` : "Pick a tool…"}</option>}
          {[...byPlugin].map(([plugin, list]) => (
            <optgroup key={plugin} label={list[0]?.plugin_title ?? plugin}>
              {list.map((t) => (
                <option key={t.name} value={`${t.plugin}/${t.tool}`}>
                  {t.title ?? t.tool}
                  {t.read_only ? " (read-only)" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {toolsError && <span className="hint">Couldn't load tools: {toolsError}</span>}
      </Field>
      <FieldIssues path={[...p, "plugin"]} />
      <div className="field">
        <div className="row between">
          <span className="field-label">Arguments</span>
          <label className="check small">
            <input type="checkbox" checked={asJson || !isObjectSchema(tool?.input_schema)} disabled={!isObjectSchema(tool?.input_schema)} onChange={(e) => setAsJson(e.target.checked)} />
            Edit as JSON
          </label>
        </div>
        {asJson || !isObjectSchema(tool?.input_schema) ? (
          <JsonTextarea label="Arguments JSON" value={c.args ?? {}} onChange={(v) => setArgs(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)} />
        ) : (
          <SchemaForm schema={tool!.input_schema} value={c.args ?? {}} onChange={setArgs} issuePath={[...p, "args"]} templates />
        )}
        <span className="hint">{TEMPLATE_HINT}</span>
        {(asJson || !isObjectSchema(tool?.input_schema)) && <FieldIssues path={[...p, "args"]} />}
      </div>
      <FieldIssues path={p} />
    </div>
  );
}
