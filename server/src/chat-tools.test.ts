import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CHAT_REMINDER_PLUGIN } from "./agent.js";
import { pair, reply, setup, toolUse, ARRIVE_HOME, CHAT_REPLY, MANUAL_PLAN } from "./testkit.js";
import { fromLocal } from "./time.js";
import { upcoming } from "./timeline.js";

/** The tool results Claude got back in the latest run, in order (each request carries the whole run so far). */
function toolResults(s: ReturnType<typeof setup>) {
  return s.claude.requests
    .at(-1)!
    .messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [])) as { content: string; is_error?: boolean }[];
}

async function chat(s: ReturnType<typeof setup>, text: string) {
  const headers = await pair(s.app);
  await s.app.inject({ method: "POST", url: "/messages", headers, payload: { text } });
  await s.engine.idle();
}

describe("fromLocal", () => {
  it("converts London wall-clock time, across BST and GMT", () => {
    expect(fromLocal("2026-11-27T09:00", "Europe/London").toISOString()).toBe("2026-11-27T09:00:00.000Z");
    expect(fromLocal("2027-06-01T09:00", "Europe/London").toISOString()).toBe("2027-06-01T08:00:00.000Z");
    // 01:30 is skipped when the clocks go forward: lands an hour later (02:30 BST).
    expect(fromLocal("2027-03-28T01:30", "Europe/London").toISOString()).toBe("2027-03-28T01:30:00.000Z");
    // 01:30 happens twice when they go back: the first one (BST).
    expect(fromLocal("2026-10-25T01:30", "Europe/London").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(() => fromLocal("next friday", "Europe/London")).toThrow();
  });
});

describe("one-off reminders from chat", () => {
  it("sets a reminder days ahead, shows it in Coming up and lists it, then fires it with its level", async () => {
    const s = setup({
      script: [
        reply("tool_use", [toolUse("t1", "set_reminder", { at: "2026-11-20T09:00", text: "Book a haircut", level: "loud" })]),
        reply("tool_use", [toolUse("t2", "list_reminders", {})]),
        reply("end_turn", [{ type: "text", text: "I'll remind you on Friday at 9." }]),
      ],
    });
    await chat(s, "remind me to book a haircut friday morning");
    const [set, list] = toolResults(s);
    expect(set.is_error).toBeFalsy();
    expect(set.content).toMatch(/^Reminder r-\S+ set for fri 2026-11-20 09:00\.$/);
    expect(list.content).toMatch(/fri 2026-11-20 09:00 \(loud\) Book a haircut/);

    const pending = s.db.pendingJobs("reminder");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ plugin: CHAT_REMINDER_PLUGIN, run_at: "2026-11-20T09:00:00.000Z" });
    expect(upcoming({ db: s.db, config: s.config }, 24 * 7, s.clock.now).items.some((u) => u.kind === "reminder" && u.text === "Book a haircut")).toBe(true);

    s.clock.now = new Date("2026-11-20T09:00:30Z");
    await s.engine.runDueJobs();
    const fired = s.notifier.sent.at(-1)!;
    expect(fired).toMatchObject({ text: "Book a haircut", level: "loud", due_at: "2026-11-20T09:00:00.000Z" });
  });

  it("refuses a past or malformed time, and cancels by id", async () => {
    const s = setup({
      script: [
        reply("tool_use", [toolUse("t1", "set_reminder", { at: "2026-11-14T11:00", text: "Too late", level: "notify" })]),
        reply("tool_use", [toolUse("t2", "set_reminder", { at: "Friday", text: "Vague", level: "notify" })]),
        reply("tool_use", [toolUse("t3", "set_reminder", { at: "2027-01-05T18:30", text: "Dentist", level: "notify" })]),
        reply("end_turn", [{ type: "text", text: "ok" }]),
      ],
    });
    await chat(s, "reminders");
    const [past, vague, ok] = toolResults(s);
    expect(past).toMatchObject({ is_error: true });
    expect(past.content).toMatch(/already passed/);
    expect(vague).toMatchObject({ is_error: true });
    const id = /Reminder (\S+) set/.exec(ok.content)![1];

    s.claude.script.push(
      reply("tool_use", [toolUse("t4", "cancel_reminder", { id })]),
      reply("tool_use", [toolUse("t5", "cancel_reminder", { id })]),
      reply("end_turn", [{ type: "text", text: "cancelled" }]),
    );
    await chat(s, "cancel the dentist one");
    const [cancelled, again] = toolResults(s).slice(-2);
    expect(cancelled.content).toBe(`Cancelled ${id}.`);
    expect(again).toMatchObject({ is_error: true });
    expect(s.db.pendingJobs("reminder")).toHaveLength(0);
  });
});

