#!/usr/bin/env node
/**
 * clanker-mcp-server — a stdio MCP server that drives Codex / Opencode / Grok
 * Clankers over ACP (Agent Client Protocol) and exposes them to Claude
 * Code as blocking, progress-projecting tools.
 *
 * Registered by a Claude Code plugin (see plugin/) via ${CLAUDE_PLUGIN_ROOT}.
 * Model/effort/read-only map onto each Clanker's real CLI surface in src/backends.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { LaneManager } from "./manager.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const manager = new LaneManager();
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
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("clanker fatal:", error);
  process.exit(1);
});
