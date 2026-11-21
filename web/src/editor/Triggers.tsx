import { Cron } from "croner";
import { useEffect, useId, useMemo, useState } from "react";
import type { Path, Trigger, When } from "../types";
import { compact, Field, FieldIssues } from "../ui";
import { ConditionList } from "./Conditions";
import { useEditorData } from "./context";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function TriggersEditor({ value, onChange }: { value: Trigger[]; onChange: (v: Trigger[]) => void }) {
  return (
    <div className="stack-sm">
      {value.map((t, i) => (
        <TriggerCard
          key={i}
          value={t}
          path={["triggers", i]}
          onChange={(nt) => onChange(value.map((x, j) => (j === i ? nt : x)))}
          onRemove={value.length > 1 ? () => onChange(value.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      <div className="row gap">
        <button type="button" className="small-btn" onClick={() => onChange([...value, { event: "wifi.connected" }])}>
          + Event trigger
        </button>
        <button type="button" className="small-btn" onClick={() => onChange([...value, { schedule: "0 9 * * *" }])}>
          + Schedule trigger
        </button>
      </div>
      <FieldIssues path={["triggers"]} />
    </div>
  );
}

const ssidText = (v: When["ssid"]) => (Array.isArray(v) ? v.join(", ") : (v ?? ""));

/** "home" stays a string, "home, work" becomes a list, blank clears it. */
function parseSsids(text: string): When["ssid"] {
  const names = text.split(",").map((s) => s.trim()).filter(Boolean);
  return names.length === 0 ? undefined : names.length === 1 ? names[0] : names;
}

/** Comma-separated SSIDs. Keeps its own text so a trailing comma survives while typing. */
function SsidInput({ value, onChange }: { value: When["ssid"]; onChange: (v: When["ssid"]) => void }) {
  const [text, setText] = useState(() => ssidText(value));
  useEffect(() => {
    // Only take outside changes (undo, reload); our own edits already parse to `value`.
    if (ssidText(parseSsids(text)) !== ssidText(value)) setText(ssidText(value));
  }, [value]);
  return (
    <input
      aria-label="SSID"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseSsids(e.target.value));
      }}
    />
  );
}

function TriggerCard({ value, onChange, onRemove, path }: { value: Trigger; onChange: (t: Trigger) => void; onRemove?: () => void; path: Path }) {
  const { eventTypes, events } = useEditorData();
  const listId = useId();
  const isSchedule = "schedule" in value;
  const info = "event" in value ? events.find((e) => e.type === value.event) : undefined;
  const when = value.when ?? {};
  const setWhen = (w: When) => {
    const c = compact(w as Record<string, unknown>) as When;
    if (c.days && !c.days.length) delete c.days;
    const { when: _old, ...rest } = value;
    onChange((Object.keys(c).length ? { ...rest, when: c } : rest) as Trigger);
  };
  const wp = [...path, "when"];
  return (
    <div className="subcard">
      <div className="row between">
        <select
          aria-label="Trigger kind"
          value={isSchedule ? "schedule" : "event"}
          onChange={(e) => {
            const w = value.when ? { when: value.when } : {};
            onChange(e.target.value === "schedule" ? { schedule: "0 9 * * *", ...w } : { event: "wifi.connected", ...w });
          }}
        >
          <option value="event">When an event happens</option>
          <option value="schedule">On a schedule</option>
        </select>
        {onRemove && (
          <button type="button" className="icon" aria-label="Remove trigger" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
      <FieldIssues path={path} />
      {isSchedule ? (
        <Field label="Cron expression" path={[...path, "schedule"]} hint="minute hour day-of-month month day-of-week, e.g. 0 9 * * sat,sun">
          <input aria-label="Cron expression" className="mono" value={value.schedule} onChange={(e) => onChange({ ...value, schedule: e.target.value })} />
          <CronPreview expr={value.schedule} />
        </Field>
      ) : (
        <Field
          label="Event type"
          path={[...path, "event"]}
          hint={
            info ? (
              <>
                <strong>{info.title ?? info.type}</strong>
                {info.description ? ` — ${info.description}` : ""}
              </>
            ) : (
              "Pick a known type or type your own (plugin events look like todo.task_started)."
            )
          }
        >
          <input aria-label="Event type" className="mono" list={listId} value={value.event} onChange={(e) => onChange({ ...value, event: e.target.value.trim() })} />
          <datalist id={listId}>
            {eventTypes.map((t) => {
              const title = events.find((e) => e.type === t)?.title;
              return <option key={t} value={t} label={title ?? undefined} />;
            })}
          </datalist>
        </Field>
      )}
      <details className="when" open={Object.keys(when).length > 0}>
        <summary>Only when… {Object.keys(when).length > 0 && <span className="muted small">({Object.keys(when).join(", ")})</span>}</summary>
        <div className="grid2">
          <Field label="Wi-Fi network (SSID)" path={[...wp, "ssid"]} hint="Separate several networks with commas; any of them matches">
            <SsidInput value={when.ssid} onChange={(ssid) => setWhen({ ...when, ssid })} />
          </Field>
          <Field label="Away at least (minutes)" path={[...wp, "min_away_minutes"]} hint="Only after being away from this Wi-Fi this long">
            <input
              aria-label="Minimum minutes away"
              type="number"
              min={0}
              value={when.min_away_minutes ?? ""}
              onChange={(e) => setWhen({ ...when, min_away_minutes: e.target.value === "" ? undefined : Math.max(0, Math.round(Number(e.target.value))) })}
            />
          </Field>
          <Field label="After (HH:MM)" path={[...wp, "after"]}>
            <input aria-label="After" type="time" value={when.after ?? ""} onChange={(e) => setWhen({ ...when, after: e.target.value })} />
          </Field>
          <Field label="Before (HH:MM)" path={[...wp, "before"]}>
            <input aria-label="Before" type="time" value={when.before ?? ""} onChange={(e) => setWhen({ ...when, before: e.target.value })} />
          </Field>
        </div>
        <div className="field">
          <span className="field-label">Days (none ticked = every day)</span>
          <div className="row gap wrap">
            {DAYS.map((d) => (
              <label key={d} className="check">
                <input
                  type="checkbox"
                  checked={when.days?.includes(d) ?? false}
                  onChange={(e) => setWhen({ ...when, days: e.target.checked ? DAYS.filter((x) => x === d || when.days?.includes(x)) : (when.days ?? []).filter((x) => x !== d) })}
                />
                {d}
              </label>
            ))}
          </div>
          <FieldIssues path={[...wp, "days"]} />
        </div>
        <div className="field">
          <span className="field-label">Payload conditions</span>
          <ConditionList value={when.conditions ?? []} path={[...wp, "conditions"]} onChange={(c) => setWhen({ ...when, conditions: c })} />
        </div>
        <FieldIssues path={wp} />
      </details>
    </div>
  );
}

function CronPreview({ expr }: { expr: string }) {
  const { timezone } = useEditorData();
  const result = useMemo(() => {
    try {
      const c = new Cron(expr, { timezone, paused: true });
      const runs = c.nextRuns(5);
      c.stop();
      let fmt: Intl.DateTimeFormat;
      try {
        fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone });
      } catch {
        fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      }
      return { runs: runs.map((d) => fmt.format(d)) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [expr, timezone]);
  if ("error" in result) return <span className="field-issues">Not a valid cron expression: {result.error}</span>;
  return (
    <span className="hint">
      Next runs ({timezone}): {result.runs.length ? result.runs.join(" · ") : "none"}
    </span>
  );
}
