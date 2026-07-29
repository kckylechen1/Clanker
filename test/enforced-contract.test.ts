/**
 * Enforced-dispatch-contract tests (server-side `base`, `doNotTouch` terminal
 * validation, write-class discipline prefix). Each feature's cases are written
 * against the REAL dispatch path (LaneManager + fake ACP agent), never against
 * a re-implementation of the matching/verification logic, so a green run here
 * is evidence about the server, not about the test.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, type WaitResult } from "../src/manager.js";
import { changedFiles, changedFilesSince, parsePorcelainZ } from "../src/worktree.js";
import { RUNS_ROOT, WRITE_DISCIPLINE_PREFIX } from "../src/constants.js";
import { fakeResolver, until, worktreesForBranch } from "./helpers.js";

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

// 15s, not 5s (#29 pattern): these cases run real git against a worktree under
// suite-wide parallel load — an A/B on cb6e849 measured 8/12 red at 5s on a
// busy machine, base and branch alike. The budget is an upper bound, not a
// sleep; a healthy machine pays nothing.
async function waitTerminal(m: LaneManager, id: string, timeoutMs = 15_000): Promise<WaitResult> {
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
  // node:test runs test FILES concurrently and RUNS_ROOT is one shared
  // directory across the whole suite, so a plain before/after directory diff
  // can pick up an unrelated run dir some other file created in the same
  // window. Give this dispatch's bogus ref a run-unique marker and find the
  // run dir by grepping telemetry.json for it, not by set difference alone.
  const bogusRef = `refs/does/not-exist-bogus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const before = new Set(fs.existsSync(RUNS_ROOT) ? fs.readdirSync(RUNS_ROOT) : []);
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
          base: bogusRef,
        }),
      (e: Error) => {
        assert.ok(e.message.includes(`'${bogusRef}'`), "error quotes the caller's base verbatim");
        assert.match(e.message, /refusing to fall back/, "no silent fallback to the default base");
        return true;
      },
    );
    assert.deepEqual(worktreesForBranch(branch), [], "no worktree was created for a rejected base");

    // A rejected dispatch must still leave a READABLE terminal stub (#35 / C1):
    // resolveBaseCommit rejects before any worktree exists, but the run
    // directory and its telemetry.json must exist by the time the throw
    // reaches the caller, or foreign.ts's orphan scan (and every human reading
    // the runs directory) sees a gap with no record of what happened.
    const created = fs.readdirSync(RUNS_ROOT).filter((entry) => !before.has(entry));
    const match = created.find((entry) => {
      const telemetryPath = path.join(RUNS_ROOT, entry, "telemetry.json");
      return fs.existsSync(telemetryPath) && fs.readFileSync(telemetryPath, "utf8").includes(bogusRef);
    });
    assert.ok(match, `expected a new run dir whose telemetry.json names '${bogusRef}'; new dirs: ${created.join(", ")}`);
    const runDir = path.join(RUNS_ROOT, match!);
    assert.ok(fs.existsSync(runDir), "run dir exists for the rejected base dispatch");
    const telemetry = JSON.parse(fs.readFileSync(path.join(runDir, "telemetry.json"), "utf8"));
    assert.ok(telemetry.terminal_at, "telemetry.json has terminal_at for the rejected dispatch");
    assert.equal(telemetry.terminal_reason, "rejected");
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

test("doNotTouch: a SUPERVISED success reports contract_violations at the FIRST terminal state, without waiting for close()", async () => {
  // The supervised shape defers close() past the first terminal turn (see
  // manager.ts finalizeTurn) so a correction can still be issued — but the
  // supervising seat reads contract_violations off THAT first terminal
  // wait/result.md, before it ever decides whether to correct. If the
  // violation only appeared once closeRun() finally ran, a supervisor reading
  // the first terminal state would see a clean run and never know to correct.
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-supervised-${Date.now()}`;
  try {
    const { id } = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "WRITEFILE src/forbidden.ts",
      worktree: branch,
      cwd: repo.base,
      doNotTouch: ["src/"],
    });
    // #37 A1/A2-style race: `wait()` can observe `turnStatus === "done"` a tick
    // before the drive promise's own bookkeeping (`turnDrives`) clears, so a
    // `promptExisting` fired immediately off a `waitTerminal` return can still
    // see "a turn is already running". `until()` polling on `status()` (as
    // correction-turn.test.ts does) gives that bookkeeping a real macrotask to
    // settle before the correction is sent.
    await until(() => m.status(id).status !== "running", 6_000);
    const r = m.status(id);
    assert.equal(r.status, "done", "a violation never flips the run's status, supervised or not");
    const w = await m.wait(id, 200);
    assert.deepEqual(
      w.contract_violations,
      [{ pattern: "src/", files: ["src/forbidden.ts"] }],
      "the FIRST terminal wait already carries the violation",
    );
    // And the session is still open for exactly the reason supervision
    // exists: the supervisor can still send a correction turn.
    await m.promptExisting(id, "you touched src/; move it back and finish", true);
    await until(() => m.status(id).status !== "running", 6_000);
    assert.equal(m.status(id).status, "done", "the correction turn ran on a still-open session");
  } finally {
    await m.shutdown();
  }
});

test("doNotTouch: a rename OUT of a forbidden directory still reports the SOURCE path as touched", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-rename-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "CANCELME",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
      doNotTouch: ["src/"],
    });
    await until(() => m.status(id).tool_calls > 0, 4_000);
    const wt = m.status(id).worktree;
    assert.ok(wt, "worktree path present");
    fs.mkdirSync(path.join(wt!, "allowed"), { recursive: true });
    execFileSync("git", ["mv", "src/keep.ts", "allowed/keep.ts"], { cwd: wt!, stdio: "pipe" });
    const cancelled = await m.cancel(id);
    assert.equal(cancelled.status, "cancelled");
    const w = await m.wait(id, 200);
    assert.deepEqual(
      w.contract_violations,
      [{ pattern: "src/", files: ["src/keep.ts"] }],
      "the rename's SOURCE path (inside the forbidden dir) must be reported — not just the destination it landed at",
    );
  } finally {
    await m.shutdown();
  }
});

test("changedFiles: an untracked file literally named with ' -> ' is reported WHOLE, never split at the arrow", async () => {
  // A string-split parser (`indexOf(" -> ")`) cannot tell this file's name
  // apart from an actual rename record. `-z` sidesteps the ambiguity
  // entirely (no quoting/escaping, NUL-delimited), so this must survive
  // as a single, unsplit path.
  const repo = makeTwoCommitRepo();
  fs.writeFileSync(path.join(repo.base, "src", "a -> b.ts"), "x\n");
  const files = await changedFiles(repo.base);
  assert.deepEqual(files, ["src/a -> b.ts"], "the literal arrow filename must survive whole, unsplit");
});

test("changedFiles: a git-mv rename reports BOTH the destination and the source path", async () => {
  const repo = makeTwoCommitRepo();
  fs.mkdirSync(path.join(repo.base, "allowed"), { recursive: true });
  execFileSync("git", ["mv", "src/keep.ts", "allowed/keep.ts"], { cwd: repo.base, stdio: "pipe" });
  const files = await changedFiles(repo.base);
  assert.ok(files.includes("src/keep.ts"), "rename source must be reported");
  assert.ok(files.includes("allowed/keep.ts"), "rename destination must be reported");
});

test("parsePorcelainZ: a RENAME record reports both paths, a COPY record reports ONLY the destination", () => {
  // Hand-built `-z` byte stream in the exact wire shape git emits (verified
  // experimentally against git 2.50: `R  <dest>\0<src>\0`, destination
  // before source). Copy detection is config/similarity-dependent and does
  // not reliably fire through `git status` in a test fixture, so copy
  // semantics are pinned here directly at the parsing function instead.
  const record = (...fields: string[]) => fields.join("\0");
  const buf =
    record("R  allowed/keep.ts", "src/keep.ts") +
    "\0" +
    record("C  dst/copy.ts", "src/orig.ts") +
    "\0" +
    record(" M src/plain.ts") +
    "\0" +
    record("?? src/untracked.ts") +
    "\0";
  const files = parsePorcelainZ(buf);
  assert.deepEqual(
    files,
    ["allowed/keep.ts", "src/keep.ts", "dst/copy.ts", "src/plain.ts", "src/untracked.ts"],
    "rename: destination AND source; copy: destination ONLY (source was never touched); plain/untracked: unaffected",
  );
});

test("changedFilesSince: a two-dot diff still finds real violations when HEAD is rewritten onto an unrelated/orphan history", async () => {
  // Direct unit test of the worktree.ts fix: a three-dot diff against `base`
  // requires a merge-base with HEAD, which an orphan branch never has —
  // exercised end-to-end via the manager below, but pinned here at the
  // exact function whose diff mode changed.
  const repo = makeTwoCommitRepo();
  const wtPath = path.join(repo.root, "wt-orphan-unit");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  gitIn(repo.base, ["worktree", "add", wtPath, "-b", `clanker/dnt-orphan-unit-${Date.now()}`, "HEAD"]);
  const baseSha = gitIn(wtPath, ["rev-parse", "HEAD"]);
  execFileSync("git", ["checkout", "--orphan", "unrelated"], { cwd: wtPath, stdio: "pipe" });
  fs.writeFileSync(path.join(wtPath, "src", "forbidden.ts"), "orphan write\n");
  execFileSync("git", ["add", "-A"], { cwd: wtPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "orphan"], { cwd: wtPath, stdio: "pipe", env: gitEnv });
  try {
    const touched = await changedFilesSince(wtPath, baseSha);
    assert.ok(touched.includes("src/forbidden.ts"), "two-dot diff finds the forbidden path even on an unrelated HEAD");
  } finally {
    gitIn(repo.base, ["worktree", "remove", "--force", wtPath]);
  }
});

test("doNotTouch: a validation failure itself is reported, never silently swallowed into a clean run", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-validation-failed-${Date.now()}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "CANCELME",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
      doNotTouch: ["src/"],
    });
    await until(() => m.status(id).tool_calls > 0, 4_000);
    const wt = m.status(id).worktree;
    assert.ok(wt, "worktree path present");
    // Break git itself inside the worktree — "the diff could not even run",
    // distinct from "the diff ran and found nothing".
    fs.rmSync(path.join(wt!, ".git"), { force: true });
    const cancelled = await m.cancel(id);
    assert.equal(cancelled.status, "cancelled");
    const w = await m.wait(id, 200);
    assert.ok(
      w.contract_violations && w.contract_violations.length > 0,
      "a validation failure must surface, never vanish into zero violations",
    );
    assert.equal(w.contract_violations?.[0]?.pattern, "(validation-failed)");
  } finally {
    await m.shutdown();
  }
});

test("doNotTouch: a recompute against a worktree that has VANISHED replaces stale violations with (validation-failed), never carries them forward", async () => {
  // computeContractViolations() recomputes on every terminal transition
  // (finalizeTurn's success path, then again from closeRun). If the worktree
  // itself is gone by the time a later recompute runs, the earlier real
  // violation must NOT survive unexamined — the recompute did not run, so it
  // cannot vouch for either "still violating" or "now clean".
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/dnt-worktree-vanished-${Date.now()}`;
  try {
    const { id } = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "WRITEFILE src/forbidden.ts",
      worktree: branch,
      cwd: repo.base,
      doNotTouch: ["src/"],
    });
    await until(() => m.status(id).status !== "running", 6_000);
    // Confirm the FIRST terminal state carries the real violation (sanity:
    // proves the stale value we're about to blow away was genuine).
    const first = await m.wait(id, 200);
    assert.deepEqual(
      first.contract_violations,
      [{ pattern: "src/", files: ["src/forbidden.ts"] }],
      "sanity: a real violation is present before the worktree vanishes",
    );
    const wt = m.status(id).worktree;
    assert.ok(wt, "worktree path present");
    fs.rmSync(wt!, { recursive: true, force: true });
    // The supervised session is still open; close() is what the idle-TTL
    // reaper (or an explicit correction-round close) eventually does, and it
    // is the point closeRun re-invokes computeContractViolations.
    await m.close(id);
    const after = await m.wait(id, 200);
    assert.deepEqual(
      after.contract_violations,
      [{ pattern: "(validation-failed)", files: [`worktree path '${wt}' no longer exists`] }],
      "a recompute against a vanished worktree must overwrite stale violations with (validation-failed), not preserve them",
    );
  } finally {
    await m.shutdown();
  }
});

// ---- Feature 3: write-class discipline prefix -----------------------------

test("prefix: a write-class dispatch prompt starts with the discipline prefix, original text verbatim after", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/prefix-write-${Date.now()}`;
  const original = "echo-back-this-exact-text";
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      model: "kimi",
      prompt: original,
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
    });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    // The fake agent echoes the prompt it received as its final message, so
    // the terminal message is direct evidence of what the lane was handed.
    assert.equal(r.final_message, WRITE_DISCIPLINE_PREFIX + "\n\n" + original);
  } finally {
    await m.shutdown();
  }
});

test("prefix: a supervised correction turn ALSO gets the discipline prefix, not just the initial dispatch", async () => {
  // a08f7a1 put the prefix on the first turn only. A correction turn drives
  // the SAME worker under the SAME write contract, so the words it is held to
  // must be on every turn it is handed, not just turn 1.
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const branch = `clanker/prefix-correction-${Date.now()}`;
  const correctionText = "you drifted: only touch src/";
  try {
    const { id } = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "implement the frozen spec",
      worktree: branch,
      cwd: repo.base,
    });
    // See the note in the supervised doNotTouch test above: `until()` on
    // `status()`, not `waitTerminal`, avoids a real race with `turnDrives`
    // bookkeeping that a correction fired too early can still trip.
    await until(() => m.status(id).status !== "running", 6_000);
    await m.promptExisting(id, correctionText, true);
    await until(() => m.status(id).status !== "running", 6_000);
    const r = await m.wait(id, 200);
    assert.equal(r.status, "done");
    // The fake agent echoes the prompt it received as its final message, so
    // the terminal message is direct evidence of what the continuation turn
    // was actually handed.
    assert.equal(r.final_message, WRITE_DISCIPLINE_PREFIX + "\n\n" + correctionText);
  } finally {
    await m.shutdown();
  }
});

test("prefix: a read-only dispatch gets NO prefix", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const original = "plain-read-prompt";
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: original, readOnly: true, cwd: repo.base });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.final_message, original);
  } finally {
    await m.shutdown();
  }
});

test("prefix: gemini (forced read-only server-side) never gets one", async () => {
  const repo = makeTwoCommitRepo();
  const m = makeManager(repo.base);
  const original = "gemini-scout-prompt";
  try {
    const { id } = await m.dispatchStart({ lane: "gemini", prompt: original, cwd: repo.base });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.final_message, original);
  } finally {
    await m.shutdown();
  }
});