describe("workflow tools", () => {
  const WORK_YAML = `id: work-go-home
description: Nudge me to go home 8 hours after I get to work
triggers:
  - event: wifi.connected
    when: { ssid: Office WiFi }
steps:
  - id: wait
    wait: { minutes: 480 }
  - id: nudge
    message: { text: "Time to head home", level: loud }
`;

  it("are offered only to a step with workflows: true, with the workflow guide", async () => {
    const s = setup({ store: true, script: [reply("end_turn", [{ type: "text", text: "hi" }]), reply("end_turn", [{ type: "text", text: "plan" }])] });
    await chat(s, "hello");
    const chatReq = s.claude.requests[0];
    expect(chatReq.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["list_workflows", "get_workflow", "save_workflow", "set_reminder"]));
    expect(String(chatReq.system)).toContain("## Workflows");

    const headers = await pair(s.app);
    await s.app.inject({ method: "POST", url: "/events", headers, payload: { type: "manual.plan" } });
    await s.engine.idle();
    const planReq = s.claude.requests[1];
    expect(planReq.tools!.map((t) => t.name)).not.toContain("save_workflow");
    expect(planReq.tools!.map((t) => t.name)).toContain("set_reminder");
    expect(String(planReq.system)).not.toContain("## Workflows");
  });

  it("lists wifi events, refuses invalid YAML with reasons, saves a valid workflow that then loads", async () => {
    const s = setup({
      store: true,
      workflows: [ARRIVE_HOME, MANUAL_PLAN, CHAT_REPLY],
      script: [
        reply("tool_use", [toolUse("t1", "list_workflows", {})]),
        reply("tool_use", [toolUse("t2", "save_workflow", { id: "work-go-home", yaml: "id: work-go-home\ntriggers: []\nsteps: [{ id: x, wat: 1 }]\n", replace: false })]),
        reply("tool_use", [toolUse("t3", "save_workflow", { id: "work-go-home", yaml: WORK_YAML, replace: false })]),
        reply("tool_use", [toolUse("t4", "save_workflow", { id: "work-go-home", yaml: WORK_YAML, replace: false })]),
        reply("tool_use", [toolUse("t5", "save_workflow", { id: "chat-reply", yaml: "id: chat-reply\n", replace: true })]),
        reply("tool_use", [toolUse("t6", "get_workflow", { id: "work-go-home" })]),
        reply("end_turn", [{ type: "text", text: "Done" }]),
      ],
    });
    await chat(s, "new workflow: when I join the work wifi, remind me to go home 8 hours later");
    const [list, invalid, saved, exists, self, got] = toolResults(s);

    const listed = JSON.parse(list.content);
    expect(listed.event_types.map((e: { type: string }) => e.type)).toContain("wifi.connected");
    expect(listed.workflows.map((w: { id: string }) => w.id)).toContain("chat-reply");

    expect(invalid.is_error).toBe(true);
    expect(invalid.content).toMatch(/^Not saved:/);
    expect(saved).toMatchObject({ content: "Saved workflow work-go-home; it is live now." });
    expect(exists.is_error).toBe(true);
    expect(exists.content).toMatch(/already exists/);
    expect(self.is_error).toBe(true);
    expect(got.content).toBe(WORK_YAML);

    expect(existsSync(join(s.store!.dir, "workflows", "work-go-home.yaml"))).toBe(true);
    expect(readFileSync(join(s.store!.dir, "workflows", "chat-reply.yaml"), "utf8")).not.toBe("id: chat-reply\n");
    expect(s.config.current.workflows.find((w) => w.id === "work-go-home")?.triggers).toEqual([{ event: "wifi.connected", when: { ssid: "Office WiFi" } }]);
  });
});
