import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, ConfigWriteError, sha256 } from "./configstore.js";
import { migrateRules, seedChatWorkflow } from "./migrate.js";
import { pair, setup, tmpConfigDir } from "./testkit.js";
import { Agent } from "./agent.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { FakeTodo, RecordingNotifier, reply, scriptedClaude, toolUse } from "./testkit.js";
import { buildApp } from "./app.js";

const COMMENTED = `# Evening plan
id: evening
description: Evening plan # trailing comment
# whether it runs at all
enabled: true
cooldown: daily
triggers:
  - schedule: "0 18 * * *" # six o'clock
steps:
  # the only step
  - id: say
    message:
      text: Evening!
`;

const stores: ConfigStore[] = [];
function open(dir: string) {
  const s = new ConfigStore(dir);
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function dirWith(files: Record<string, string>) {
  const dir = tmpConfigDir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("ConfigStore", () => {
  it("loads config.example/ without errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeeves-example-"));
    cpSync(new URL("../../config.example", import.meta.url), dir, { recursive: true });
    const store = open(dir);
    expect(store.errors).toEqual([]);
    expect(store.current.workflows.map((w) => w.id)).toEqual([
      "arrive-home",
      "chat-reply",
      "dinner-tonight",
      "laundry",
      "manual-plan",
      "meals-waste-check",
      "missed-session",
      "plan-my-week",
      "shop-reminder",
      "training-today",
      "weekend-morning",
    ]);
    expect(store.current.plugins.map((p) => p.name)).toEqual(["todo", "calendar", "exercise", "meals"]);
    expect(store.current.plugin_settings.exercise).toMatchObject({ session_time: "18:00", hevy_poll_minutes: 15 });
  });

  it("toggles enabled without losing comments or key order", () => {
    const dir = dirWith({ "workflows/evening.yaml": COMMENTED });
    const store = open(dir);
    const { hash } = store.readWorkflow("evening")!;
    store.setWorkflowEnabled("evening", false, hash);
    const text = readFileSync(join(dir, "workflows/evening.yaml"), "utf8");
    expect(text).toBe(COMMENTED.replace("enabled: true", "enabled: false"));
    expect(store.current.workflows[0].enabled).toBe(false);
  });

  it("merges a form edit into the document, keeping comments on untouched nodes", () => {
    const dir = dirWith({ "workflows/evening.yaml": COMMENTED });
    const store = open(dir);
    const view = store.readWorkflow("evening")!;
    const raw = { ...(view.parsed as object), description: "Changed" } as Record<string, unknown>;
    raw.steps = [...(raw.steps as unknown[]), { id: "later", message: { text: "Later" } }];
    store.writeWorkflow("evening", { workflow: raw }, view.hash);
    const text = readFileSync(join(dir, "workflows/evening.yaml"), "utf8");
    expect(text).toContain("# Evening plan");
    expect(text).toContain("# whether it runs at all");
    expect(text).toContain("# six o'clock");
    expect(text).toContain("description: Changed");
    expect(text).toContain("id: later");
  });

  it("keeps the last good version of a file that becomes invalid and reports it", () => {
    const dir = dirWith({ "workflows/evening.yaml": COMMENTED });
    const store = open(dir);
    writeFileSync(join(dir, "workflows/evening.yaml"), "id: evening\ntriggers: []\nsteps: nope\n");
    writeFileSync(join(dir, "workflows/other.yaml"), "triggers: [{event: manual.plan}]\nsteps: [{id: a, stop: null}]\n");
    store.reloadNow();
    expect(store.current.workflows.map((w) => w.id)).toEqual(["evening", "other"]);
    expect(store.current.workflows[0].steps[0].id).toBe("say");
    expect(store.errors).toHaveLength(1);
    expect(store.errors[0].file).toBe("workflows/evening.yaml");
    expect(store.listWorkflows().find((w) => w.id === "evening")!.error).toMatch(/triggers/);
  });

  it("rejects an invalid write with issues and leaves the file untouched", () => {
    const dir = dirWith({ "workflows/evening.yaml": COMMENTED });
    const store = open(dir);
    const { hash } = store.readWorkflow("evening")!;
    let err: ConfigWriteError | undefined;
    try {
      store.writeWorkflow("evening", { yaml: "id: evening\ntriggers: []\nsteps: []\n" }, hash);
    } catch (e) {
      err = e as ConfigWriteError;
    }
    expect(err?.kind).toBe("validation");
    expect(err?.detail.issues?.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["triggers", "steps"]));
    expect(readFileSync(join(dir, "workflows/evening.yaml"), "utf8")).toBe(COMMENTED);
  });

  it("rejects a stale hash with the current content", () => {
    const dir = dirWith({ "workflows/evening.yaml": COMMENTED });
    const store = open(dir);
    expect(() => store.writeWorkflow("evening", { yaml: COMMENTED }, "not-the-hash")).toThrowError(ConfigWriteError);
    try {
      store.writeWorkflow("evening", { yaml: COMMENTED }, "not-the-hash");
    } catch (e) {
      expect((e as ConfigWriteError).kind).toBe("stale");
      expect((e as ConfigWriteError).detail.current).toEqual({ yaml: COMMENTED, hash: sha256(COMMENTED) });
    }
    // Creating over an existing file without a hash is stale too.
    expect(() => store.writeWorkflow("evening", { yaml: COMMENTED }, null)).toThrowError(/changed since/);
  });

  it("writes atomically and leaves no temp files", () => {
    const dir = tmpConfigDir();
    const store = open(dir);
    store.writeWorkflow("fresh", { workflow: { triggers: [{ event: "manual.plan" }], steps: [{ id: "a", stop: null }] } }, null);
    expect(readdirSync(join(dir, "workflows"))).toEqual(["fresh.yaml"]);
    expect(store.current.workflows.map((w) => w.id)).toEqual(["fresh"]);
  });

  it("requires the file name to match the id", () => {
    const dir = dirWith({ "workflows/a.yaml": "id: b\ntriggers: [{event: x}]\nsteps: [{id: s, stop: null}]\n" });
    const store = open(dir);
    expect(store.current.workflows).toEqual([]);
    expect(store.errors[0].error).toMatch(/must match the file name/);
  });

  it("patches globals keeping comments, and refuses unknown keys", () => {
    const dir = tmpConfigDir({}, [], "# My Jeeves\ntimezone: Europe/London # home\nmax_runs_per_day: 20\n");
    const store = open(dir);
    const { hash } = store.readGlobals();
    store.writeGlobals({ max_runs_per_day: 5, about_me: "I like quick wins" }, hash);
    const text = readFileSync(join(dir, "jeeves.yaml"), "utf8");
    expect(text).toContain("# My Jeeves");
    expect(text).toContain("timezone: Europe/London # home");
    expect(text).toContain("max_runs_per_day: 5");
    expect(store.current.max_runs_per_day).toBe(5);
    expect(() => store.writeGlobals({ plugins: [] }, store.readGlobals().hash)).toThrowError(/cannot set/);
    expect(() => store.writeGlobals({ max_runs_per_day: 0 }, store.readGlobals().hash)).toThrowError(ConfigWriteError);
  });

  it("hot-reloads on change and the engine reschedules its crons", async () => {
    const dir = dirWith({ "workflows/evening.yaml": COMMENTED });
    const store = open(dir);
    const db = new Db();
    const clock = { now: new Date() };
    const plugins = new FakeTodo(clock);
    const agent = new Agent({ db, config: store, plugins, notifier: new RecordingNotifier(), create: scriptedClaude([]).create });
    const engine = new Engine(db, store, plugins, agent);
    engine.start();
    expect(engine.scheduled().map((c) => c.workflow_id)).toEqual(["evening"]);

    const reloaded = new Promise((resolve) => store.once("reload", resolve));
    store.watch(50);
    writeFileSync(join(dir, "workflows/morning.yaml"), 'triggers: [{schedule: "0 7 * * *"}]\nsteps: [{id: a, message: {text: hi}}]\n');
    const diff = await reloaded;
    expect(diff).toMatchObject({ added: ["morning"] });
    expect(engine.scheduled().map((c) => c.workflow_id).sort()).toEqual(["evening", "morning"]);
    await engine.stop();
  });

  it("serves the workflow API with 400 and 409 responses", async () => {
    const s = setup({ store: true });
    const headers = await pair(s.app);
    const list = await s.app.inject({ method: "GET", url: "/workflows", headers });
    expect(list.json().workflows.map((w: { id: string }) => w.id)).toEqual(["arrive-home", "chat-reply", "manual-plan"]);

    const one = (await s.app.inject({ method: "GET", url: "/workflows/manual-plan", headers })).json();
    expect(one.parsed.id).toBe("manual-plan");
    // raw is the file as written, without the schema's defaults.
    expect(one.raw.id).toBe("manual-plan");
    expect(one.raw).not.toHaveProperty("enabled");
    expect(one.parsed.enabled).toBe(true);

    const bad = await s.app.inject({ method: "PUT", url: "/workflows/manual-plan", headers, payload: { yaml: "steps: 3", hash: one.hash } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.length).toBeGreaterThan(0);

    const toggled = await s.app.inject({ method: "PATCH", url: "/workflows/manual-plan/enabled", headers, payload: { enabled: false, hash: one.hash } });
    expect(toggled.statusCode).toBe(200);
    const stale = await s.app.inject({ method: "PUT", url: "/workflows/manual-plan", headers, payload: { yaml: one.yaml, hash: one.hash } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.yaml).toContain("enabled: false");

    const del = await s.app.inject({ method: "DELETE", url: `/workflows/manual-plan?hash=${toggled.json().hash}`, headers });
    expect(del.statusCode).toBe(200);
    expect(s.store!.current.workflows.map((w) => w.id)).toEqual(["arrive-home", "chat-reply"]);
    expect((await s.app.inject({ method: "GET", url: "/config/errors", headers })).json()).toEqual({ errors: [] });
    s.store!.close();
  });
});

