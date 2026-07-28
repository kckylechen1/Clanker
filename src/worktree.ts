/**
 * Worktree lifecycle (spec §8) — the server owns creation, change detection,
 * and cleanup so worktrees no longer scatter across lane-run / companion / hand
 * git. A worktree is cut from the repository its dispatch *targets* (resolved
 * from the dispatch cwd — see manager.ts / issue #12), never from an unrelated
 * host checkout, and its base ref is resolved per target repo (origin/HEAD →
 * origin/main → origin/master → the repo's local HEAD) rather than a hardcoded
 * origin/main, so a repo with a different default branch or no remote at all can
 * still be worktree'd.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BASE_REPO, WORKTREES_ROOT } from "./constants.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export function deriveWorktreePath(branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]/g, "-");
  return path.join(WORKTREES_ROOT, safe);
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Resolve the toplevel of the git work tree that `cwd` belongs to. A worktree
 * must be cut from the repo the dispatch actually targets — not the host repo
 * the MCP server was launched from (issue #12: cutting from the host silently
 * polluted an unrelated primary checkout). Throws LOUDLY when `cwd` is not
 * inside a git work tree instead of falling back to the host repo, so a
 * misrouted write dispatch fails fast rather than landing in the wrong checkout.
 */
export async function resolveTargetRepo(cwd: string): Promise<string> {
  try {
    const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (top) return top;
  } catch {
    /* fall through to the loud error */
  }
  throw new Error(
    `cwd '${cwd}' is not inside a git work tree; a write dispatch cannot be isolated ` +
      `into a worktree cut from a non-repo directory (refusing to silently fall back to ` +
      `the host checkout — see issue #12)`,
  );
}

/**
 * Resolve the base ref a worktree for `targetRepo` should be cut from. Order:
 *   1. origin/HEAD  — the remote's default branch, whatever it is named
 *   2. origin/main  — preserves Clanker's own historical cut point
 *   3. origin/master
 *   4. the repo's current local HEAD commit — for repos with no remote at all
 *      (e.g. DispatchLedger), which previously could not be worktree'd because
 *      the base ref was hardcoded to origin/main.
 * Only throws when the repo has zero commits (nothing to cut from).
 */
export async function resolveBaseRef(targetRepo: string): Promise<string> {
  try {
    const head = (
      await git(targetRepo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    ).trim();
    if (head) return head;
  } catch {
    /* no origin/HEAD; fall through to explicit branch refs */
  }
  for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    try {
      await git(targetRepo, ["rev-parse", "--verify", "--quiet", ref]);
      return ref.replace("refs/remotes/", "");
    } catch {
      /* ref absent; keep looking */
    }
  }
  try {
    const head = (await git(targetRepo, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim();
    if (head) return head;
  } catch {
    /* no commits at all */
  }
  throw new Error(
    `target repo '${targetRepo}' has no origin/HEAD, origin/main, origin/master, or local ` +
      `HEAD commit to cut a worktree from (a repo with zero commits cannot be worktree'd)`,
  );
}

/**
 * Create a worktree for `branch`, cut from `targetRepo`'s resolved base ref
 * (see resolveBaseRef). `targetRepo` is the repo the dispatch targets; it
 * defaults to the host BASE_REPO only for callers with no dispatch cwd.
 *
 * @returns the absolute worktree path.
 */
export async function createWorktree(branch: string, targetRepo = BASE_REPO): Promise<string> {
  const wtPath = deriveWorktreePath(branch);
  if (fs.existsSync(wtPath)) {
    throw new Error(`worktree path already exists: ${wtPath} (choose a different branch name)`);
  }
  const baseRef = await resolveBaseRef(targetRepo);
  fs.mkdirSync(WORKTREES_ROOT, { recursive: true });
  await git(targetRepo, ["worktree", "add", wtPath, "-b", branch, baseRef]);
  return wtPath;
}

/** Porcelain-parsed list of changed paths in `cwd` (tracked + untracked). */
export async function changedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["status", "--porcelain"]);
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // Format: "XY <path>" or "XY <old> -> <new>" for renames.
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    files.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
  }
  return files;
}

/**
 * Does this worktree hold commits that exist nowhere but here?
 *
 * Fallback judge for branches with no upstream (#17). `true` also on any error:
 * if we cannot prove the tree holds nothing, we must not remove it — a leaked
 * worktree costs disk, a wrongly removed one costs a deliverable (2026-07-10).
 */
