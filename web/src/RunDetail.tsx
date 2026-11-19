import { useState } from "react";
import { api } from "./api";
import { Link } from "./router";
import type { ClaudeRun, MessageRow, StepRun, WorkflowRun } from "./types";
import { Badge, ErrorBox, fmtDateTime, fmtNumber, Json } from "./ui";

/** Steps, inputs/outputs, warnings, Claude transcript, tokens and messages of one workflow run. */
export function RunDetail({ run }: { run: WorkflowRun }) {
  return (
    <div className="run-detail">
      <div className="row gap wrap small muted">
        <span>
          Run #{run.id} of <Link to={`/workflows/${encodeURIComponent(run.workflow_id)}`}>{run.workflow_id}</Link>
        </span>
        <span>trigger: {run.trigger}</span>
        {run.dry_run && <Badge status="info">dry run</Badge>}
        <span>started {fmtDateTime(run.started_at)}</span>
        {run.finished_at && <span>finished {fmtDateTime(run.finished_at)}</span>}
      </div>
      {run.error && <div className="notice error">{run.error}</div>}
      {run.steps.length === 0 ? (
        <p className="muted small">No steps ran.</p>
      ) : (
        <ol className="steps-run">
          {run.steps.map((s) => (
            <StepRunView key={s.id} step={s} />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepRunView({ step }: { step: StepRun }) {
  const dry = !!(step.output as { dry_run?: unknown } | null)?.dry_run;
  return (
    <li className="step-run">
      <div className="row gap wrap">
        <Badge status={step.status} />
        <strong>{step.step_id}</strong>
        <span className="muted small">
          {step.type} · path {step.path}
        </span>
        {step.claude_run && (
          <span className="muted small">
            Claude {step.claude_run.model} · {fmtNumber(step.claude_run.input_tokens)} in / {fmtNumber(step.claude_run.output_tokens)} out tokens
          </span>
        )}
      </div>
      {step.error && <div className="notice error small">{step.error}</div>}
      {step.warnings?.length > 0 && (
        <ul className="warnings">
          {step.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      <Json label="Input" value={step.input} />
      <Json label={dry ? "Output (dry run: recorded, not sent)" : "Output"} value={step.output} />
      {step.messages?.length > 0 && <Messages messages={step.messages} />}
      {step.run_id && <Transcript runId={step.run_id} />}
    </li>
  );
}

export function Messages({ messages }: { messages: MessageRow[] }) {
  return (
    <div className="messages">
      {messages.map((m) => (
        <div key={m.id} className={`message ${m.direction}`}>
          <div className="small muted">
            {m.direction === "out" ? "Sent" : "Received"} {fmtDateTime(m.created_at)}
          </div>
          <div className="pre-wrap">{m.text}</div>
          {m.items && m.items.length > 0 && (
            <ul>
              {m.items.map((it, i) => (
                <li key={i}>
                  {it.title}
                  {it.minutes ? ` (${it.minutes} min)` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function Transcript({ runId }: { runId: number }) {
  const [run, setRun] = useState<ClaudeRun | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const toggle = async () => {
    setOpen(!open);
    if (!run && !open) {
      try {
        setRun(await api.run(runId));
      } catch (e) {
        setErr(e);
      }
    }
  };
  return (
    <div className="transcript">
      <button type="button" className="link" onClick={toggle}>
        {open ? "Hide" : "Show"} Claude transcript (run #{runId})
      </button>
      {open && (
        <>
          <ErrorBox error={err} />
          {run && (
            <div>
              <div className="small muted">
                status {run.status}
                {run.error ? ` · ${run.error}` : ""}
              </div>
              <TranscriptView transcript={run.transcript} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; [k: string]: unknown };

/** Renders Anthropic-style [{role, content: string | Block[]}] transcripts, else raw JSON. */
function TranscriptView({ transcript }: { transcript: unknown }) {
  const list = Array.isArray(transcript) ? transcript : (transcript as { messages?: unknown[] } | null)?.messages;
  if (!Array.isArray(list)) return <pre className="mono small">{transcript == null ? "(no transcript stored)" : JSON.stringify(transcript, null, 2)}</pre>;
  return (
    <div className="transcript-list">
      {list.map((m, i) => {
        const msg = m as { role?: string; content?: unknown; type?: string };
        const role = msg.role ?? msg.type ?? "?";
        const blocks: Block[] = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? (msg.content as Block[]) : [msg as Block];
        return (
          <div key={i} className={`turn ${role}`}>
            <div className="small muted">{role}</div>
            {blocks.map((b, j) =>
              b.type === "text" ? (
                <div key={j} className="pre-wrap">
                  {b.text}
                </div>
              ) : b.type === "tool_use" ? (
                <div key={j} className="small">
                  → <code>{b.name}</code> <pre className="mono">{JSON.stringify(b.input, null, 2)}</pre>
                </div>
              ) : b.type === "tool_result" ? (
                <div key={j} className="small">
                  ← result <pre className="mono">{typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2)}</pre>
                </div>
              ) : (
                <pre key={j} className="mono small">
                  {JSON.stringify(b, null, 2)}
                </pre>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}
