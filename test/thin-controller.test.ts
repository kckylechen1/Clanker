import "./isolate.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { buildSpawnSpec } from "../src/backends.js";
import { LaneManager } from "../src/manager.js";
import { DISPATCH_PROFILES } from "../src/profiles.js";
import { registerTools } from "../src/tools.js";
import { choosePermissionOption, resolveContainedReadPath, resolveContainedWritePath } from "../src/acp-client.js";
import { fakeSpec, until } from "./helpers.js";

function captureTools(manager: LaneManager) {
  const tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
  registerTools({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } } as any, manager);
  return tools;
}

test("public inventory is one generated tool per profile plus five lifecycle tools", () => {
  const manager = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true });
  assert.deepEqual([...captureTools(manager).keys()], [
    ...DISPATCH_PROFILES.map((p) => `clanker_start_${p.id}`),
    "clanker_wait", "clanker_prompt", "clanker_status", "clanker_cancel", "clanker_list",
  ]);
});

test("host=codex sees neither its own lane nor the supervised-GLM profile", () => {
  const manager = new LaneManager({ host: "codex", resolveSpec: () => fakeSpec(), disableReaper: true });
  const names = [...captureTools(manager).keys()];
  // 0.2.x parity: clanker_dispatch_glm_write_start was registered only when
  // host !== "codex", because the supervised shape needs the Sonnet seat.
  assert.equal(names.includes("clanker_start_oc-glm-write"), false);
  assert.equal(names.includes("clanker_start_codex-review"), false, "self-dispatch lane is not offered at all");
  assert.equal(names.includes("clanker_start_codex-write"), false);
  assert.equal(names.includes("clanker_start_oc-review"), true);
});

test("a completed one-shot job closes its ACP session before publishing done", async () => {
  const manager = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true });
  try {
    const { id } = await manager.dispatchStart({
      lane: "codex",
      prompt: "one-shot",
      cwd: os.tmpdir(),
      readOnly: true,
    });
    await until(() => manager.status(id).status === "done", 2_000);
    assert.equal(manager.list().some((entry) => entry.id === id), false);
  } finally {
    await manager.shutdown();
  }
});

test("each generated tool exposes only its own profile's free parameters", () => {
  const manager = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true });
  const tools = captureTools(manager);
  // Read-only codex review: prompt/cwd/worktree(optional)/base/doNotTouch/
  // effort — no model (lane default), no sandbox (welded read-only), no lane,
  // no read_only. base/doNotTouch exist wherever a worktree can.
  assert.deepEqual(Object.keys(tools.get("clanker_start_codex-review")!.config.inputSchema), ["prompt", "cwd", "worktree", "base", "doNotTouch", "effort"]);
  // Write codex: adds a caller-selectable sandbox, and worktree is mandatory.
  assert.deepEqual(Object.keys(tools.get("clanker_start_codex-write")!.config.inputSchema), ["prompt", "cwd", "worktree", "base", "doNotTouch", "sandbox", "effort"]);
  // OpenCode write: model is the caller's, sandbox is not a knob on this lane.
  assert.deepEqual(Object.keys(tools.get("clanker_start_oc-write")!.config.inputSchema), ["prompt", "cwd", "worktree", "base", "doNotTouch", "model", "effort"]);
  // Supervised GLM: everything but prompt/cwd/worktree/base/doNotTouch/effort is welded.
  assert.deepEqual(Object.keys(tools.get("clanker_start_oc-glm-write")!.config.inputSchema), ["prompt", "cwd", "worktree", "base", "doNotTouch", "effort"]);
  // Gemini: the lane forbids worktrees, so the parameter does not exist.
  assert.deepEqual(Object.keys(tools.get("clanker_start_gemini-recon")!.config.inputSchema), ["prompt", "cwd", "effort"]);

  const codexWrite = z.object(tools.get("clanker_start_codex-write")!.config.inputSchema);
  assert.equal(codexWrite.safeParse({ prompt: "w", worktree: "b" }).success, true);
  assert.equal(codexWrite.safeParse({ prompt: "w" }).success, false, "a write tool cannot start without a worktree");
  assert.equal(codexWrite.safeParse({ prompt: "w", worktree: "b", sandbox: "nonsense" }).success, false);
});

