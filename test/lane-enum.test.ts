import test from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LaneManager } from "../src/manager.js";
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
    // The supervised correction turn. Narrow by the registry, not by this list:
    // it is registered unconditionally and refuses server-side unless the run
    // was minted from a profile whose supervision is `sonnet`.
    "clanker_prompt",
    "clanker_start_codex-review",
    "clanker_start_codex-write",
    "clanker_start_gemini-recon",
    "clanker_start_gemini-research",
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

test("there is no universal entrance — every start tool names exactly one profile", async () => {
  const received: any[] = [];
  const tools = capture({ async dispatchProfile(input: any) { received.push(input); return { id: "x", warnings: [] }; } });
  assert.equal(tools.has("clanker_start"), false, "the generic entrance voids the narrow tools' whole point");

  for (const [name, tool] of tools) {
    if (!name.startsWith("clanker_start_")) continue;
    const shape = tool.config.inputSchema as z.ZodRawShape;
    for (const forbidden of ["lane", "read_only", "profile"]) {
      assert.equal(forbidden in shape, false, `${name}: '${forbidden}' must not be a caller-supplied parameter`);
    }
  }

  // A narrow tool forwards free parameters and names its own profile; the
  // caller never gets to say which profile a tool starts.
  await tools.get("clanker_start_gemini-recon")!.handler({ prompt: "inspect", profile: "oc-glm-write" });
  assert.deepEqual(received, [{
    profile: "gemini-recon", prompt: "inspect", cwd: undefined,
    worktree: undefined, model: undefined, sandbox: undefined, effort: undefined,
  }], "the tool's own registry row — not the caller's argument — decides the profile");
});

test("a narrow start tool refuses a capability its profile does not grant", async () => {
  const tools = capture(new LaneManager({ disableReaper: true }));
  const errorOf = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await tools.get(name)!.handler(args)).content[0].text).error as string;

  // A read-only lane that forbids worktrees cannot be talked into one; a write
  // profile cannot start without one; a welded model cannot be overridden.
  assert.match(await errorOf("clanker_start_gemini-recon", { prompt: "x", worktree: "raw-bypass" }), /runs in place and does not take a worktree/);
  assert.match(await errorOf("clanker_start_codex-write", { prompt: "x" }), /requires a managed worktree branch name/);
  assert.match(await errorOf("clanker_start_oc-glm-write", { prompt: "x", worktree: "b", model: "kimi" }), /welds model='glm'/);
  assert.match(await errorOf("clanker_start_oc-write", { prompt: "x", worktree: "b", model: "glm" }), /GLM writes are supervised/);
});