async function holdsUnmergedWork(worktreePath: string, targetRepo: string): Promise<boolean> {
  try {
    const baseRef = await resolveBaseRef(targetRepo);
    const ahead = (await git(worktreePath, ["rev-list", "--count", `${baseRef}..HEAD`])).trim();
    return ahead !== "0";
  } catch {
    return true;
  }
}

/**
 * Resolve symlinks in a path that may not exist yet: realpath the deepest
 * ancestor that DOES exist, then re-append the not-yet-created tail. A bare
 * `path.resolve` leaves symlinks unresolved, so a WORKTREES_ROOT that is a
 * symlink pointing inside the target repo would pass a literal-string overlap
 * check while git still lands the worktree inside the checkout (#12 hardening).
 */
export function realpathBestEffort(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // reached the root; nothing resolved
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Enforce the target-aware isolation invariant (#12): the worktree a write
 * dispatch runs in must be a distinct path from the target repo's primary
 * checkout — never equal to it, inside it, or containing it. Under normal
 * config (WORKTREES_ROOT under ~/.cache) this always holds; the guard exists to
 * reject a misconfiguration that would route writes back onto the checkout the
 * isolation is meant to protect. Both sides are realpath-resolved first so a
 * symlinked WORKTREES_ROOT cannot slip a worktree inside the repo undetected.
 * Exported for a direct unit test.
 */
export function assertWorktreeOutsideRepo(worktreePath: string, targetRepo: string): void {
  const wt = realpathBestEffort(worktreePath);
  const repo = realpathBestEffort(targetRepo);
  if (wt === repo || wt.startsWith(repo + path.sep) || repo.startsWith(wt + path.sep)) {
    throw new Error(
      `isolated worktree '${wt}' overlaps the target repo's primary checkout '${repo}'; ` +
        `refusing to run a write dispatch on a non-isolated path (set CLANKER_WORKTREES_ROOT ` +
        `outside the repo)`,
    );
  }
}

/**
 * Remove a worktree if it has no changes. Returns true if removed, false if it
 * was retained because of local changes.
 */
export async function removeIfClean(worktreePath: string, targetRepo = BASE_REPO): Promise<boolean> {
  const changes = await changedFiles(worktreePath);
  if (changes.length > 0) return false;
  // A clean tree can still hold UNPUSHED commits (the lane committed its
  // work but nothing has shipped it yet). Removing the tree then is how a
  // finished lane's deliverable vanished mid-review on 2026-07-10 — the
  // branch ref survived, but every path-based consumer (review dispatches,
  // verify seats) broke. Retain the tree until its commits are on its upstream.
  // Compared against @{upstream} (whatever the worktree branch tracks), not a
  // hardcoded origin/main, so a repo cut from origin/master — or a no-remote
  // repo with no upstream at all (the catch below retains it) — is judged
  // against the ref it was actually cut from (#12).
  try {
    const ahead = (
      await git(worktreePath, ["rev-list", "--count", "@{upstream}..HEAD"])
    ).trim();
    if (ahead !== "0") return false;
  } catch {
    // NO UPSTREAM IS THE NORMAL STATE, NOT AN EXCEPTION (#17).
    //
    // A worktree branch created by `createWorktree` tracks nothing, and a repo
    // with no remote can never give it an upstream. Retaining unconditionally
    // here made the guard unsatisfiable for those repos, so `removeIfClean`
    // silently degraded into `neverRemove` and every worktree it was asked to
    // reclaim became immortal. A cleanup path that can only ever answer "kept"
    // is worse than no cleanup path: callers read the `false` as "the lane left
    // work behind", which was never true.
    //
    // Ask the question the upstream probe was really asking — does this tree
    // hold commits that exist nowhere else? — against the ref the tree was CUT
    // from, resolved exactly as `createWorktree` resolved it. That works with
    // no remote at all, and it stays correct when the base has since advanced:
    // a branch whose commits are already merged into it counts zero.
    if (await holdsUnmergedWork(worktreePath, targetRepo)) return false;
  }
  try {
    await git(targetRepo, ["worktree", "remove", worktreePath]);
  } catch {
    await git(targetRepo, ["worktree", "remove", "--force", worktreePath]);
  }
  return true;
}