const LEGACY = `# Copy to jeeves.yaml and edit.
timezone: Europe/London
model: claude-opus-5-5
plugins:
  - name: todo
    url: http://todo:8081/mcp
    token_env: TODO_PLUGIN_TOKEN
todo_plugin: todo

rules:
  # The worked example: back home after being out for a while, in the evening.
  - id: arrive-home
    description: Evening plan when I get home
    event: wifi.connected
    when:
      ssid: home
      after: "17:00"
      before: "22:30"
      min_away_minutes: 120
    cooldown: daily
    action:
      type: plan
      prompt: I'm home. Plan my evening.

  - id: manual-plan
    event: manual.plan
    cooldown: 5
    action:
      type: plan
      prompt: Plan now.

  - id: weekend-morning
    schedule: "0 9 * * sat,sun"
    action:
      type: message
      text: Good morning!
`;

describe("rules migration", () => {
  it("writes one workflow per rule, backs up and strips rules: from jeeves.yaml", () => {
    const dir = tmpConfigDir({}, [], LEGACY);
    const now = new Date("2026-11-19T10:00:00Z");
    const r = migrateRules(dir, now);
    expect(r).toEqual({ written: ["arrive-home", "manual-plan", "weekend-morning"], skipped: [], errors: [] });
    expect(existsSync(join(dir, "jeeves.yaml.bak-2026-11-19"))).toBe(true);
    const globals = readFileSync(join(dir, "jeeves.yaml"), "utf8");
    expect(globals).not.toContain("rules:");
    expect(globals).toContain("todo_plugin: todo");
    expect(globals).toContain("# rules moved to workflows/ on 2026-11-19");

    const store = open(dir);
    expect(store.errors).toEqual([]);
    const [arrive, manual, weekend] = store.current.workflows;
    expect(arrive).toMatchObject({
      id: "arrive-home",
      cooldown: "daily",
      triggers: [{ event: "wifi.connected", when: { ssid: "home", min_away_minutes: 120 } }],
      steps: [{ id: "plan", claude: { prompt: "I'm home. Plan my evening." } }],
    });
    expect(manual.cooldown).toBe(5);
    expect(weekend).toMatchObject({ triggers: [{ schedule: "0 9 * * sat,sun" }], steps: [{ id: "message", message: { text: "Good morning!" } }] });
    expect(readFileSync(join(dir, "workflows/arrive-home.yaml"), "utf8")).toContain("# The worked example");

    // Running it again is a no-op.
    expect(migrateRules(dir, now).written).toEqual([]);
  });

  it("does not overwrite an existing workflow file", () => {
    const dir = tmpConfigDir({}, [], LEGACY);
    writeFileSync(join(dir, "workflows/manual-plan.yaml"), "id: manual-plan\ntriggers: [{event: manual.plan}]\nsteps: [{id: a, stop: null}]\n");
    expect(migrateRules(dir).skipped).toEqual(["manual-plan"]);
    expect(readFileSync(join(dir, "workflows/manual-plan.yaml"), "utf8")).toContain("stop: null");
  });

  it("keeps the arrive-home scenario working end to end through the migrated workflow", async () => {
    const dir = tmpConfigDir({}, [], LEGACY);
    migrateRules(dir);
    const store = open(dir);
    const clock = { now: new Date("2026-11-14T09:00:00Z") };
    const now = () => clock.now;
    const db = new Db();
    // Cooldown history keyed by the old rule id still applies to the workflow of the same id.
    const plugins = new FakeTodo(clock);
    const notifier = new RecordingNotifier();
    const claude = scriptedClaude([
      reply("tool_use", [toolUse("t1", "send_message", { text: "Welcome home!", items: [] })]),
      reply("end_turn", []),
    ]);
    const agent = new Agent({ db, config: store, plugins, notifier, create: claude.create, now });
    const engine = new Engine(db, store, plugins, agent, now);
    const app = buildApp({ db, engine, pairingCode: "pair-me-please", store });
    const headers = await pair(app);
    await app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.disconnected", payload: { ssid: "home" } } });
    clock.now = new Date("2026-11-14T18:20:00Z");
    const res = await app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.connected", payload: { ssid: "home" } } });
    expect(res.json().rules).toEqual([{ id: "arrive-home", fired: true, reason: "conditions met" }]);
    await engine.idle();
    expect(notifier.sent.map((m) => m.text)).toEqual(["Welcome home!"]);

    const again = await app.inject({ method: "POST", url: "/events", headers, payload: { type: "wifi.connected", payload: { ssid: "home", away_minutes: 300 } } });
    expect(again.json().rules[0]).toMatchObject({ fired: false, reason: "already fired today" });
  });
});

describe("seedChatWorkflow", () => {
  it("writes chat-reply.yaml once, unless a workflow already listens for message.received", () => {
    const dir = tmpConfigDir();
    const db = new Db();
    expect(seedChatWorkflow(dir, [], db)).toBe(true);
    const yaml = readFileSync(join(dir, "workflows", "chat-reply.yaml"), "utf8");
    expect(yaml).toContain("event: message.received");
    // It must be a valid workflow as written.
    const store = new ConfigStore(dir);
    expect(store.errors).toEqual([]);
    expect(store.current.workflows.map((w) => w.id)).toContain("chat-reply");
    store.close();
    // Deleted by the user later: not brought back.
    rmSync(join(dir, "workflows", "chat-reply.yaml"));
    expect(seedChatWorkflow(dir, [], db)).toBe(false);
    expect(existsSync(join(dir, "workflows", "chat-reply.yaml"))).toBe(false);

    const other = tmpConfigDir();
    expect(seedChatWorkflow(other, [{ triggers: [{ event: "message.received" }] }], new Db())).toBe(false);
    expect(existsSync(join(other, "workflows", "chat-reply.yaml"))).toBe(false);
  });
});
