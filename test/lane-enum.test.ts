import test from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LaneManager } from "../src/manager.js";
import { LANE_NAMES } from "../src/types.js";
import { laneEnum, registerTools } from "../src/tools.js";

type Registered = { config: { inputSchema: Record<string, unknown> }; handler: (args: any) => Promise<any> };
function capture(manager: any) {
  const tools = new Map<string, Registered>();
  const server = { registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
    tools.set(name, { config, handler });
  } } as unknown as McpServer;
  registerTools(server, manager as LaneManager);
  return tools;
}

test("laneEnum accepts exactly the backend registry", () => {
  assert.deepEqual([...LANE_NAMES].sort(), ["codex", "gemini", "grok", "opencode"]);
  for (const lane of LANE_NAMES) assert.equal(laneEnum.parse(lane), lane);
  for (const bad of ["claude", "", "Codex"]) assert.throws(() => laneEnum.parse(bad));
});

test("public tools are exactly the five unified lifecycle tools", () => {
  const tools = capture({});
  assert.deepEqual([...tools.keys()].sort(), ["clanker_cancel", "clanker_list", "clanker_start", "clanker_status", "clanker_wait"]);
});

test("unified start schema exposes only worker and kimi-crew profiles", async () => {
  let received: any;
  const tools = capture({ async dispatchStart(args: any) { received = args; return { id: "x", warnings: [] }; } });
  const start = tools.get("clanker_start")!;
  const schema = z.object(start.config.inputSchema as z.ZodRawShape);
  assert.equal(schema.safeParse({ lane: "opencode", prompt: "work", profile: "worker" }).success, true);
  assert.equal(schema.safeParse({ lane: "opencode", prompt: "work", profile: "kimi-crew" }).success, true);
  assert.equal(schema.safeParse({ lane: "opencode", prompt: "work", profile: "supervisor" }).success, false);
  await start.handler({ lane: "gemini", prompt: "inspect", read_only: false, worktree: "raw-bypass", profile: "worker" });
  assert.deepEqual(received, {
    lane: "gemini", prompt: "inspect", cwd: undefined, worktree: "raw-bypass", model: undefined,
    effort: undefined, readOnly: false, sandbox: undefined, profile: "worker",
  }, "thin tool forwards truthfully and leaves policy enforcement to the manager");
});
