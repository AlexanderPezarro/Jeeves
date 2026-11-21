import { afterEach, describe, expect, it, vi } from "vitest";
import { stepSchema, type PhoneAction } from "./config.js";
import { Db } from "./db.js";
import { WebPushNotifier } from "./notify.js";
import { pair, setup } from "./testkit.js";

afterEach(() => vi.useRealTimers());

describe("phone step schema", () => {
  const ok = (phone: unknown) => stepSchema.safeParse({ id: "p", phone }).success;

  it("accepts each variant", () => {
    expect(ok({ action: "dnd", on: true })).toBe(true);
    expect(ok({ action: "volume", stream: "ring", percent: 0 })).toBe(true);
    expect(ok({ action: "volume", stream: "media", percent: 100 })).toBe(true);
    expect(ok({ action: "media", command: "next" })).toBe(true);
  });

  it("rejects bad input", () => {
    expect(ok({ action: "reboot" })).toBe(false);
    expect(ok({ action: "volume", stream: "media", percent: 101 })).toBe(false);
    expect(ok({ action: "volume", stream: "media", percent: -1 })).toBe(false);
    expect(ok({ action: "volume", stream: "media", percent: 2.5 })).toBe(false);
    expect(ok({ action: "volume", stream: "system", percent: 5 })).toBe(false);
    expect(ok({ action: "dnd" })).toBe(false);
    expect(ok({ action: "dnd", on: true, extra: 1 })).toBe(false);
    expect(ok({ action: "media", command: "stop" })).toBe(false);
  });
});

const flow = (phone: PhoneAction, extra: Record<string, unknown> = {}) => ({
  id: "flow",
  cooldown: 0,
  triggers: [{ event: "test.go" }],
  steps: [{ id: "p", phone }],
  ...extra,
});

function start(s: ReturnType<typeof setup>) {
  s.engine.handleEvent("test.go", {}, null);
}
const tick = () => new Promise((r) => setImmediate(r));

describe("phone step in the runner", () => {
  it("succeeds when the phone replies ok", async () => {
    const s = setup({ workflows: [flow({ action: "dnd", on: true })] });
    const headers = await pair(s.app);
    start(s);
    await tick();
    expect(s.notifier.commands).toHaveLength(1);
    const cmd = s.notifier.commands[0];
    expect(cmd.payload).toEqual({ action: "dnd", on: true });
    const res = await s.app.inject({ method: "POST", url: `/phone-commands/${cmd.id}/result`, headers, payload: { ok: true } });
    expect(res.json()).toEqual({ accepted: true });
    await s.engine.idle();
    const [run] = s.db.workflowRuns();
    expect(run.status).toBe("ok");
    const [step] = s.db.stepRuns(run.id);
    expect(step.output).toEqual({ ok: true });
    expect(s.db.getPhoneCommand(cmd.id)?.status).toBe("ok");
  });

  it("fails with the phone's error and notifies on failure", async () => {
    const s = setup({ workflows: [flow({ action: "dnd", on: true }, { notify_on_failure: true })] });
    const headers = await pair(s.app);
    start(s);
    await tick();
    await s.app.inject({ method: "POST", url: `/phone-commands/${s.notifier.commands[0].id}/result`, headers, payload: { ok: false, error: "no DND access" } });
    await s.engine.idle();
    const [run] = s.db.workflowRuns();
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no DND access");
    expect(s.notifier.sent.map((m) => m.text).join()).toContain("no DND access");
  });

  it("times out, marks the command expired and ignores a late reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup({ workflows: [flow({ action: "media", command: "pause" })] });
    const headers = await pair(s.app);
    start(s);
    await vi.advanceTimersByTimeAsync(100);
    const id = s.notifier.commands[0].id;
    await vi.advanceTimersByTimeAsync(60_000);
    await s.engine.idle();
    const [run] = s.db.workflowRuns();
    expect(run.status).toBe("failed");
    expect(run.error).toContain("didn't answer within 60s");
    expect(s.db.getPhoneCommand(id)?.status).toBe("expired");
    const late = await s.app.inject({ method: "POST", url: `/phone-commands/${id}/result`, headers, payload: { ok: true } });
    expect(late.json()).toEqual({ accepted: false });
    expect(s.db.workflowRuns()[0].status).toBe("failed");
  });

  it("ignores a second reply", async () => {
    const s = setup({ workflows: [flow({ action: "media", command: "play" })] });
    const headers = await pair(s.app);
    start(s);
    await tick();
    const url = `/phone-commands/${s.notifier.commands[0].id}/result`;
    expect((await s.app.inject({ method: "POST", url, headers, payload: { ok: true } })).json()).toEqual({ accepted: true });
    expect((await s.app.inject({ method: "POST", url, headers, payload: { ok: false, error: "x" } })).json()).toEqual({ accepted: false });
    await s.engine.idle();
    expect(s.db.workflowRuns()[0].status).toBe("ok");
  });

  it("fails at once when no device can receive the push", async () => {
    const s = setup({ workflows: [flow({ action: "media", command: "play" })] });
    s.notifier.devices = 0;
    start(s);
    await s.engine.idle();
    const [run] = s.db.workflowRuns();
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no paired device has push set up");
    expect(s.db.getPhoneCommand(s.notifier.commands[0].id)?.status).toBe("failed");
  });

  it("is skipped in a dry run and sends nothing", async () => {
    const s = setup({ workflows: [flow({ action: "volume", stream: "media", percent: 30 })] });
    const { done } = s.engine.runNow("flow", { dryRun: true });
    await done;
    const [run] = s.db.workflowRuns();
    const [step] = s.db.stepRuns(run.id);
    expect(step.status).toBe("skipped");
    expect(step.output).toMatchObject({ would_send: { phone: { action: "volume", stream: "media", percent: 30 } } });
    expect(s.notifier.commands).toHaveLength(0);
  });
});

