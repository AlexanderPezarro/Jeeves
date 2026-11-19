import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PluginConfig } from "./config.js";

export interface PluginTool {
  /** Name exposed to Claude: `<plugin>__<tool>`. */
  name: string;
  plugin: string;
  tool: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** From the MCP tool annotations (readOnlyHint). Dry runs only call read-only tools. */
  read_only: boolean;
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
  now?: () => Date;
}

/**
 * Talks to plugins over MCP (Streamable HTTP). Each plugin is a separate service, so a plugin
 * that is down only removes its own tools; the rest keep working.
 */
export class McpPluginHost implements PluginHost {
  private clients = new Map<string, Client>();
  private statuses = new Map<string, PluginStatus>();
  protected readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;

  constructor(
    protected plugins: PluginConfig[],
    protected readonly opts: PluginHostOptions = {},
  ) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
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
    for (const name of [...this.statuses.keys()]) if (!plugins.some((p) => p.name === name)) this.statuses.delete(name);
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

  /** Called when a plugin becomes reachable. */
  protected onConnect(_name: string): void {}

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
        for (const t of tools) {
          all.push({
            name: `${p.name}${SEP}${t.name}`,
            plugin: p.name,
            tool: t.name,
            description: t.description ?? "",
            input_schema: t.inputSchema as Record<string, unknown>,
            read_only: t.annotations?.readOnlyHint === true,
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
