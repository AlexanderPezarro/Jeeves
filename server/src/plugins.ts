import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PluginInstructions } from "./agent.js";
import type { PluginConfig } from "./config.js";
import type { ItemAction } from "./db.js";
import { manifestSchema, pluginBase, resolveSecrets, type EventInfo, type Manifest } from "./manifest.js";

export interface PluginTool {
  /** Name exposed to Claude: `<plugin>__<tool>`. */
  name: string;
  plugin: string;
  tool: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** From the MCP tool annotations (readOnlyHint). Dry runs only call read-only tools. */
  read_only: boolean;
  /** For the workflow editor: the manifest's `steps.<tool>.title`, else the MCP tool title. */
  title: string | null;
  /** JSON Schema of the tool's result (manifest `steps.<tool>.output_schema`, else MCP outputSchema). */
  output_schema: Record<string, unknown> | null;
  /** The plugin's display name from its manifest, else its configured name. */
  plugin_title: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface PluginStatus {
  name: string;
  url: string;
  reachable: boolean | null;
  tool_count: number;
  last_error: string | null;
  last_seen: string | null;
}

/** Anything that can list and call plugin tools. Tests swap in a fake. */
export interface PluginHost {
  listTools(): Promise<PluginTool[]>;
  call(plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  status?(): PluginStatus[];
  /** Notification buttons for a plugin's items, from its manifest. */
  itemActions?(plugin: string): ItemAction[];
  /** What each plugin tells Claude about its tools (manifest `instructions`). */
  instructions?(): PluginInstructions[];
}

/** A list the app can show, served by a plugin. */
export interface PluginView {
  plugin: string;
  id: string;
  title: string;
  empty_text?: string;
}

const SEP = "__";

export function splitToolName(name: string): { plugin: string; tool: string } | null {
  const i = name.indexOf(SEP);
  return i > 0 ? { plugin: name.slice(0, i), tool: name.slice(i + SEP.length) } : null;
}

export interface PluginHostOptions {
  env?: NodeJS.ProcessEnv;
  /** Called on the first contact and whenever a plugin flips between reachable and unreachable. */
  onStatusChange?: (name: string, reachable: boolean, status: PluginStatus) => void;
  /** Called after each manifest fetch (null = tools-only). */
  onManifest?: (name: string, manifest: Manifest | null) => void;
  /** Stored settings values for a plugin (config/plugins/<name>.yaml), pushed on every (re)connect. */
  settingsFor?: (name: string) => Record<string, unknown> | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Talks to plugins over MCP (Streamable HTTP). Each plugin is a separate service, so a plugin
 * that is down only removes its own tools; the rest keep working.
 */
export class McpPluginHost implements PluginHost {
  private clients = new Map<string, Client>();
  private statuses = new Map<string, PluginStatus>();
  private manifests = new Map<string, Manifest | null>();
  private background = new Set<Promise<unknown>>();
  protected readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly fetch: typeof fetch;

  constructor(
    protected plugins: PluginConfig[],
    protected readonly opts: PluginHostOptions = {},
  ) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
  }

  /** Swaps the plugin list after a config reload; clients for removed or changed plugins are dropped. */
  setPlugins(plugins: PluginConfig[]) {
    for (const [name, client] of this.clients) {
      const before = this.plugins.find((p) => p.name === name);
      const after = plugins.find((p) => p.name === name);
      if (!after || JSON.stringify(before) !== JSON.stringify(after)) {
        void client.close().catch(() => {});
        this.clients.delete(name);
      }
    }
    for (const name of [...this.statuses.keys()]) {
      const before = this.plugins.find((p) => p.name === name);
      const after = plugins.find((p) => p.name === name);
      if (!after || JSON.stringify(before) !== JSON.stringify(after)) {
        this.statuses.delete(name); // next contact counts as a (re)connect
        this.manifests.delete(name);
      }
    }
    this.plugins = plugins;
  }

