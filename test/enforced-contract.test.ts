/**
 * Enforced-dispatch-contract tests (server-side `base`, `doNotTouch` terminal
 * validation, write-class discipline prefix). Each feature's cases are written
 * against the REAL dispatch path (LaneManager + fake ACP agent), never against
 * a re-implementation of the matching/verification logic, so a green run here
 * is evidence about the server, not about the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, type WaitResult } from "../src/manager.js";
import { deriveWorktreePath } from "../src/worktree.js";
import { fakeResolver } from "./helpers.js";

/**
 * A real (origin + clone) repo with TWO commits on main, so an explicit `base`
 * (the first commit) observably differs from the default cut point (the tip).
 */
function makeTwoCommitRepo(): { base: string; root: string; sha1: string; sha2: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-enforced-contract-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  const git = (cwd: string, args: string[]) =>
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
    })
      .toString()
      .trim();
  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, seed]);
  fs.mkdirSync(path.join(seed, "src"), { recursive: true });
  fs.writeFileSync(path.join(seed, "src", "keep.ts"), "keep\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "first"]);
  const sha1 = git(seed, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(seed, "README.md"), "second\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "second"]);
  const sha2 = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["clone", origin, base]);
  return { base, root, sha1, sha2 };
}

function makeManager(baseRepo: string): LaneManager {
  return new LaneManager({
    resolveSpec: fakeResolver,
    disableReaper: true,
    baseRepo,
    stallThresholdMs: 300_000,
    sessionTtlMs: 600_000,
    turnTimeoutMs: 2_700_000,
  });
}

async function waitTerminal(m: LaneManager, id: string, timeoutMs = 5000): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  let last!: WaitResult;
  while (Date.now() < deadline) {
    last = await m.wait(id, 200);
    if (last.status !== "running") return last;
  }
  return last;
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

// ---- Feature 1: server-side `base` ---------------------------------------

test("base: an explicit ref cuts the worktree from that commit and lands in telemetry as base_sha", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/base-explicit-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      model: "kimi",
      prompt: "cut from base",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
      base: repo.sha1,
    });
    // Inspect the tree while the run is live (a clean worktree whose branch
    // tracks its upstream is legitimately removed at close).
    const wt = m.status(id).worktree;
    assert.ok(wt, "worktree path present");
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]), repo.sha1, "worktree HEAD is the named base commit");
    assert.notEqual(repo.sha1, repo.sha2, "fixture: base differs from default tip");
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.telemetry?.base_sha, repo.sha1, "telemetry records the resolved full SHA");
  } finally {
    await m.shutdown();
  }
});

test("base: a ref that does not resolve rejects the dispatch, quotes the caller verbatim, and creates no worktree", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/base-bogus-${Date.now()}`;
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "opencode",
          model: "kimi",
          prompt: "cut from nowhere",
          readOnly: false,
          worktree: branch,
          cwd: repo.base,
          base: "refs/does/not-exist-bogus",
        }),
      (e: Error) => {
        assert.ok(e.message.includes("'refs/does/not-exist-bogus'"), "error quotes the caller's base verbatim");
        assert.match(e.message, /refusing to fall back/, "no silent fallback to the default base");
        return true;
      },
    );
    assert.equal(fs.existsSync(deriveWorktreePath(branch)), false, "no worktree was created for a rejected base");
  } finally {
    await m.shutdown();
  }
});

test("base: omitted keeps the frozen default resolution (cut from origin tip), and telemetry has no base_sha", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/base-default-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      model: "kimi",
      prompt: "cut from default",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
    });
    const wt = m.status(id).worktree;
    assert.ok(wt, "worktree path present");
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]), repo.sha2, "default cut point is the origin tip");
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.telemetry?.base_sha, undefined, "no base_sha without a caller-named base");
  } finally {
    await m.shutdown();
  }
});

test("base: supplied without a worktree is refused, not silently ignored", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "codex",
          prompt: "in place read",
          readOnly: true,
          cwd: repo.base,
          base: repo.sha1,
        }),
      /supplied without a worktree/,
    );
  } finally {
    await m.shutdown();
  }
});

// ---- Feature 2: doNotTouch terminal validation ----------------------------

test("doNotTouch: an UNCOMMITTED edit under a forbidden directory prefix is caught and reported, status untouched", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-uncommitted-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      model: "kimi",
      prompt: "WRITEFILE src/forbidden.ts",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
      doNotTouch: ["src/"],
    });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done", "a violation never flips the run's status");
    assert.deepEqual(r.contract_violations, [{ pattern: "src/", files: ["src/forbidden.ts"] }]);
    const result = fs.readFileSync(r.result_path!, "utf8");
    assert.match(result, /## contract_violations/);
    assert.ok(result.includes("src/forbidden.ts"), "result.md lists the concrete offending path");
  } finally {
    await m.shutdown();
  }
});

test("doNotTouch: a COMMITTED edit to a forbidden path is caught the same way", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-committed-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      model: "kimi",
      prompt: "COMMITFILE src/committed.ts",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
      doNotTouch: ["src"],
    });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.deepEqual(r.contract_violations, [{ pattern: "src", files: ["src/committed.ts"] }]);
  } finally {
    await m.shutdown();
  }
});

test("doNotTouch: a clean run under a declared contract reports NO violations field", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-clean-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      model: "kimi",
      prompt: "WRITEFILE allowed/note.md",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
      doNotTouch: ["src/"],
    });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.contract_violations, undefined);
    const result = fs.readFileSync(r.result_path!, "utf8");
    assert.equal(result.includes("contract_violations"), false, "no violations section in result.md");
  } finally {
    await m.shutdown();
  }
});

test("doNotTouch: omitted means zero behavior change even when files are written", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-omitted-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      model: "kimi",
      prompt: "WRITEFILE src/anything.ts",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
    });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.contract_violations, undefined);
    const result = fs.readFileSync(r.result_path!, "utf8");
    assert.equal(result.includes("contract_violations"), false);
  } finally {
    await m.shutdown();
  }
});

test("doNotTouch: matching is exact-or-directory-prefix, never a bare string prefix", async () => {
  const { matchDoNotTouch } = await import("../src/worktree.js");
  assert.deepEqual(matchDoNotTouch(["src/"], ["src/foo.ts"]), [{ pattern: "src/", files: ["src/foo.ts"] }]);
  assert.deepEqual(matchDoNotTouch(["src"], ["src/foo.ts"]), [{ pattern: "src", files: ["src/foo.ts"] }]);
  assert.deepEqual(matchDoNotTouch(["src"], ["src2/foo.ts"]), [], "'src' must not swallow the sibling 'src2'");
  assert.deepEqual(matchDoNotTouch(["a/b.ts"], ["a/b.ts"]), [{ pattern: "a/b.ts", files: ["a/b.ts"] }]);
  // Per the contract, EVERY pattern is also a directory prefix: "a/b.ts"
  // matches "a/b.ts/x" the same way "src" matches "src/foo.ts".
  assert.deepEqual(matchDoNotTouch(["a/b.ts"], ["a/b.ts/x"]), [{ pattern: "a/b.ts", files: ["a/b.ts/x"] }]);
  assert.deepEqual(matchDoNotTouch([], ["src/foo.ts"]), []);
});

test("doNotTouch: supplied without a worktree is refused, not silently unchecked", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "codex",
          prompt: "in place read",
          readOnly: true,
          cwd: repo.base,
          doNotTouch: ["src/"],
        }),
      /doNotTouch was supplied without a worktree/,
    );
  } finally {
    await m.shutdown();
  }
});
