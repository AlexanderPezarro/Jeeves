import { describe, expect, it, vi } from "vitest";
import { Db } from "./db.js";
import { FcmNotifier, makeNotifier, PollOnlyNotifier, WebPushNotifier } from "./notify.js";

const vapid = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" };

function setup(count = 2) {
  const db = new Db(":memory:");
  for (let i = 0; i < count; i++) {
    const { device } = db.createDevice(`phone${i}`);
    db.setWebPush(device.id, { endpoint: `https://ntfy.example/up${i}`, p256dh: `k${i}`, auth: `a${i}` });
  }
  return db;
}

describe("WebPushNotifier", () => {
  it("sends one push call per subscription with the payload", async () => {
    const db = setup();
    const send = vi.fn().mockResolvedValue({});
    const items = [{ task_id: 1, title: "Dishes", minutes: 10, steps: ["wash"] }];
    const msg = db.addMessage("out", "Hello", items);
    await new WebPushNotifier(db, vapid, send).notify(msg);
    expect(send).toHaveBeenCalledTimes(2);
    const [sub, body, opts] = send.mock.calls[0];
    expect(sub).toEqual({ endpoint: "https://ntfy.example/up0", keys: { p256dh: "k0", auth: "a0" } });
    expect(JSON.parse(body)).toEqual({ message_id: msg.id, text: "Hello", items });
    expect(opts).toEqual({ TTL: 43200, urgency: "high", vapidDetails: { subject: "mailto:a@b.c", publicKey: "pub", privateKey: "priv" } });
  });

  it("drops an endpoint on 410 and still sends to the others", async () => {
    const db = setup();
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 })).mockResolvedValue({});
    await new WebPushNotifier(db, vapid, send).notify(db.addMessage("out", "x"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(db.webPushSubscriptions().map((s) => s.endpoint)).toEqual(["https://ntfy.example/up1"]);
  });

  it("logs a 500 and does not throw or drop the subscription", async () => {
    const db = setup(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 500 }));
    await expect(new WebPushNotifier(db, vapid, send).notify(db.addMessage("out", "x"))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(db.webPushSubscriptions()).toHaveLength(1);
    warn.mockRestore();
  });

  it("includes the conversation id in the web push payload", async () => {
    const db = setup(1);
    const send = vi.fn().mockResolvedValue({});
    const conv = db.createConversation();
    await new WebPushNotifier(db, vapid, send).notify(db.addMessage("out", "x", null, null, new Date(), { conversation_id: conv.id }));
    expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({ conversation_id: conv.id });
  });

  it("sends a truncated payload when the items are too big", async () => {
    const db = setup(1);
    const send = vi.fn().mockResolvedValue({});
    const items = Array.from({ length: 40 }, (_, i) => ({ task_id: i, title: `Task ${i} ${"x".repeat(60)}`, minutes: 5, steps: ["a step", "another step"] }));
    const msg = db.addMessage("out", "Big", items);
    await new WebPushNotifier(db, vapid, send).notify(msg);
    expect(JSON.parse(send.mock.calls[0][1])).toEqual({ message_id: msg.id, truncated: true });
  });

  it("rewrites the endpoint prefix when configured, but stores the original", async () => {
    const db = setup(1);
    const send = vi.fn().mockResolvedValue({});
    const n = new WebPushNotifier(db, vapid, send, "https://ntfy.example=http://ntfy:80");
    await n.notify(db.addMessage("out", "x"));
    expect(send.mock.calls[0][0].endpoint).toBe("http://ntfy:80/up0");
    expect(db.webPushSubscriptions()[0].endpoint).toBe("https://ntfy.example/up0");
  });

  it("does nothing without subscriptions", async () => {
    const db = new Db(":memory:");
    const send = vi.fn();
    await new WebPushNotifier(db, vapid, send).notify(db.addMessage("out", "x"));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("makeNotifier", () => {
  const db = new Db(":memory:");

  it("prefers web push when VAPID is set, even with Firebase", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const n = makeNotifier(db, { VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", FIREBASE_SERVICE_ACCOUNT: "/x.json" });
    expect(n).toBeInstanceOf(WebPushNotifier);
    log.mockRestore();
  });

  it("falls back to FCM, then to polling", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(makeNotifier(db, { FIREBASE_SERVICE_ACCOUNT: "/x.json" })).toBeInstanceOf(FcmNotifier);
    expect(makeNotifier(db, {})).toBeInstanceOf(PollOnlyNotifier);
    expect(makeNotifier(db, { VAPID_PUBLIC_KEY: "a" })).toBeInstanceOf(PollOnlyNotifier);
    log.mockRestore();
  });
});