describe("POST /phone-commands/:id/result", () => {
  it("validates auth, body and id", async () => {
    const s = setup({ workflows: [flow({ action: "media", command: "play" })] });
    const headers = await pair(s.app);
    expect((await s.app.inject({ method: "POST", url: "/phone-commands/1/result", payload: { ok: true } })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "POST", url: "/phone-commands/1/result", headers, payload: { ok: "yes" } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: "POST", url: "/phone-commands/abc/result", headers, payload: { ok: true } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: "POST", url: "/phone-commands/999/result", headers, payload: { ok: true } })).statusCode).toBe(404);
  });

  it("does not accept a reply once the command has expired", async () => {
    const s = setup({ workflows: [flow({ action: "media", command: "play" })] });
    const headers = await pair(s.app);
    start(s);
    await tick();
    const id = s.notifier.commands[0].id;
    s.clock.now = new Date(s.clock.now.getTime() + 61_000);
    const res = await s.app.inject({ method: "POST", url: `/phone-commands/${id}/result`, headers, payload: { ok: true } });
    expect(res.json()).toEqual({ accepted: false });
    expect(s.db.getPhoneCommand(id)?.status).toBe("pending");
  });
});

describe("WebPushNotifier.command", () => {
  const vapid = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" };
  function withSubs(count: number) {
    const db = new Db(":memory:");
    for (let i = 0; i < count; i++) {
      const { device } = db.createDevice(`p${i}`);
      db.setWebPush(device.id, { endpoint: `https://ntfy.example/up${i}`, p256dh: `k${i}`, auth: `a${i}` });
    }
    return db;
  }
  const row = (db: Db) => db.addPhoneCommand({ workflow_run_id: 1, step_run_id: 1, payload: { action: "dnd", on: true } }, new Date("2026-11-14T12:00:00Z"), 60_000);

  it("sends the command with a 60s TTL and counts successes", async () => {
    const db = withSubs(1);
    const send = vi.fn().mockResolvedValue({});
    const r = row(db);
    expect(await new WebPushNotifier(db, vapid, send).command(r)).toBe(1);
    const [, body, opts] = send.mock.calls[0];
    expect(JSON.parse(body)).toEqual({ command_id: r.id, expires_at: "2026-11-14T12:01:00.000Z", phone: { action: "dnd", on: true } });
    expect(opts.TTL).toBe(60);
  });

  it("removes a gone endpoint and does not count it", async () => {
    const db = withSubs(2);
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 })).mockResolvedValue({});
    expect(await new WebPushNotifier(db, vapid, send).command(row(db))).toBe(1);
    expect(db.webPushSubscriptions()).toHaveLength(1);
  });

  it("returns 0 without subscriptions", async () => {
    const db = withSubs(0);
    expect(await new WebPushNotifier(db, vapid, vi.fn()).command(row(db))).toBe(0);
  });
});
