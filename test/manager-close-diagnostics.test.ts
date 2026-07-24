import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
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

/** Build a base repo that has an origin/main remote-tracking ref (mirrors worktree.test.ts). */
function makeBaseRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-close-wt-"));
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
  return base;
}

// ---- close() must not swallow worktree cleanup failures -------------------
//
// Regression coverage for the bare `catch {}` that used to discard whatever
// error removeIfClean() threw. We force a real failure (the worktree
// directory vanishes out from under removeIfClean, so the underlying `git
// status` call errors instead of returning a clean/dirty verdict) and assert
// both halves of the fixed behavior: control flow is unchanged (still marks
// worktreeRetained, never rethrows out of close()) AND the failure reason is
// now surfaced to stderr (the only diagnostic channel a stdio MCP server has
// — stdout must stay wire-protocol-only).

test("close() surfaces worktree cleanup failures to stderr and still marks worktreeRetained", async () => {
  const base = makeBaseRepo();
  const branch = `close-diag-${Math.random().toString(36).slice(2, 8)}`;
  const m = new LaneManager({
    resolveSpec: fakeResolver,
    disableReaper: true,
    baseRepo: base,
  });

  const stderrLines: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  };

  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "STALL close-diag",
      readOnly: false,
      worktree: branch,
    });

    // Wait until the live turn is established. One-shot completion now closes
    // immediately, so the cleanup failure must be injected while the job is
    // still running.
    const deadline = Date.now() + 5000;
    let status = m.status(id);
    while (status.tool_calls === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      status = m.status(id);
    }
    assert.equal(status.status, "running", "fixture must still be in flight");
    assert.ok(status.tool_calls > 0, "fixture must establish the ACP turn");

    const worktreePath = status.worktree;
    assert.ok(worktreePath, "worktree path recorded on the run");
    assert.ok(fs.existsSync(worktreePath!), "worktree exists before we yank it");

    // Yank the worktree dir out from under removeIfClean(): `git status
    // --porcelain` run with this cwd now fails outright instead of
    // returning a clean/dirty verdict, so removeIfClean() throws.
    fs.rmSync(worktreePath!, { recursive: true, force: true });

    await m.close(id); // must not throw; closing the connection also ends the turn

    assert.ok(
      stderrLines.some((l) => l.includes(worktreePath!)),
      `expected a stderr diagnostic mentioning '${worktreePath}', got: ${JSON.stringify(stderrLines)}`,
    );
    assert.ok(
      stderrLines.some((l) => /failed|error/i.test(l)),
      `expected the stderr diagnostic to describe a failure, got: ${JSON.stringify(stderrLines)}`,
    );

    await until(() => m.status(id).status === "error", 5_000);
    const result = await m.wait(id, 100);
    assert.equal(result.status, "error", "closing the in-flight fixture terminates its turn");
    assert.equal(result.worktree_retained, worktreePath, "worktreeRetained still set despite the cleanup error");
  } finally {
    console.error = originalConsoleError;
    await m.shutdown();
  }
});

test("concurrent close calls share one subprocess and worktree teardown", async () => {
  const base = makeBaseRepo();
  const branch = `close-once-${Math.random().toString(36).slice(2, 8)}`;
  const m = new LaneManager({
    resolveSpec: fakeResolver,
    disableReaper: true,
    baseRepo: base,
  });

  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "STALL close-once",
      readOnly: false,
      worktree: branch,
    });
    await until(() => m.status(id).tool_calls > 0, 5_000);
    const worktreePath = m.status(id).worktree;
    assert.ok(worktreePath && fs.existsSync(worktreePath), "managed worktree must exist");

    await Promise.all([m.close(id), m.close(id)]);
    await until(() => m.status(id).status === "error", 5_000);

    const result = await m.wait(id, 100);
    assert.equal(result.worktree_retained, undefined, "clean worktree was removed, not falsely retained");
    assert.equal(fs.existsSync(worktreePath!), false, "worktree teardown ran exactly once");
  } finally {
    await m.shutdown();
  }
});
