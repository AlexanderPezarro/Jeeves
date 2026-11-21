import { useId } from "react";
import type { Listener, Path } from "../types";
import { Field } from "../ui";
import { ConditionList } from "./Conditions";
import { useEditorData } from "./context";

/** One event a paused run waits for: an event type plus conditions on its payload. */
export function ListenerEditor({ value, onChange, path, onRemove }: { value: Listener; onChange: (l: Listener) => void; path: Path; onRemove?: () => void }) {
  const { eventTypes, events } = useEditorData();
  const listId = useId();
  const info = events.find((e) => e.type === value.event);
  return (
    <div className="subcard">
      <div className="row between">
        <Field label="Event type" path={[...path, "event"]} hint={info ? `${info.title ?? info.type}${info.description ? ` — ${info.description}` : ""}` : "Pick a known type or type your own."}>
          <input aria-label="Event type" className="mono" list={listId} value={value.event} onChange={(e) => onChange({ ...value, event: e.target.value.trim() })} />
          <datalist id={listId}>
            {eventTypes.map((t) => (
              <option key={t} value={t} label={events.find((e) => e.type === t)?.title ?? undefined} />
            ))}
          </datalist>
        </Field>
        {onRemove && (
          <button type="button" className="icon" aria-label="Remove event" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
      <Field label="Only when" hint={<>Checks on the event, e.g. event.task_id equals {"{{steps.task.id}}"}.</>}>
        <ConditionList
          value={value.conditions ?? []}
          path={[...path, "conditions"]}
          onChange={(c) => {
            const { conditions: _c, ...rest } = value;
            onChange(c ? { ...rest, conditions: c } : rest);
          }}
        />
      </Field>
    </div>
  );
}