  pluginConfig(name: string): PluginConfig | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  token(name: string): string | undefined {
    const cfg = this.pluginConfig(name);
    return cfg ? this.env[cfg.token_env] : undefined;
  }

  status(): PluginStatus[] {
    return this.plugins.map(
      (p) => this.statuses.get(p.name) ?? { name: p.name, url: p.url, reachable: null, tool_count: 0, last_error: null, last_seen: null },
    );
  }

  /** Records a contact outcome. Subclasses hook here to react to (re)connects. */
  protected markStatus(name: string, ok: boolean, info: { tool_count?: number; error?: string } = {}) {
    const cfg = this.pluginConfig(name);
    if (!cfg) return;
    const prev = this.statuses.get(name);
    const next: PluginStatus = {
      name,
      url: cfg.url,
      reachable: ok,
      tool_count: info.tool_count ?? prev?.tool_count ?? 0,
      last_error: ok ? null : (info.error ?? "unreachable"),
      last_seen: ok ? this.now().toISOString() : (prev?.last_seen ?? null),
    };
    if (!ok) next.tool_count = 0;
    this.statuses.set(name, next);
    if (prev?.reachable !== ok) {
      this.opts.onStatusChange?.(name, ok, next);
      if (ok) this.onConnect(name);
    }
  }

  // Manifest and settings ----------------------------------------------------

  baseUrl(name: string): string | undefined {
    const cfg = this.pluginConfig(name);
    return cfg ? pluginBase(cfg.url) : undefined;
  }

  /** The cached manifest (null = tools-only plugin, undefined = not fetched yet). */
  manifest(name: string): Manifest | null | undefined {
    return this.manifests.get(name);
  }

  /** `<plugin>.<event>` for every event a plugin's manifest declares. */
  manifestEvents(): string[] {
    return this.manifestEventInfo().map((e) => e.type);
  }

  /** Every event the plugins' manifests declare, typed `<plugin>.<event>`, with their descriptions. */
  manifestEventInfo(): (EventInfo & { source: string })[] {
    return this.plugins.flatMap((p) => (this.manifests.get(p.name)?.event_info ?? []).map((e) => ({ ...e, type: `${p.name}.${e.type}`, source: p.name })));
  }

  /** Every list view the plugins' manifests declare, in plugin order. */
  views(): PluginView[] {
    return this.plugins.flatMap((p) => (this.manifests.get(p.name)?.views ?? []).map((v) => ({ plugin: p.name, ...v })));
  }

  /** Each plugin's guidance for Claude (manifest `instructions`), titled with its display name. */
  instructions(): PluginInstructions[] {
    return this.plugins.flatMap((p) => {
      const m = this.manifests.get(p.name);
      return m?.instructions ? [{ plugin: p.name, title: m.display_name, text: m.instructions }] : [];
    });
  }

  /** The notification buttons a plugin declares for its items (manifest `item_actions`). */
  itemActions(name: string): ItemAction[] {
    return this.manifests.get(name)?.item_actions ?? [];
  }

