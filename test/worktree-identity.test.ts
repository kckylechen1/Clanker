/**
 * Worktree IDENTITY: which commit a tree is cut from (#33) and who is allowed
 * to delete it (#3).
 *
 * Both issues are about a worktree's identity being derived from something
 * that can drift out from under it — a remote ref for the cut point, a branch
 * NAME for the path — instead of from the dispatch that owns it. Every case
 * here runs against the real functions (worktree.ts) or the real dispatch path
 * (LaneManager + fake ACP agent), and every load-bearing one is re-run against
 * a deliberately broken build (`loadMutantModule`) so a test that would stay
 * green without the fix fails loudly here instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { createWorktree, removeIfClean } from "../src/worktree.js";
import { fakeResolver, loadMutantModule, dropMutant, until } from "./helpers.js";

type WorktreeModule = typeof import("../src/worktree.js");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: GIT_ENV }).toString().trim();
}

/**
 * A repo whose local HEAD is deliberately NOT its remote default branch: a
 * clone of an origin/main, then a feature branch with one extra commit on top.
 * This is the shape #33 was reported from — the dispatcher sits on a feature
 * branch while origin/HEAD still names main.
 */
function makeFeatureBranchRepo(): { root: string; base: string; mainSha: string; featureSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-wt-identity-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  gitIn(root, ["init", "--bare", "-b", "main", origin]);
  gitIn(root, ["clone", origin, seed]);
  fs.mkdirSync(path.join(seed, "src"), { recursive: true });
  fs.writeFileSync(path.join(seed, "src", "keep.ts"), "on main\n");
  gitIn(seed, ["add", "."]);
  gitIn(seed, ["commit", "-m", "main tip"]);
  gitIn(seed, ["push", "origin", "main"]);
  gitIn(root, ["clone", origin, base]);
  const mainSha = gitIn(base, ["rev-parse", "HEAD"]);
  gitIn(base, ["checkout", "-b", "feature/the-work"]);
  fs.writeFileSync(path.join(base, "src", "only-on-feature.ts"), "the code the dispatch is about\n");
  gitIn(base, ["add", "."]);
  gitIn(base, ["commit", "-m", "feature work"]);
  const featureSha = gitIn(base, ["rev-parse", "HEAD"]);
  assert.notEqual(featureSha, mainSha, "fixture: the feature branch really is ahead of origin/main");
  return { root, base, mainSha, featureSha };
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

const uniq = (tag: string) => `clanker/wt-id-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---- #33 A1: the default cut point follows the dispatch cwd ----------------

test("#33 A1: a write dispatch from a feature branch is cut from the dispatch cwd's HEAD, not origin/HEAD", async () => {
  // The reported failure, end to end: a dispatcher on a feature branch got a
  // worktree cut from origin/master, so the isolated worker could not see the
  // code the dispatch was about. Two live dispatches burned on this.
  const repo = makeFeatureBranchRepo();
  const m = makeManager(repo.base);
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "CANCELME",
      readOnly: false,
      worktree: uniq("a1"),
      cwd: repo.base,
    });
    await until(() => m.status(id).tool_calls > 0, 4_000);
    const wt = m.status(id).worktree;
    assert.ok(wt, "a write dispatch runs in a worktree");
    assert.equal(
      gitIn(wt!, ["rev-parse", "HEAD"]),
      repo.featureSha,
      "the worktree is cut from the dispatch cwd's own HEAD",
    );
    assert.equal(
      gitIn(repo.base, ["rev-parse", "origin/main"]),
      repo.mainSha,
      "fixture: origin/main — the OLD cut point — is still a different commit",
    );
    assert.ok(
      fs.existsSync(path.join(wt!, "src", "only-on-feature.ts")),
      "the file that exists only on the dispatcher's branch is present in the worker's tree",
    );
    await m.cancel(id);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#33 A1 mutation: restoring the origin-first order cuts from the wrong commit", async () => {
  // Teeth for the test above: with the candidate order flipped back, the same
  // repo yields a tree at origin/main's tip.
  const repo = makeFeatureBranchRepo();
  const name = "wt-a1-remote-first";
  const mutated = await loadMutantModule<WorktreeModule>(
    name,
    [
      {
        file: "worktree.ts",
        find: "  const head = await localHeadRef(targetRepo);\n  if (head) return head;",
        replace: "  const remoteFirst = await remoteDefaultRef(targetRepo);\n  if (remoteFirst) return remoteFirst;",
      },
    ],
    "worktree.ts",
  );
  const wt = await mutated.createWorktree(uniq("a1-mutant"), repo.base);
  try {
    assert.equal(
      gitIn(wt, ["rev-parse", "HEAD"]),
      repo.mainSha,
      "the mutant cuts from origin/HEAD — so the assertion above really observes the candidate order",
    );
  } finally {
    gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    dropMutant(name);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- #33 A2: cleanup consumes the recorded cut point ------------------------

test("#33 A2: cleanup judges against the SHA recorded at creation, not a base that has drifted since", async () => {
  // Creating and reclaiming a tree used to resolve the base ref INDEPENDENTLY,
  // asking a moving target the same question at two different moments. With A1
  // the moving target is the dispatcher's own HEAD, which moves constantly, so
  // this went from a low-probability drift to the normal case.
  const repo = makeFeatureBranchRepo();
  const branch = uniq("a2");
  const wt = await createWorktree(branch, repo.base);
  try {
    const cutSha = gitIn(wt, ["rev-parse", "HEAD"]);
    assert.equal(cutSha, repo.featureSha, "the tree was cut from the dispatcher's HEAD");

    // Drift, both flavours: the dispatcher moves its own checkout back to main
    // (the live one after A1), and origin/HEAD is repointed at a ref that does
    // not resolve (the pre-A1 flavour, now inert because a local HEAD exists).
    gitIn(repo.base, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/nope"]);
    gitIn(repo.base, ["checkout", "--detach", repo.mainSha]);

    assert.equal(
      await removeIfClean(wt, repo.base),
      false,
      "re-resolving the base now counts the tree 1 ahead of a commit it was never cut from — retained",
    );
    assert.ok(fs.existsSync(wt), "the wrongly-judged tree is still on disk");

    assert.equal(
      await removeIfClean(wt, repo.base, cutSha),
      true,
      "against the RECORDED cut point the tree holds nothing of its own and is reclaimed",
    );
    assert.equal(fs.existsSync(wt), false, "the reclaimed tree is gone");
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#33 A2: a tree that really does hold its own commit is still retained against the recorded SHA", async () => {
  // The half that must not regress (2026-07-10): the recorded SHA must not
  // turn the unmerged-work guard into a rubber stamp.
  const repo = makeFeatureBranchRepo();
  const wt = await createWorktree(uniq("a2-holds"), repo.base);
  try {
    const cutSha = gitIn(wt, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(wt, "deliverable.txt"), "the lane's work\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-m", "lane work"]);
    assert.equal(
      await removeIfClean(wt, repo.base, cutSha),
      false,
      "a commit that exists nowhere else must retain the tree",
    );
    assert.ok(fs.existsSync(path.join(wt, "deliverable.txt")));
  } finally {
    gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#33 A2 mutation: dropping the recorded SHA re-resolves the drifted base and loses the tree to retention", async () => {
  const repo = makeFeatureBranchRepo();
  const name = "wt-a2-ignores-recorded-base";
  const mutated = await loadMutantModule<WorktreeModule>(
    name,
    [
      {
        file: "worktree.ts",
        find: "    if (await holdsUnmergedWork(worktreePath, targetRepo, baseSha)) return false;",
        replace: "    if (await holdsUnmergedWork(worktreePath, targetRepo, undefined)) return false;",
      },
    ],
    "worktree.ts",
  );
  const wt = await mutated.createWorktree(uniq("a2-mutant"), repo.base);
  try {
    const cutSha = gitIn(wt, ["rev-parse", "HEAD"]);
    gitIn(repo.base, ["checkout", "--detach", repo.mainSha]);
    assert.equal(
      await mutated.removeIfClean(wt, repo.base, cutSha),
      false,
      "the mutant ignores the recorded SHA and misjudges the drifted base — so the assertion above has teeth",
    );
  } finally {
    gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    dropMutant(name);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});
