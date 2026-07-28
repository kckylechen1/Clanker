/**
 * #37 C1 — dispatch-guard ordering (issue #35's telemetry stub + the
 * "no orphan worktree on rejection" invariant).
 *
 * Before this fix, `mkdirSync(runDir)` and `createWorktree` both ran BEFORE
 * `resolveSpec` — the function that carries every lane-specific fail-closed
 * gate (opencode requires an explicit model, gemini's own rules, sandbox
 * validation). A dispatch resolveSpec rejected could already have a REAL
 * worktree on disk with nothing tracking it, and the run directory it did
 * leave behind carried no signal at all — not even that the attempt had
 * happened.
 *
 * The fix reorders to: pure validation -> mkdir(runDir) + telemetry stub ->
 * resolveSpec -> createWorktree, and on a resolveSpec/createWorktree
 * rejection, closes out the stub with `terminal_at`/`error`/
 * `terminal_reason: "rejected"` instead of leaving it an empty shell.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { deriveWorktreePath } from "../src/worktree.js";
import { fakeResolver, until } from "./helpers.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function makeBaseRepo(): { base: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-order-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["clone", origin, base]);
  return { base, root };
}

test("C1: a resolveSpec rejection (opencode, no model) leaves a closed-out telemetry stub and never creates the worktree", async () => {
  const repo = makeBaseRepo();
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-"));
  // Deliberately no `resolveSpec` override: the real backends.ts buildSpawnSpec
  // is what carries the "opencode requires an explicit model" fail-closed gate.
  const m = new LaneManager({ disableReaper: true, baseRepo: repo.base, runsRoot });
  const branch = `clanker/guard-reject-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "opencode",
          prompt: "no model supplied",
          cwd: repo.base,
          readOnly: true,
          worktree: branch,
        }),
      /opencode lane requires an explicit model id/,
    );

    const entries = fs.readdirSync(runsRoot);
    assert.equal(entries.length, 1, `expected exactly one run dir stub, found: ${JSON.stringify(entries)}`);
    const runDir = path.join(runsRoot, entries[0]);
    const telemetryPath = path.join(runDir, "telemetry.json");
    assert.ok(fs.existsSync(telemetryPath), "a rejected dispatch must still leave a readable telemetry stub");
    const stub = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.equal(stub.lane, "opencode");
    assert.ok(stub.created_at, "the stub must carry created_at from before the rejection");
    assert.ok(stub.terminal_at, "the stub must be closed out with terminal_at on rejection");
    assert.match(stub.error ?? "", /opencode lane requires an explicit model id/);
    assert.equal(stub.terminal_reason, "rejected");

    const wtPath = deriveWorktreePath(branch);
    assert.equal(
      fs.existsSync(wtPath),
      false,
      "resolveSpec's rejection must fire before createWorktree ever runs — no orphan worktree",
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("C1: a successful dispatch has a telemetry.json with created_at before the connection even starts", async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-ok-"));
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: os.tmpdir(), runsRoot });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "hello", cwd: os.tmpdir(), readOnly: true });
    const telemetryPath = path.join(runsRoot, id, "telemetry.json");
    const immediate = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.ok(immediate.created_at, "the telemetry stub must exist with created_at before spawn/connect completes");
    assert.equal(immediate.host, "standalone");
    assert.equal(immediate.lane, "codex");

    await until(() => m.status(id).status !== "running", 5_000);
    const final = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.ok(final.created_at, "run.persistTelemetry()'s overwrite must still carry a created_at field");
    assert.equal(final.lane, "codex");
  } finally {
    await m.shutdown();
  }
});
