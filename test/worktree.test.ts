import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedFiles, createWorktree, isGitWorkTree, removeIfClean, resolveTargetRepo } from "../src/worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).toString().trim();
}

/** Build a base repo that has an origin/main remote-tracking ref. */
function makeBaseRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-wt-"));
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

/** Build a repo with a commit but NO remote (base ref must fall back to HEAD). */
function makeNoRemoteRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-wt-noremote-"));
  git(repo, ["init", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "README.md"), "local-only\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

/** A run id shaped like the manager's (`<lane>-<counter><hex>`), unique per call. */
const runId = (tag: string) => `codex-${tag}${Math.random().toString(36).slice(2, 8)}`;

test("worktree lifecycle: create from origin/main, detect changes, remove when clean", async () => {
  const base = makeBaseRepo();
  const branch = `lane-test-${Math.random().toString(36).slice(2, 8)}`;
  const run = runId("lifecycle");

  const wtPath = await createWorktree(branch, run, base);
  assert.ok(fs.existsSync(wtPath), "worktree dir created");
  assert.equal(await isGitWorkTree(wtPath), true);
  // Clean despite the `.clanker-owner` marker sitting in it (#3): the marker is
  // the server's governance, not the worker's change, and a tree that reads
  // dirty because of it could never be reclaimed.
  assert.deepEqual(await changedFiles(wtPath), [], "fresh worktree is clean");

  // Dirty it: removeIfClean must refuse and report retention.
  fs.writeFileSync(path.join(wtPath, "new-file.txt"), "work\n");
  const changed = await changedFiles(wtPath);
  assert.ok(changed.includes("new-file.txt"), `expected new-file.txt in ${JSON.stringify(changed)}`);
  const cutSha = git(wtPath, ["rev-parse", "HEAD"]);
  assert.equal(await removeIfClean(wtPath, base, cutSha, run), false, "dirty worktree is retained");
  assert.ok(fs.existsSync(wtPath), "retained worktree still exists");

  // Clean it: removeIfClean now succeeds.
  fs.rmSync(path.join(wtPath, "new-file.txt"));
  assert.equal(await removeIfClean(wtPath, base, cutSha, run), true, "clean worktree removed");
  assert.equal(fs.existsSync(wtPath), false, "removed worktree gone");
});

test("#12: createWorktree cuts a no-remote repo from local HEAD (not hardcoded origin/main)", async () => {
  // Pre-fix, the base ref was hardcoded to origin/main, so a repo with no remote
  // (e.g. DispatchLedger) could not be worktree'd at all — `git worktree add`
  // failed on the missing origin/main ref. The per-repo base-ref resolution must
  // fall back to the repo's local HEAD.
  const repo = makeNoRemoteRepo();
  const branch = `lane-noremote-${Math.random().toString(36).slice(2, 8)}`;
  const run = runId("noremote");

  const wtPath = await createWorktree(branch, run, repo);
  assert.ok(fs.existsSync(wtPath), "worktree dir created from a no-remote repo");
  assert.equal(await isGitWorkTree(wtPath), true);
  assert.deepEqual(await changedFiles(wtPath), [], "fresh no-remote worktree is clean");
  // The worktree's HEAD matches the source repo's HEAD (cut from local HEAD).
  const repoHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
  const wtHead = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
  assert.equal(wtHead, repoHead, "worktree cut from the repo's local HEAD");

  // #17: this assertion used to expect `false` — "no upstream, so retain". That
  // encoded the leak: a no-remote branch can NEVER acquire an upstream, so the
  // guard was unsatisfiable and removeIfClean degraded into neverRemove. A tree
  // holding nothing beyond its base ref must be reclaimed.
  assert.equal(
    await removeIfClean(wtPath, repo, git(wtPath, ["rev-parse", "HEAD"]), run),
    true,
    "no-remote worktree holding nothing is reclaimed",
  );
  assert.equal(fs.existsSync(wtPath), false, "reclaimed no-remote worktree is gone");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("#17: a no-remote worktree holding its own commit is still retained", async () => {
  // The other half of the fix, and the half that must not regress: the reason
  // the unconditional retain existed at all is real (2026-07-10, a finished
  // lane's deliverable vanished mid-review). Committed-but-unmerged work is
  // exactly what the base-ref comparison has to keep.
  const repo = makeNoRemoteRepo();
  const branch = `lane-noremote-commit-${Math.random().toString(36).slice(2, 8)}`;
  const run = runId("noremotecommit");
  const wtPath = await createWorktree(branch, run, repo);
  const cutShaBefore = git(wtPath, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(wtPath, "deliverable.txt"), "the lane's work\n");
  git(wtPath, ["add", "."]);
  git(wtPath, ["commit", "-m", "lane work"]);

  assert.deepEqual(await changedFiles(wtPath), [], "committed work leaves a clean tree");
  assert.equal(
    await removeIfClean(wtPath, repo, cutShaBefore, run),
    false,
    "a commit that exists nowhere else must retain the tree",
  );
  assert.ok(fs.existsSync(wtPath), "retained worktree still holds the deliverable");
  assert.ok(fs.existsSync(path.join(wtPath, "deliverable.txt")));

  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wtPath]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("#12: resolveTargetRepo returns the repo toplevel and throws loudly outside a work tree", async () => {
  const base = makeBaseRepo(); // a real git work tree
  assert.equal(
    fs.realpathSync(await resolveTargetRepo(base)),
    fs.realpathSync(base),
    "resolves cwd at the repo root to the toplevel",
  );
  // A subdirectory inside the repo still resolves to the toplevel.
  const sub = path.join(base, "sub");
  fs.mkdirSync(sub);
  assert.equal(
    fs.realpathSync(await resolveTargetRepo(sub)),
    fs.realpathSync(base),
    "resolves a subdir to the repo toplevel",
  );
  // A real directory that is not a git work tree throws loudly rather than
  // silently returning a host fallback.
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-nonrepo-"));
  await assert.rejects(() => resolveTargetRepo(nonRepo), /not inside a git work tree/);
  fs.rmSync(nonRepo, { recursive: true, force: true });
});
