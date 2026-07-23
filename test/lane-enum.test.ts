import test from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LaneManager } from "../src/manager.js";
import { LANE_NAMES } from "../src/types.js";
import { laneEnum, registerTools } from "../src/tools.js";

// ---- lane list single-source-of-truth ------------------------------------
//
// laneEnum is the full registry enum built directly from LANE_NAMES. Runtime
// tools derive a narrower enum from the trusted host; test/host.test.ts checks
// those registered schemas separately.

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
  let supervisedGlmReceived: Record<string, unknown> | undefined;
  const manager = {
    async dispatchStart(params: Record<string, unknown>) {
      received = params;
      return { id: "readonly-test", warnings: [] };
    },
    async dispatchSupervisedGlmWrite(params: Record<string, unknown>) {
      supervisedGlmReceived = params;
      return { id: "glm-write-test", warnings: [] };
    },
    async dispatchBlocking(params: Record<string, unknown>) {
      received = params;
      return { status: "done", final_message: "", touched_files: [], plan_final: undefined };
    },
  } as unknown as LaneManager;

  registerTools(server, manager);
  const tool = tools.get("clanker_dispatch_readonly_start");
  assert.ok(tool, "read-only start tool is registered");
  assert.equal(Object.hasOwn(tool.config.inputSchema, "read_only"), false);
  assert.equal(Object.hasOwn(tool.config.inputSchema, "sandbox"), false);

  await tool.handler({
    lane: "codex",
    prompt: "inspect only",
    read_only: false,
    sandbox: "danger-full-access",
  });
  assert.equal(received?.readOnly, true, "handler override wins even if a raw caller injects read_only=false");
  assert.equal(received?.sandbox, undefined, "handler drops a raw write-capable sandbox injection");

  // Regression: an omitted opencode model let opencode's own config default
  // (possibly GLM) run outside the vault-exec credential wrap. read_only was
  // exactly the path that skipped both the old manager-level write-only model
  // check and buildSpawnSpec's own vault-wrap decision.
  const beforeMissingReadonlyModel: Record<string, unknown> | undefined = received;
  const missingReadonlyModel = await tool.handler({
    lane: "opencode",
    prompt: "inspect only",
  });
  assert.equal(received, beforeMissingReadonlyModel, "read-only opencode dispatch without a model must not reach the manager");
  assert.match(JSON.stringify(missingReadonlyModel), /explicit model is required for read-only opencode dispatch/);

  const writeTool = tools.get("clanker_dispatch_write_start");
  assert.ok(writeTool, "isolated write start tool is registered");
  assert.equal(Object.hasOwn(writeTool.config.inputSchema, "read_only"), false);
  const writeSchema = z.object(writeTool.config.inputSchema as z.ZodRawShape);
  assert.equal(writeSchema.safeParse({ lane: "codex", prompt: "implement" }).success, false);
  assert.equal(
    writeSchema.safeParse({ lane: "codex", prompt: "implement", worktree: "clanker/test-write-default-model" }).success,
    true,
    "codex writes may inherit the configured default model",
  );
  assert.equal(
    writeSchema.safeParse({ lane: "codex", model: "terra", prompt: "implement", worktree: "   " }).success,
    false,
  );
  assert.equal(
    writeSchema.safeParse({
      lane: "codex",
      model: "terra",
      prompt: "implement",
      worktree: "clanker/test-write",
    }).success,
    true,
  );

  const beforeMissingExternalModel: Record<string, unknown> | undefined = received;
  const missingExternalModel = await writeTool.handler({
    lane: "opencode",
    prompt: "implement",
    worktree: "clanker/test-missing-model",
  });
  assert.equal(received, beforeMissingExternalModel, "external write lanes still require an explicit model");
  assert.match(JSON.stringify(missingExternalModel), /explicit model is required for write lane 'opencode'/);

  await writeTool.handler({
    lane: "codex",
    prompt: "implement",
    worktree: "clanker/test-write",
    read_only: true,
  });
  assert.equal(received?.model, undefined, "omitted codex model stays omitted for backend default resolution");
  assert.equal(received?.readOnly, false, "handler override wins even if a raw caller injects read_only=true");

  for (const model of [
    "glm",
    "GLM",
    " glm ",
    "zhipuai-coding-plan/glm-5.2",
    "zhipuai-coding-plan/GLM-5.2",
    "zhipuai-coding-plan/glm-5.3-future",
  ]) {
    const beforeRejectedGlm: Record<string, unknown> | undefined = received;
    const rejectedGlm = await writeTool.handler({
      lane: "opencode",
      model,
      prompt: "implement",
      worktree: "clanker/test-glm-bypass",
    });
    assert.equal(received, beforeRejectedGlm, `generic writer must not dispatch GLM model '${model}'`);
    assert.match(JSON.stringify(rejectedGlm), /GLM writes require clanker_dispatch_glm_write_start/);
  }

  for (const toolName of ["clanker_dispatch_start", "clanker_dispatch"] as const) {
    const genericTool = tools.get(toolName);
    assert.ok(genericTool, `${toolName} is registered`);
    for (const lane of LANE_NAMES) {
      const beforeRejectedGlm: Record<string, unknown> | undefined = received;
      const rejectedGlm = await genericTool.handler({
        lane,
        model: "glm",
        prompt: "implement",
        worktree: "clanker/test-generic-glm-bypass",
        read_only: false,
      });
      assert.equal(received, beforeRejectedGlm, `${toolName} must reject GLM on lane '${lane}'`);
      assert.match(JSON.stringify(rejectedGlm), /GLM writes require clanker_dispatch_glm_write_start/);
    }
  }

  const glmTool = tools.get("clanker_dispatch_glm_write_start");
  assert.ok(glmTool, "supervised GLM write start tool is registered");
  assert.equal(Object.hasOwn(glmTool.config.inputSchema, "lane"), false);
  assert.equal(Object.hasOwn(glmTool.config.inputSchema, "model"), false);
  assert.equal(Object.hasOwn(glmTool.config.inputSchema, "read_only"), false);
  const glmSchema = z.object(glmTool.config.inputSchema as z.ZodRawShape);
  assert.equal(glmSchema.safeParse({ prompt: "implement" }).success, false);
  assert.equal(glmSchema.safeParse({ prompt: "implement", worktree: "   " }).success, false);
  assert.equal(
    glmSchema.safeParse({ prompt: "implement", worktree: "clanker/test-glm-write" }).success,
    true,
  );

  await glmTool.handler({
    lane: "codex",
    model: "terra",
    prompt: "implement",
    worktree: "clanker/test-glm-write",
    read_only: true,
  });
  assert.deepEqual(supervisedGlmReceived, {
    prompt: "implement",
    cwd: undefined,
    worktree: "clanker/test-glm-write",
    seat: undefined,
  }, "handler passes only the fixed supervised method's allowed fields");
});