  /**
   * A JSON request to the plugin's `/jeeves` API (views, actions), with its bearer token.
   * Resolves with the status and parsed body; throws only when the plugin can't be reached.
   */
  async jeevesRequest(name: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const base = this.baseUrl(name);
    if (!base) throw Object.assign(new Error(`no plugin ${name}`), { notFound: true });
    const res = await this.fetch(`${base}/jeeves${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token(name)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text.slice(0, 500) };
    }
    return { status: res.status, body: parsed };
  }

  /** Fetches and caches `GET <base>/jeeves/manifest`. A 404 or invalid manifest means tools-only. */
  async refreshManifest(name: string): Promise<Manifest | null> {
    const base = this.baseUrl(name);
    const token = this.token(name);
    if (!base || !token) return null;
    let manifest: Manifest | null = null;
    try {
      const res = await this.fetch(`${base}/jeeves/manifest`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const parsed = manifestSchema.safeParse(await res.json());
        if (parsed.success) manifest = parsed.data;
        else console.warn(`Plugin ${name}: invalid manifest, treating it as tools-only: ${parsed.error.message}`);
      }
    } catch (e) {
      console.warn(`Plugin ${name}: manifest fetch failed: ${(e as Error).message}`);
      if (this.manifests.has(name)) return this.manifests.get(name) ?? null; // keep the last one on a blip
    }
    this.manifests.set(name, manifest);
    this.opts.onManifest?.(name, manifest);
    return manifest;
  }

  /**
   * Pushes the plugin's stored settings (secrets resolved from the environment) to
   * `PUT <base>/jeeves/settings`. Throws with the plugin's answer when it refuses.
   */
  async pushSettings(name: string, values?: Record<string, unknown>): Promise<void> {
    const manifest = this.manifests.get(name) ?? (await this.refreshManifest(name));
    if (!manifest?.settings_schema) return;
    const stored = values ?? this.opts.settingsFor?.(name) ?? {};
    const { values: resolved, missing } = resolveSecrets(manifest.settings_schema, stored, this.env);
    if (missing.length) console.warn(`Plugin ${name}: environment variable(s) ${missing.join(", ")} not set; leaving those settings out`);
    const res = await this.fetch(`${this.baseUrl(name)}/jeeves/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token(name)}`, "Content-Type": "application/json" },
      body: JSON.stringify(resolved),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`plugin answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  /** On every (re)connect: refresh the manifest and re-push settings, so a restarted plugin gets them back. */
  protected onConnect(name: string): void {
    const work = this.refreshManifest(name)
      .then(() => this.pushSettings(name))
      .catch((e) => console.warn(`Plugin ${name}: settings push failed: ${(e as Error).message}`));
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /** Waits for manifest/settings work started by reconnects; used by tests. */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  private async client(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const cfg = this.pluginConfig(name);
    if (!cfg) throw new Error(`Unknown plugin: ${name}`);
    const token = this.env[cfg.token_env];
    if (!token) throw new Error(`Plugin ${name}: environment variable ${cfg.token_env} is not set`);
    const client = new Client({ name: "jeeves-server", version: "0.1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    this.clients.set(name, client);
    return client;
  }

  async listTools(): Promise<PluginTool[]> {
    const all: PluginTool[] = [];
    for (const p of this.plugins) {
      try {
        const { tools } = await (await this.client(p.name)).listTools();
        const manifest = this.manifests.get(p.name);
        for (const t of tools) {
          const step = manifest?.steps[t.name];
          all.push({
            name: `${p.name}${SEP}${t.name}`,
            plugin: p.name,
            tool: t.name,
            description: t.description ?? "",
            input_schema: t.inputSchema as Record<string, unknown>,
            read_only: t.annotations?.readOnlyHint === true,
            title: step?.title ?? t.title ?? t.annotations?.title ?? null,
            output_schema: step?.output_schema ?? (t.outputSchema as Record<string, unknown> | undefined) ?? null,
            plugin_title: manifest?.display_name ?? p.name,
          });
        }
        this.markStatus(p.name, true, { tool_count: tools.length });
      } catch (e) {
        this.clients.delete(p.name);
        this.markStatus(p.name, false, { error: (e as Error).message });
        console.warn(`Plugin ${p.name} unavailable: ${(e as Error).message}`);
      }
    }
    return all;
  }

  async call(plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const res = await (await this.client(plugin)).callTool({ name: tool, arguments: args });
      const text = (res.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      this.markStatus(plugin, true);
      return { text, isError: res.isError === true };
    } catch (e) {
      this.clients.delete(plugin);
      this.markStatus(plugin, false, { error: (e as Error).message });
      return { text: `Plugin ${plugin} failed: ${(e as Error).message}`, isError: true };
    }
  }
}
