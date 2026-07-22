import test from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LaneManager } from "../src/manager.js";
import { LANE_NAMES } from "../src/types.js";
import { laneEnum, registerTools } from "../src/tools.js";

// ---- lane list single-source-of-truth ------------------------------------
//
// tools.ts builds its dispatch-shape lane enum directly from LANE_NAMES
// (src/types.ts). This test imports the *actual* laneEnum tools.ts hands to
// zod, so a future hand-edit that re-forks the lane set back into a separate
// literal list in tools.ts (recreating the drift this pass removed) fails
// here instead of silently drifting.

test("tools.ts laneEnum accepts exactly LANE_NAMES and rejects anything else", () => {
  for (const lane of LANE_NAMES) {
    assert.equal(laneEnum.parse(lane), lane, `laneEnum should accept '${lane}'`);
  }

  assert.equal(LANE_NAMES.length, 3, "lane set is still exactly the three known lanes");
  assert.deepEqual([...LANE_NAMES].sort(), ["codex", "grok", "opencode"]);

  assert.throws(() => laneEnum.parse("claude"), /Invalid enum value|invalid_value/);
  assert.throws(() => laneEnum.parse(""), /Invalid enum value|invalid_value/);
  assert.throws(() => laneEnum.parse("Codex"), /Invalid enum value|invalid_value/);
});

test("read-only start tool has no override and forces readOnly even for an extra false field", async () => {
  type Registered = {
    config: { inputSchema: Record<string, unknown> };
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  };
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  let received: Record<string, unknown> | undefined;
  const manager = {
    async dispatchStart(params: Record<string, unknown>) {
      received = params;
      return { id: "readonly-test", warnings: [] };
    },
  } as unknown as LaneManager;

  registerTools(server, manager);
  const tool = tools.get("clanker_dispatch_readonly_start");
  assert.ok(tool, "read-only start tool is registered");
  assert.equal(Object.hasOwn(tool.config.inputSchema, "read_only"), false);

  await tool.handler({ lane: "grok", prompt: "inspect only", read_only: false });
  assert.equal(received?.readOnly, true, "handler override wins even if a raw caller injects read_only=false");
});
