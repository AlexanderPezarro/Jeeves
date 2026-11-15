import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isDue } from "./recurrence.js";
import { seedFromFile } from "./seed.js";
import { TodoStore } from "./store.js";
import { buildApp } from "./index.js";

describe("recurrence", () => {
  it("handles weekly, monthly and interval rules", () => {
    expect(isDue({ every: "week", on: ["sat"] }, "2026-11-14")).toBe(true);
    expect(isDue({ every: "week", on: ["sun"] }, "2026-11-14")).toBe(false);
    expect(isDue({ every: "month", day: 31 }, "2026-11-30")).toBe(true);
    expect(isDue({ every: "days", interval: 3, start: "2026-11-08" }, "2026-11-14")).toBe(true);
    expect(isDue({ every: "days", interval: 3, start: "2026-11-08" }, "2026-11-13")).toBe(false);
  });
});

describe("TodoStore", () => {
  const sat = "2026-11-14"; // a Saturday
  const now = new Date("2026-11-14T18:20:00Z");

  function seeded() {
    const store = new TodoStore();
    seedFromFile(store, "chores.example.yaml");
    return store;
  }

  it("lists due chores easiest first", () => {
    const tasks = seeded().listDue(sat, now);
    expect(tasks.map((t) => t.chore_id)).toEqual(["dishes", "hoover", "run"]);
  });

  it("carries unfinished tasks over and drops finished ones", () => {
    const store = seeded();
    const thu = store.listDue("2026-11-12", now);
    const dishes = thu.find((t) => t.chore_id === "dishes")!;
    store.setState(dishes.id, "done", now);
    // Thursday's run was not done, so it shows up on Saturday as overdue.
    const tasks = store.listDue(sat, now);
    const overdueRun = tasks.find((t) => t.chore_id === "run" && t.due_date === "2026-11-12");
    expect(overdueRun?.overdue_days).toBe(2);
    expect(tasks.filter((t) => t.chore_id === "dishes")).toHaveLength(1);
  });

  it("hides snoozed tasks until the snooze ends", () => {
    const store = seeded();
    const [first] = store.listDue(sat, now);
    store.snooze(first.id, 30, now);
    expect(store.listDue(sat, now).some((t) => t.id === first.id)).toBe(false);
    const later = new Date(now.getTime() + 31 * 60_000);
    expect(store.listDue(sat, later).some((t) => t.id === first.id)).toBe(true);
  });
});

describe("MCP endpoint", () => {
  it("exposes the to-do tools and returns laundry follow-ups on start", async () => {
    const store = new TodoStore();
    seedFromFile(store, "chores.example.yaml");
    const now = () => new Date("2026-11-15T10:00:00Z"); // Sunday: laundry day
    const app = buildApp({ store, token: "secret", timeZone: "Europe/London", now });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer secret" } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["complete_task", "get_chore", "list_due_tasks", "skip_task", "snooze_task", "start_task"].sort(),
    );

    const due = await client.callTool({ name: "list_due_tasks", arguments: {} });
    const tasks = JSON.parse((due.content as { text: string }[])[0].text);
    const laundry = tasks.find((t: { chore_id: string }) => t.chore_id === "laundry");
    expect(laundry).toBeDefined();

    const started = await client.callTool({ name: "start_task", arguments: { task_id: laundry.id } });
    const { followups } = JSON.parse((started.content as { text: string }[])[0].text);
    expect(followups).toEqual([
      { at: "2026-11-15T11:15:00.000Z", message: expect.stringContaining("dryer") },
      { at: "2026-11-15T12:15:00.000Z", message: expect.stringContaining("fold") },
    ]);

    await client.close();
    await app.close();
  });

  it("rejects requests without the token", async () => {
    const app = buildApp({ store: new TodoStore(), token: "secret", timeZone: "Europe/London" });
    const res = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
