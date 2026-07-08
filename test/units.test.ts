import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { choosePermissionOption } from "../src/acp-client.js";
import { DIGEST_CHAR_BUDGET, resolveOcModel } from "../src/constants.js";
import { buildSpawnSpec } from "../src/backends.js";
import { LaneRun } from "../src/run.js";

// ---- CP3: opencode model shortname single source ------------------------

test("CP3: resolveOcModel expands shortnames and passes full ids through", () => {
  assert.equal(resolveOcModel("glm"), "zhipuai-coding-plan/glm-5.2");
  assert.equal(resolveOcModel("ds"), "deepseek/deepseek-v4-pro");
  assert.equal(resolveOcModel("kimi"), "kimi-for-coding/k2p6");
  assert.equal(resolveOcModel("free"), "opencode/deepseek-v4-flash-free");
  assert.equal(resolveOcModel("anthropic/claude"), "anthropic/claude");
  assert.equal(resolveOcModel("unknown"), "unknown");
  assert.equal(resolveOcModel(undefined), undefined);
});

test("CP3: opencode lane writes the resolved full model id into OPENCODE_CONFIG", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-"));
  const spec = buildSpawnSpec("opencode", { model: "glm" }, runDir);
  assert.ok(spec.env.OPENCODE_CONFIG, "OPENCODE_CONFIG env is set");
  const cfg = JSON.parse(fs.readFileSync(spec.env.OPENCODE_CONFIG, "utf8"));
  assert.equal(cfg.model, "zhipuai-coding-plan/glm-5.2");
});

// ---- CP5: read-only never auto-approves ---------------------------------

test("CP5: read-only with only an allow option declines (cancelled), never selects allow", () => {
  const res = choosePermissionOption([{ optionId: "a", kind: "allow_once" }], true);
  assert.equal(res.outcome.outcome, "cancelled");
});

test("CP5: read-only selects an available reject option", () => {
  const res = choosePermissionOption(
    [
      { optionId: "r", kind: "reject_once" },
      { optionId: "a", kind: "allow_once" },
    ],
    true,
  );
  assert.equal(res.outcome.outcome, "selected");
  assert.equal(res.outcome.outcome === "selected" ? res.outcome.optionId : "", "r");
});

test("CP5: write mode selects the first allow option", () => {
  const res = choosePermissionOption(
    [
      { optionId: "a1", kind: "allow_once" },
      { optionId: "a2", kind: "allow_always" },
    ],
    false,
  );
  assert.equal(res.outcome.outcome, "selected");
  assert.equal(res.outcome.outcome === "selected" ? res.outcome.optionId : "", "a1");
});

test("CP5: empty options always cancel", () => {
  assert.equal(choosePermissionOption([], false).outcome.outcome, "cancelled");
  assert.equal(choosePermissionOption([], true).outcome.outcome, "cancelled");
});

// ---- CP4: digest is capped at the char budget ---------------------------

test("CP4: a large event burst yields a digest at/under the char budget with a truncation marker", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({
    id: "unit-1",
    lane: "codex",
    cwd: os.tmpdir(),
    runDir,
    readOnly: true,
  });
  run.beginTurn("overflow");
  for (let i = 0; i < 80; i++) {
    run.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: `t${i}`,
      title: `overflow tool call number ${i} with a deliberately longish title`,
      status: "completed",
    } as unknown as SessionUpdate);
  }
  const digest = run.drainDigest();
  assert.ok(digest.length > 0, "digest is non-empty");
  assert.ok(
    digest.length <= DIGEST_CHAR_BUDGET + 2,
    `digest length ${digest.length} should be <= budget ${DIGEST_CHAR_BUDGET} (+2 marker)`,
  );
  assert.ok(digest.startsWith("…"), "over-budget digest starts with the truncation marker");
  run.closeStreams();
});
