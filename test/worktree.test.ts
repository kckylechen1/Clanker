import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedFiles, createWorktree, isGitWorkTree, removeIfClean } from "../src/worktree.js";

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

test("worktree lifecycle: create from origin/main, detect changes, remove when clean", async () => {
  const base = makeBaseRepo();
  const branch = `lane-test-${Math.random().toString(36).slice(2, 8)}`;

  const wtPath = await createWorktree(branch, base);
  assert.ok(fs.existsSync(wtPath), "worktree dir created");
  assert.equal(await isGitWorkTree(wtPath), true);
  assert.deepEqual(await changedFiles(wtPath), [], "fresh worktree is clean");

  // Dirty it: removeIfClean must refuse and report retention.
  fs.writeFileSync(path.join(wtPath, "new-file.txt"), "work\n");
  const changed = await changedFiles(wtPath);
  assert.ok(changed.includes("new-file.txt"), `expected new-file.txt in ${JSON.stringify(changed)}`);
  assert.equal(await removeIfClean(wtPath, base), false, "dirty worktree is retained");
  assert.ok(fs.existsSync(wtPath), "retained worktree still exists");

  // Clean it: removeIfClean now succeeds.
  fs.rmSync(path.join(wtPath, "new-file.txt"));
  assert.equal(await removeIfClean(wtPath, base), true, "clean worktree removed");
  assert.equal(fs.existsSync(wtPath), false, "removed worktree gone");
});
