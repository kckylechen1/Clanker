#!/usr/bin/env node
/**
 * clanker-mcp-server — a stdio MCP server that drives Codex / Opencode / Grok
 * Clankers over ACP (Agent Client Protocol) through host-specific adapters.
 *
 * Registered by the Claude Code adapter in plugin/ or the Codex adapter in
 * codex-plugin/. Each adapter passes its trusted host identity at startup.
 * Model/effort/read-only map onto each Clanker's real CLI surface in src/backends.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { LaneManager } from "./manager.js";
import { registerTools } from "./tools.js";
import { parseHostArgs } from "./host.js";

async function main(): Promise<void> {
  const host = parseHostArgs(process.argv.slice(2));
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const manager = new LaneManager({ host });
  registerTools(server, manager);

  const shutdown = async () => {
    try {
      await manager.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for diagnostics; stdout is the MCP channel.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} host=${host} running on stdio`);
}

main().catch((error) => {
  console.error("clanker fatal:", error);
  process.exit(1);
});
