/**
 * #37 A1 + A2 — the close()-before-terminal window.
 *
 * `close(id)` runs its real async teardown (closeAndWait — subprocess
 * SIGTERM/SIGKILL, worktree removal) strictly BEFORE the matching
 * completeTurn()/failTurn()/cancelTurn() flips `turnStatus` off "running"
 * (every call site in manager.ts does `await this.close(run.id); run.xTurn();`
 * in that order). For the whole span of that async close, `sessionClosed` is
 * already true while the turn is, from every other caller's point of view,
 * still genuinely running.
 *
 * A1: `list()` used to filter on `sessionClosed` alone, so a job in that
 * window vanished from the board entirely — not idle, not foreign, not
 * anything; `status`/`wait` on the same id kept saying "running".
 *
 * A2: `promptExisting` checked five things but not whether a `close(id)` was
 * already in flight (`this.closing`) or the whole server was shutting down —
 * a correction turn issued in that window could be sent down a connection a
 * SIGTERM is racing to kill, on a worktree `removeIfClean` might delete out
 * from under it.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { fakeResolver, fakeSpec, until } from "./helpers.js";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-close-window-"));
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

test("A1: list() still shows a run during the close()-before-terminal window", async () => {
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: os.tmpdir() });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "STALL a1", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).tool_calls > 0, 4_000);

    // close() disposes the session and kills the subprocess, but does NOT
    // itself touch turnStatus — only the drive loop's own completeTurn/
    // failTurn/cancelTurn does that, later and separately.
    await m.close(id);
    assert.equal(m.status(id).status, "running", "closing the session must not, by itself, flip turnStatus");

    const listed = m.list();
    assert.ok(
      listed.some((e) => e.id === id && e.owner === "this-process"),
      `expected '${id}' still listed during the close()-before-terminal window, got: ${JSON.stringify(listed)}`,
    );
  } finally {
    await m.shutdown();
  }
});

/** Start the supervised profile and drive its first turn to terminal (mirrors correction-turn.test.ts). */
async function startSupervised(m: LaneManager, tag: string): Promise<string> {
  const { id } = await m.dispatchProfile({
    profile: "oc-glm-write",
    prompt: "implement the frozen spec",
    worktree: `clanker/close-window-${tag}-${Math.random().toString(36).slice(2, 8)}`,
  });
  await until(() => m.status(id).status !== "running", 6_000);
  return id;
}

test("A2: promptExisting refuses a correction while close(id) is in flight", async () => {
  const repo = makeBaseRepo();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: repo.base });
  try {
    const id = await startSupervised(m, "closing");
    // Do NOT await: `this.closing.set(id, ...)` happens synchronously inside
    // close() before its first await, so by the time this expression
    // finishes evaluating, `this.closing.has(id)` is already true.
    const closing = m.close(id);
    await assert.rejects(() => m.promptExisting(id, "too late", true), /closing|shutting/);
    await closing;
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("A2: promptExisting refuses a correction once shutdown has begun", async () => {
  const repo = makeBaseRepo();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: repo.base });
  try {
    const id = await startSupervised(m, "shutdown");
    // shutdown() sets `this.shuttingDown = true` synchronously as its first
    // statement, before any await — same reasoning as above.
    const shuttingDown = m.shutdown();
    await assert.rejects(() => m.promptExisting(id, "too late", true), /closing|shutting/);
    await shuttingDown;
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});
