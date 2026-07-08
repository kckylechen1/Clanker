#!/usr/bin/env node
/**
 * progress-probe — the smallest MCP server that streams notifications/progress.
 *
 * Step 0 of the Clanker spec: prove (or disprove) that Claude Code bubbles a
 * nested subagent's MCP progress notifications up to the bottom task line. If it
 * does, channel one (plan -> notifications/progress -> live checkbox) is free.
 * This server does NOT decide the outcome — the leader observes and decides.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "progress-probe", version: "0.1.0" });

server.registerTool(
  "probe_progress",
  {
    title: "Emit stepwise MCP progress",
    description:
      "Emit `steps` notifications/progress, one every `interval_ms`, each carrying a checkbox-style message like `[2/5] ✓step1 ✓step2 ⋯step3`. Returns a completion summary after the last step. Use this to watch whether the progress text shows up on the bottom task line.",
    inputSchema: {
      steps: z.number().int().min(1).max(20).default(5).describe("Number of progress steps to emit"),
      interval_ms: z.number().int().min(50).max(5000).default(1000).describe("Delay between steps in ms"),
    },
  },
  async ({ steps, interval_ms }, extra) => {
    const token = extra?._meta?.progressToken;
    const labels = Array.from({ length: steps }, (_, i) => `step${i + 1}`);

    for (let k = 1; k <= steps; k++) {
      // Completed steps get ✓; the next pending step gets a ⋯ "now working" hint.
      const shown = labels
        .map((l, i) => (i < k ? `✓${l}` : i === k ? `⋯${l}` : l))
        .join(" ");
      const message = `[${k}/${steps}] ${shown}`;

      if (token !== undefined && token !== null && typeof extra.sendNotification === "function") {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: k, total: steps, message },
        });
      }
      if (k < steps) await new Promise((r) => setTimeout(r, interval_ms));
    }

    return {
      content: [
        {
          type: "text",
          text: `probe_progress complete: emitted ${steps} progress notifications at ${interval_ms}ms intervals.`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("progress-probe running on stdio");