test("manager centralizes host, Gemini, write isolation, model, and GLM gates", async () => {
  const manager = new LaneManager({ host: "codex", resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  await assert.rejects(() => manager.dispatchStart({ lane: "codex", prompt: "self", readOnly: true }), /self-dispatch/);
  await assert.rejects(() => manager.dispatchStart({ lane: "gemini", prompt: "r", worktree: "x" }), /Gemini rejects worktree/);
  await assert.rejects(() => manager.dispatchStart({ lane: "opencode", prompt: "w", readOnly: false, worktree: "x" }), /explicit model/);
  await assert.rejects(() => manager.dispatchStart({ lane: "opencode", model: "glm", prompt: "w", readOnly: false, worktree: "x" }), /direct GLM write is prohibited/);
  await assert.rejects(() => manager.dispatchStart({ lane: "grok", model: "grok-4.5", prompt: "w", readOnly: false }), /isolated worktree/);
  await manager.shutdown();
});

test("OpenCode worker stays inline, Kimi Crew uses installed profile, and neither spawn uses tachi", () => {
  for (const [profile, expected] of [["worker", "clanker-worker"], ["kimi-crew", "kimi-crew"]] as const) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-config-"));
    const spec = buildSpawnSpec("opencode", { model: "kimi", readOnly: profile === "worker", profile }, runDir);
    const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(spec.command, "opencode");
    assert.equal(config.default_agent, expected);
    if (profile === "worker") assert.ok(config.agent?.["clanker-worker"]);
    else assert.equal(config.agent, undefined, "Kimi Crew must come from the installed OpenCode profile");
  }
});

test("read-only ACP permission handling never approves writes", () => {
  assert.deepEqual(choosePermissionOption([{ optionId: "yes", kind: "allow_once" }], true), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(choosePermissionOption([{ optionId: "no", kind: "reject_once" }], true), { outcome: { outcome: "selected", optionId: "no" } });
});

test("ACP file paths remain realpath-contained", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-outside-"));
  fs.writeFileSync(path.join(root, "ok"), "ok");
  fs.writeFileSync(path.join(outside, "secret"), "secret");
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "link"));
  assert.equal(resolveContainedReadPath(root, "ok"), path.join(fs.realpathSync(root), "ok"));
  assert.throws(() => resolveContainedReadPath(root, "link"), /boundary rejection/);
  assert.throws(() => resolveContainedWritePath(root, "../escape"), /boundary rejection/);
});

test("hard timeout and cancel escalation force terminal states", async () => {
  const timed = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), turnTimeoutMs: 80 });
  const { id: timedId } = await timed.dispatchStart({ lane: "codex", prompt: "STALL", cwd: os.tmpdir(), readOnly: true });
  await until(() => timed.status(timedId).status === "error", 2_000);
  assert.match(timed.status(timedId).error ?? "", /TURN_TIMEOUT/);
  await timed.shutdown();

  const cancelled = new LaneManager({
    resolveSpec: () => fakeSpec({ CLANKER_TEST_IGNORE_SIGTERM: "1" }), disableReaper: true,
    baseRepo: os.tmpdir(), cancelGraceMs: 30, processTerminateGraceMs: 30,
  });
  const { id } = await cancelled.dispatchStart({ lane: "codex", prompt: "STALL_ACTIVITY", cwd: os.tmpdir(), readOnly: true });
  await until(() => cancelled.status(id).tool_calls > 0, 2_000);
  assert.equal((await cancelled.cancel(id)).status, "cancelled");
  assert.equal(cancelled.status(id).telemetry?.forced_kill, true);
  await cancelled.shutdown();
});
