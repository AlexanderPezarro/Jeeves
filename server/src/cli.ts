import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Runs Jeeves's conversation through the Claude Code CLI (via the Agent SDK) instead of the
 * API, so it uses whatever account the CLI is logged in with. Jeeves's tools are served to the
 * CLI from an in-process MCP server; the CLI's own tools (Bash, files, web) are switched off.
 */
export interface CliTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CliRunInput {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  prompt: string;
  tools: CliTool[];
  maxTurns: number;
  callTool: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

export interface CliRunOutput {
  transcript: SDKMessage[];
  inputTokens: number;
  outputTokens: number;
  finalText: string;
  error?: string;
}

const SERVER = "jeeves";

export type CliRunner = (input: CliRunInput) => Promise<CliRunOutput>;

export const claudeCliRun: CliRunner = async (input) => {
  const mcp = new McpServer({ name: SERVER, version: "0.1.0" }, { capabilities: { tools: {} } });
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: input.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const out = await input.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  });

  const transcript: SDKMessage[] = [];
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;

  for await (const msg of query({
    prompt: input.prompt,
    options: {
      model: input.model,
      effort: input.effort,
      systemPrompt: input.system,
      maxTurns: input.maxTurns,
      tools: [],
      mcpServers: { [SERVER]: { type: "sdk", name: SERVER, instance: mcp } },
      allowedTools: input.tools.map((t) => `mcp__${SERVER}__${t.name}`),
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
    },
  })) {
    transcript.push(msg);
    if (msg.type === "result") {
      inputTokens = msg.usage.input_tokens;
      outputTokens = msg.usage.output_tokens;
      if (msg.subtype === "success") finalText = msg.result.trim();
      else error = `${msg.subtype}${"errors" in msg && msg.errors?.length ? `: ${msg.errors.join("; ")}` : ""}`;
    }
  }
  return { transcript, inputTokens, outputTokens, finalText, error };
};
