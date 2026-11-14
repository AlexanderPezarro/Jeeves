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
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** Anything that can list and call plugin tools. Tests swap in a fake. */
export interface PluginHost {
  listTools(): Promise<PluginTool[]>;
  call(plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult>;
}

const SEP = "__";

export function splitToolName(name: string): { plugin: string; tool: string } | null {
  const i = name.indexOf(SEP);
  return i > 0 ? { plugin: name.slice(0, i), tool: name.slice(i + SEP.length) } : null;
}

/**
 * Talks to plugins over MCP (Streamable HTTP). Each plugin is a separate service, so a plugin
 * that is down only removes its own tools; the rest keep working.
 */
export class McpPluginHost implements PluginHost {
  private clients = new Map<string, Client>();

  constructor(
    private readonly plugins: PluginConfig[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async client(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const cfg = this.plugins.find((p) => p.name === name);
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
          });
        }
      } catch (e) {
        this.clients.delete(p.name);
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
      return { text, isError: res.isError === true };
    } catch (e) {
      this.clients.delete(plugin);
      return { text: `Plugin ${plugin} failed: ${(e as Error).message}`, isError: true };
    }
  }
}
