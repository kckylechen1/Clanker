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
import {
  OWNER_MARKER,
  changedFilesSince,
  createWorktree,
  deriveWorktreePath,
  readWorktreeOwner,
  removeIfClean,
} from "../src/worktree.js";
import { fakeResolver, loadMutantManager, loadMutantModule, dropMutant, until } from "./helpers.js";

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
/** A run id shaped like the manager's own (`<lane>-<counter><hex>`). */
const runId = (tag: string) => `codex-${tag}${Math.random().toString(36).slice(2, 8)}`;

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
  const wt = await mutated.createWorktree(uniq("a1-mutant"), runId("a1m"), repo.base);
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

// ---- #33 A3: a dirty dispatch cwd is said out loud -------------------------

test("#33 A3: dispatching from a dirty checkout warns that the uncommitted work is NOT in the tree — and dispatches anyway", async () => {
  const repo = makeFeatureBranchRepo();
  const m = makeManager(repo.base);
  try {
    // Control: a clean checkout must not produce the advisory, or it would be
    // noise nobody reads by the second dispatch.
    const clean = await m.dispatchStart({
      lane: "codex",
      prompt: "CANCELME",
      readOnly: false,
      worktree: uniq("a3-clean"),
      cwd: repo.base,
    });
    assert.equal(
      clean.warnings.some((w) => w.includes("uncommitted change")),
      false,
      `a clean checkout must dispatch without the advisory, got ${JSON.stringify(clean.warnings)}`,
    );
    await m.cancel(clean.id);

    fs.writeFileSync(path.join(repo.base, "src", "keep.ts"), "edited, never committed\n");
    fs.writeFileSync(path.join(repo.base, "src", "uncommitted.ts"), "brand new, never committed\n");

    const { id, warnings } = await m.dispatchStart({
      lane: "codex",
      prompt: "CANCELME",
      readOnly: false,
      worktree: uniq("a3-dirty"),
      cwd: repo.base,
    });
    const advisory = warnings.find((w) => w.includes("uncommitted change"));
    assert.ok(advisory, `expected a dirty-checkout advisory, got ${JSON.stringify(warnings)}`);
    assert.match(advisory!, /2 uncommitted change\(s\)/, "it counts the real changes (one modified, one untracked)");
    assert.ok(
      advisory!.includes(repo.featureSha.slice(0, 7)),
      `the advisory names the commit actually cut from: ${advisory}`,
    );

    // Advisory, not a gate: the dispatch really ran.
    await until(() => m.status(id).tool_calls > 0, 4_000);
    const wt = m.status(id).worktree;
    assert.ok(wt && fs.existsSync(wt), "the dispatch was not blocked — its worktree exists");
    assert.equal(
      fs.existsSync(path.join(wt!, "src", "uncommitted.ts")),
      false,
      "and the advisory is TRUE: the uncommitted file is absent from the worker's tree",
    );

    const w = await m.wait(id, 200);
    assert.ok(
      w.warnings?.some((x) => x.includes("uncommitted change")),
      "the advisory also rides the wait payload, not just the dispatch return",
    );
    await m.cancel(id);
  } finally {
    await m.shutdown();
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
  const run = runId("a2");
  const wt = await createWorktree(branch, run, repo.base);
  try {
    const cutSha = gitIn(wt, ["rev-parse", "HEAD"]);
    assert.equal(cutSha, repo.featureSha, "the tree was cut from the dispatcher's HEAD");

    // Drift, both flavours: the dispatcher moves its own checkout back to main
    // (the live one after A1), and origin/HEAD is repointed at a ref that does
    // not resolve (the pre-A1 flavour, now inert because a local HEAD exists).
    gitIn(repo.base, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/nope"]);
    gitIn(repo.base, ["checkout", "--detach", repo.mainSha]);

    assert.equal(
      await removeIfClean(wt, repo.base, undefined, run),
      false,
      "re-resolving the base now counts the tree 1 ahead of a commit it was never cut from — retained",
    );
    assert.ok(fs.existsSync(wt), "the wrongly-judged tree is still on disk");

    assert.equal(
      await removeIfClean(wt, repo.base, cutSha, run),
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
  const run = runId("a2holds");
  const wt = await createWorktree(uniq("a2-holds"), run, repo.base);
  try {
    const cutSha = gitIn(wt, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(wt, "deliverable.txt"), "the lane's work\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-m", "lane work"]);
    assert.equal(
      await removeIfClean(wt, repo.base, cutSha, run),
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
  const run = runId("a2m");
  const wt = await mutated.createWorktree(uniq("a2-mutant"), run, repo.base);
  try {
    const cutSha = gitIn(wt, ["rev-parse", "HEAD"]);
    gitIn(repo.base, ["checkout", "--detach", repo.mainSha]);
    assert.equal(
      await mutated.removeIfClean(wt, repo.base, cutSha, run),
      false,
      "the mutant ignores the recorded SHA and misjudges the drifted base — so the assertion above has teeth",
    );
  } finally {
    gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    dropMutant(name);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- #3 B1: one branch name, two runs, two paths ---------------------------

test("#3 B1: two dispatches on ONE branch name get two different paths, and the second is refused by git — not by deleting the first", async () => {
  // The kill sequence: worktree paths keyed by branch NAME alone meant a second
  // dispatch on a reused name landed on the first one's path, and the first
  // one's cleanup then deleted a live tree (three lanes, one night). Keying the
  // path on the run id makes the collision impossible; the branch name stays
  // exactly what the caller asked for, so a second live dispatch on it is
  // refused by git's own branch check — loudly, at creation, harming nothing.
  const repo = makeFeatureBranchRepo();
  const m = makeManager(repo.base);
  const branch = uniq("b1");
  try {
    assert.notEqual(
      deriveWorktreePath(branch, "codex-aaaaa1"),
      deriveWorktreePath(branch, "codex-bbbbb2"),
      "two runs on one branch name derive two different paths",
    );

    const first = await m.dispatchStart({
      lane: "codex",
      prompt: "CANCELME",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
    });
    await until(() => m.status(first.id).tool_calls > 0, 4_000);
    const liveTree = m.status(first.id).worktree;
    assert.ok(liveTree && fs.existsSync(liveTree), "the first dispatch has a live tree");
    assert.ok(
      path.basename(liveTree!).endsWith(first.id.slice(-6)),
      `the path carries the owning run id: ${path.basename(liveTree!)} vs run ${first.id}`,
    );

    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "codex",
          prompt: "CANCELME",
          readOnly: false,
          worktree: branch,
          cwd: repo.base,
        }),
      (e: Error) => {
        assert.ok(e.message.includes(branch), `the refusal names the branch: ${e.message}`);
        assert.match(e.message, /already exists/, "git's own duplicate-branch refusal, not a path collision");
        return true;
      },
    );

    assert.ok(fs.existsSync(liveTree!), "the LIVE tree is untouched by the refused second dispatch");
    assert.equal(gitIn(liveTree!, ["rev-parse", "HEAD"]), repo.featureSha, "and still holds its own checkout");
    await m.cancel(first.id);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#3 B1 mutation: dropping the run id from the path puts the second dispatch back on the first one's tree", async () => {
  const repo = makeFeatureBranchRepo();
  const name = "wt-b1-path-without-run-id";
  const { LaneManager: Mutated } = await loadMutantManager(name, [
    {
      file: "worktree.ts",
      find: "  return path.join(WORKTREES_ROOT, `${sanitize(branch)}-${sanitize(runId).slice(-6)}`);",
      replace: "  return path.join(WORKTREES_ROOT, sanitize(branch));",
    },
  ]);
  const m = new Mutated({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: repo.base });
  const branch = uniq("b1-mutant");
  try {
    const first = await m.dispatchStart({
      lane: "codex",
      prompt: "CANCELME",
      readOnly: false,
      worktree: branch,
      cwd: repo.base,
    });
    await until(() => m.status(first.id).tool_calls > 0, 4_000);
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "codex",
          prompt: "CANCELME",
          readOnly: false,
          worktree: branch,
          cwd: repo.base,
        }),
      /worktree path already exists/,
      "under the mutant the two runs really do share one path — so the test above observes the run-id suffix",
    );
    await m.cancel(first.id);
  } finally {
    await m.shutdown();
    dropMutant(name);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- #3 B2: the ownership marker ------------------------------------------

/** Run `fn` with console.error captured (the only channel a stdio MCP server has). */
async function withCapturedConsoleError<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return [result, lines.join("\n")];
  } finally {
    console.error = original;
  }
}

test("#3 B2: removeIfClean refuses — loudly — to delete a tree that belongs to another run, or to nobody", async () => {
  const repo = makeFeatureBranchRepo();
  const owner = runId("b2owner");
  const stranger = runId("b2stranger");
  const wt = await createWorktree(uniq("b2"), owner, repo.base);
  const markerPath = path.join(wt, OWNER_MARKER);
  try {
    assert.equal(readWorktreeOwner(wt), owner, "creation stamps the tree with its run");
    assert.match(
      fs.readFileSync(markerPath, "utf8"),
      new RegExp(`^${owner} \\d{4}-\\d{2}-\\d{2}T`),
      "the marker is `<runId> <ISO timestamp>`",
    );

    // The #3 sequence: a DIFFERENT run's cleanup points at this path.
    const [refused, loud] = await withCapturedConsoleError(() =>
      removeIfClean(wt, repo.base, undefined, stranger),
    );
    assert.equal(refused, false, "a stranger's cleanup must not remove this tree");
    assert.ok(fs.existsSync(wt), "the tree is still there");
    assert.match(loud, /refusing to remove worktree/, "and the refusal is not silent");
    assert.ok(loud.includes(owner) && loud.includes(stranger), `the refusal names both runs: ${loud}`);

    // A caller with no claim at all is a stranger too — this is the bypassing
    // caller the marker exists for.
    const [noClaim] = await withCapturedConsoleError(() => removeIfClean(wt, repo.base));
    assert.equal(noClaim, false, "no ownership claim means no removal");
    assert.ok(fs.existsSync(wt));

    // No readable marker: refuse even for the run that really did create it.
    // Fail-closed — an unmarked tree may be somebody's live work.
    fs.rmSync(markerPath);
    const [unmarked, unmarkedLoud] = await withCapturedConsoleError(() =>
      removeIfClean(wt, repo.base, undefined, owner),
    );
    assert.equal(unmarked, false, "a tree with no readable marker is never deleted");
    assert.match(unmarkedLoud, new RegExp(`no readable ${OWNER_MARKER} marker`));

    // The owner, with the marker in place, reclaims its own clean tree.
    fs.writeFileSync(markerPath, `${owner} ${new Date().toISOString()}\n`);
    assert.equal(await removeIfClean(wt, repo.base, undefined, owner), true, "the owner reclaims its own tree");
    assert.equal(fs.existsSync(wt), false, "and the tree is gone");
  } finally {
    if (fs.existsSync(wt)) gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#3 B2: a failed removal puts the ownership marker back rather than leaving the retained tree unowned", async () => {
  // The marker is dropped just before `git worktree remove` (leaving it there
  // would push every reclamation through the --force fallback). If the removal
  // then fails, an unowned tree is left on disk — deletable by the next
  // stranger, which is the exact hole the marker exists to close. Reaching that
  // branch needs the removal itself to fail, so it is fault-injected here.
  const repo = makeFeatureBranchRepo();
  const name = "wt-b2-removal-always-fails";
  const mutated = await loadMutantModule<WorktreeModule>(
    name,
    [
      {
        file: "worktree.ts",
        find:
          '    try {\n      await git(targetRepo, ["worktree", "remove", worktreePath]);\n' +
          '    } catch {\n      await git(targetRepo, ["worktree", "remove", "--force", worktreePath]);\n    }',
        replace:
          '    try {\n      await git(targetRepo, ["worktree", "not-a-subcommand", worktreePath]);\n' +
          '    } catch {\n      await git(targetRepo, ["worktree", "not-a-subcommand", "--force", worktreePath]);\n    }',
      },
    ],
    "worktree.ts",
  );
  const owner = runId("b2restore");
  const wt = await mutated.createWorktree(uniq("b2-restore"), owner, repo.base);
  try {
    await assert.rejects(
      () => mutated.removeIfClean(wt, repo.base, undefined, owner),
      "a removal that cannot run must throw, not report a clean reclamation",
    );
    assert.ok(fs.existsSync(wt), "the tree survived the failed removal");
    assert.equal(
      mutated.readWorktreeOwner(wt),
      owner,
      "and it is still owned — a retained tree left unowned would be deletable by the next stranger",
    );
  } finally {
    gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    dropMutant(name);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#3 B2: the ownership marker is invisible to change detection — not touched, not a violation, not 'dirty'", async () => {
  const repo = makeFeatureBranchRepo();
  const m = makeManager(repo.base);
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "WRITEFILE src/forbidden.ts",
      readOnly: false,
      worktree: uniq("b2-invisible"),
      cwd: repo.base,
      // The marker's own path is declared forbidden: if it ever reached the
      // touched set it would be reported as a breach the worker never made.
      doNotTouch: [OWNER_MARKER, "src/"],
    });
    await until(() => m.status(id).status !== "running", 6_000);
    const w = await m.wait(id, 200);
    assert.deepEqual(
      w.contract_violations,
      [{ pattern: "src/", files: ["src/forbidden.ts"] }],
      "only the worker's real write is a violation; the server's own marker is not",
    );
    assert.deepEqual(
      w.touched_files?.filter((f) => f.includes(OWNER_MARKER)),
      [],
      "and the marker never appears in touched_files",
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#3 B2: a worker that commits everything (git add -A) still does not 'touch' the marker", async () => {
  // The committed half of changedFilesSince: `git add -A` sweeps the untracked
  // marker into the worker's own commit, where a diff-based check would see it.
  const repo = makeFeatureBranchRepo();
  const run = runId("b2commit");
  const wt = await createWorktree(uniq("b2-committed"), run, repo.base);
  try {
    const cutSha = gitIn(wt, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(wt, "src", "worker-wrote-this.ts"), "work\n");
    gitIn(wt, ["add", "-A"]);
    gitIn(wt, ["commit", "-m", "worker commits everything in sight"]);
    const touched = await changedFilesSince(wt, cutSha);
    assert.deepEqual(touched, ["src/worker-wrote-this.ts"], `unexpected touched set: ${JSON.stringify(touched)}`);
  } finally {
    gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#3 B2 mutation: without the ownership check, a stranger's cleanup deletes the live tree — the original kill", async () => {
  const repo = makeFeatureBranchRepo();
  const name = "wt-b2-no-ownership-check";
  const mutated = await loadMutantModule<WorktreeModule>(
    name,
    [
      {
        file: "worktree.ts",
        find: "  if (fs.existsSync(worktreePath)) {\n    const owner = readWorktreeOwner(worktreePath);",
        replace: "  if (false) {\n    const owner = readWorktreeOwner(worktreePath);",
      },
    ],
    "worktree.ts",
  );
  const wt = await mutated.createWorktree(uniq("b2-mutant"), runId("b2m-owner"), repo.base);
  try {
    assert.equal(
      await mutated.removeIfClean(wt, repo.base, undefined, runId("b2m-stranger")),
      true,
      "the mutant lets a stranger reclaim the tree — so the refusal above is really the marker's doing",
    );
    assert.equal(fs.existsSync(wt), false, "and the live tree is gone: 2026-07-16, reproduced");
  } finally {
    if (fs.existsSync(wt)) gitIn(repo.base, ["worktree", "remove", "--force", wt]);
    dropMutant(name);
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});
