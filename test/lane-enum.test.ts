import test from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LaneManager } from "../src/manager.js";
import { LANE_NAMES } from "../src/types.js";
import { DISPATCH_PROFILES } from "../src/profiles.js";
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

test("public tools are the five lifecycle tools plus exactly one generated tool per profile", () => {
  const tools = capture({});
  assert.deepEqual([...tools.keys()].sort(), [
    "clanker_cancel",
    "clanker_list",
    "clanker_start",
    "clanker_start_codex-review",
    "clanker_start_codex-write",
    "clanker_start_gemini-recon",
    "clanker_start_grok-review",
    "clanker_start_grok-write",
    "clanker_start_oc-glm-write",
    "clanker_start_oc-kimi-crew",
    "clanker_start_oc-review",
    "clanker_start_oc-write",
    "clanker_status",
    "clanker_wait",
  ]);
  // The generated set is derived, never hand-maintained: one tool per row.
  assert.deepEqual(
    [...tools.keys()].filter((n) => n.startsWith("clanker_start_")).sort(),
    DISPATCH_PROFILES.map((p) => `clanker_start_${p.id}`).sort(),
  );
});

test("the generic start schema takes a profile name, not capability parameters", async () => {
  let received: any;
  const tools = capture({ async dispatchStart(args: any) { received = args; return { id: "x", warnings: [] }; } });
  const start = tools.get("clanker_start")!;
  const shape = start.config.inputSchema as z.ZodRawShape;
  const schema = z.object(shape);
  assert.deepEqual(Object.keys(shape), ["profile", "prompt", "cwd", "worktree", "model", "effort"]);
  for (const forbidden of ["lane", "read_only", "sandbox"]) {
    assert.equal(forbidden in shape, false, `'${forbidden}' must not be a caller-supplied parameter`);
  }
  assert.equal(schema.safeParse({ profile: "oc-kimi-crew", prompt: "work", worktree: "b" }).success, true);
  assert.equal(schema.safeParse({ profile: "worker", prompt: "work" }).success, false);
  assert.equal(schema.safeParse({ profile: "supervisor", prompt: "work" }).success, false);

  await start.handler({ profile: "gemini-recon", prompt: "inspect" });
  assert.deepEqual(received, {
    lane: "gemini", prompt: "inspect", cwd: undefined, worktree: undefined, model: undefined,
    effort: undefined, readOnly: true, sandbox: undefined, profile: undefined,
    secrets: [], supervision: "none", turnTimeoutMs: 660_000, profileId: "gemini-recon",
  }, "the registry — not the caller — supplies every capability dimension");
});

test("the generic start tool refuses a capability the named profile does not grant", async () => {
  const tools = capture({ async dispatchStart() { throw new Error("must not reach the manager"); } });
  const start = tools.get("clanker_start")!;
  // A read-only profile cannot be talked into a worktree, and a write profile
  // cannot be started without one; both fail before the manager is called.
  const noWorktree = await start.handler({ profile: "gemini-recon", prompt: "x", worktree: "raw-bypass" });
  assert.match(JSON.parse(noWorktree.content[0].text).error, /runs in place and does not take a worktree/);
  const needsWorktree = await start.handler({ profile: "codex-write", prompt: "x" });
  assert.match(JSON.parse(needsWorktree.content[0].text).error, /requires a managed worktree branch name/);
  const weldedModel = await start.handler({ profile: "oc-glm-write", prompt: "x", worktree: "b", model: "kimi" });
  assert.match(JSON.parse(weldedModel.content[0].text).error, /welds model='glm'/);
});
