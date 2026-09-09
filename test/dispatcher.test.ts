import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LaneManager } from "../src/manager.js";
import { buildSpawnSpec } from "../src/backends.js";
import { profilesForHost } from "../src/tools.js";
import { fakeSpec, until } from "./helpers.js";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-dispatcher-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"]);
  return root;
}

test("Codex dispatcher can write with GLM and follow up once without a Sonnet seat", async () => {
  const root = repo();
  const m = new LaneManager({ host: "codex", codexDirect: true, baseRepo: root, disableReaper: true, resolveSpec: () => fakeSpec() });
  try {
    const { id } = await m.dispatchProfile({ profile: "oc-managed-write", cwd: root, base: "HEAD",
      worktree: `dispatcher-${Date.now()}`, model: "glm", prompt: "WRITEFILE evidence.txt" });
    await until(() => m.status(id).status !== "running");
    const first = await m.wait(id, 0);
    assert.equal(first.status, "done");
    assert.equal(first.continuation?.can_prompt, true);
    assert.ok(first.continuation?.expires_at);
    const wt = m.status(id).worktree!;
    assert.notEqual(wt, root);
    assert.equal(fs.existsSync(path.join(root, "evidence.txt")), false);
    assert.equal(fs.existsSync(path.join(wt, "evidence.txt")), true);
    await m.promptExisting(id, "WRITEFILE corrected.txt", false);
    await until(() => m.status(id).status !== "running");
    assert.equal(fs.existsSync(path.join(wt, "corrected.txt")), true);
    const last = await m.wait(id, 0);
    assert.equal(last.continuation?.can_prompt, false);
    assert.equal(last.continuation?.reason, "follow_up_limit");
    assert.equal(last.result_path, first.result_path);
    assert.match(fs.readFileSync(last.result_path!, "utf8"), /corrected.txt/);
    await assert.rejects(m.promptExisting(id, "third turn", false), /follow-up limit/);
    assert.equal(m.status(id).telemetry?.turns, 2);
  } finally { await m.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("managed profile refuses expiry even before the reaper runs", async () => {
  const root = repo();
  const m = new LaneManager({ host: "codex", codexDirect: true, baseRepo: root, sessionTtlMs: 20, disableReaper: true, resolveSpec: () => fakeSpec() });
  try {
    const { id } = await m.dispatchProfile({ profile: "oc-managed-review", cwd: root, model: "dgx-a/local-model", prompt: "first" });
    await until(() => m.status(id).status !== "running");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await m.wait(id, 0)).continuation?.reason, "expired");
    await assert.rejects(m.promptExisting(id, "late"), /expired/);
  } finally { await m.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("running and cancelled workers cannot be corrected", async () => {
  const root = repo();
  const m = new LaneManager({ host: "codex", codexDirect: true, baseRepo: root, disableReaper: true, resolveSpec: () => fakeSpec() });
  try {
    const { id } = await m.dispatchProfile({ profile: "oc-managed-review", cwd: root, model: "kimi", prompt: "CANCELME" });
    await assert.rejects(m.promptExisting(id, "overlap"), /already running/);
    await m.cancel(id);
    assert.equal((await m.wait(id, 0)).continuation?.can_prompt, false);
    await assert.rejects(m.promptExisting(id, "revive"), /closed|gone/);
  } finally { await m.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("dispatcher capabilities cannot be forged and Claude keeps its own policy", async () => {
  const root = repo();
  let resolutions = 0;
  const m = new LaneManager({ host: "codex", codexDirect: true, baseRepo: root, disableReaper: true,
    resolveSpec: () => { resolutions++; return fakeSpec(); } });
  const claude = new LaneManager({ host: "claude", baseRepo: root, disableReaper: true });
  try {
    await assert.rejects(m.dispatchStart({ lane: "opencode", model: "glm", prompt: "forge",
      readOnly: false, worktree: "forge", supervision: "dispatcher", continuationLimit: 1 } as any), /direct GLM write is prohibited/);
    await assert.rejects(m.dispatchProfile({ profile: "oc-managed-write", model: "kimi", prompt: "no isolation" }), /requires a managed worktree/);
    await assert.rejects(claude.dispatchProfile({ profile: "oc-managed-write", model: "glm", prompt: "wrong host", worktree: "wrong-host" }), /unknown profile/);
    assert.equal(resolutions, 0);
    assert.ok(profilesForHost(m).some(p => p.id === "oc-managed-write"));
    assert.equal(profilesForHost(claude).some(p => p.supervision === "dispatcher"), false);
    assert.ok(profilesForHost(claude).some(p => p.id === "oc-glm-write"));
  } finally { await m.shutdown(); await claude.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("custom DGX provider IDs survive the real OpenCode spawn recipe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-dgx-config-"));
  try {
    for (const model of ["dgx-a/local-model", "dgx-b/other-model"]) {
      const spec = buildSpawnSpec("opencode", { model, readOnly: true }, root);
      assert.equal(spec.command, "opencode");
      assert.deepEqual(spec.args, ["acp"]);
      const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!);
      assert.equal(config.model, model);
      assert.equal(config.default_agent, "clanker-worker");
    }
    assert.throws(() => buildSpawnSpec("opencode", { model: "local-model", readOnly: true }, root), /names no provider/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
