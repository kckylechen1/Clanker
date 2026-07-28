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
 * Verify a caller-supplied `base` against `targetRepo` and return the full
 * commit SHA it resolves to. This is the server-side half of the `base`
 * dispatch parameter: the dispatcher may NAME the commit a worktree is cut
 * from, but whether that name means anything is decided here, not by the
 * worker. A base that does not resolve to a commit is a loud rejection that
 * quotes the caller's original string verbatim — never a silent fallback to
 * the repo's default base, which would let a typo'd ref quietly produce a
 * worktree cut from somewhere the dispatcher did not ask for.
 */
export async function resolveBaseCommit(targetRepo: string, base: string): Promise<string> {
  try {
    const sha = (await git(targetRepo, ["rev-parse", "--verify", `${base}^{commit}`])).trim();
    if (sha) return sha;
  } catch {
    /* fall through to the loud error */
  }
  throw new Error(
    `dispatch base '${base}' does not resolve to a commit in target repo '${targetRepo}'; ` +
      `refusing to fall back to the repo's default base (the worktree would be cut from a ` +
      `commit the dispatcher did not name)`,
  );
}

/** Full SHA of `cwd`'s current HEAD commit (the cut point of a fresh worktree). */
export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
}

/**
 * Create a worktree for `branch`, cut from `targetRepo`'s resolved base ref
 * (see resolveBaseRef). `targetRepo` is the repo the dispatch targets; it
 * defaults to the host BASE_REPO only for callers with no dispatch cwd.
 *
 * When `base` is given it wins: the worktree is cut from exactly that ref
 * (already verified server-side via resolveBaseCommit before this call). When
 * omitted, the resolveBaseRef chain runs EXACTLY as before (frozen, #12).
 *
 * @returns the absolute worktree path.
 */
export async function createWorktree(branch: string, targetRepo = BASE_REPO, base?: string): Promise<string> {
  const wtPath = deriveWorktreePath(branch);
  if (fs.existsSync(wtPath)) {
    throw new Error(`worktree path already exists: ${wtPath} (choose a different branch name)`);
  }
  const baseRef = base ?? (await resolveBaseRef(targetRepo));
  fs.mkdirSync(WORKTREES_ROOT, { recursive: true });
  await git(targetRepo, ["worktree", "add", wtPath, "-b", branch, baseRef]);
  return wtPath;
}

/**
 * Parse the byte-exact output of `git status --porcelain=v1 -z` into a flat
 * list of touched paths.
 *
 * This replaces a naive `indexOf(" -> ")` split on `--porcelain` (no `-z`)
 * text, which was wrong for two independent reasons: (1) `--porcelain` text
 * mode quotes/escapes paths with unusual characters (quotes, control bytes)
 * per `core.quotePath`, which a raw split never undoes; and (2) an ORDINARY
 * (non-rename) path whose name literally contains the substring `" -> "`
 * (e.g. `src/a -> b.ts`) is indistinguishable, under string splitting, from a
 * real rename record — silently corrupting doNotTouch matching for that file.
 * `-z` sidesteps both: it NUL-delimits records and never quotes or escapes a
 * path, so `" -> "` inside a filename can never be confused with the
 * delimiter this function actually parses on (NUL).
 *
 * A `-z` record is `XY<SP><path>\0` for anything ordinary. For a RENAME
 * record (`R` in either status column) or a COPY record (`C` in either status
 * column) it is followed by one EXTRA NUL-terminated field holding the
 * *source* path — verified experimentally against git 2.50: `git mv
 * src/keep.ts allowed/keep.ts` emits the bytes
 * `R  allowed/keep.ts\0src/keep.ts\0` — destination FIRST, source SECOND
 * (the reverse of the "old -> new" reading order `--porcelain` text uses).
 *
 * Semantics returned to the caller (this is where rename and copy diverge):
 *   - RENAME: both paths are reported. The source was touched exactly as
 *     much as the destination — "removing a file out of a doNotTouch
 *     directory via `git mv`" IS touching that directory (see
 *     changedFilesSince below).
 *   - COPY: only the destination is reported. The source file was never
 *     modified or removed by a copy; reporting it as touched would be a
 *     false positive doNotTouch violation on a file nobody changed.
 * Copy detection is config/similarity-dependent and does not reliably fire
 * through `git status` in a portable way, so it is exercised by feeding this
 * pure function a hand-built `-z` byte string directly rather than by trying
 * to coax real `git status` into emitting a `C` record (see the unit test).
 */
export function parsePorcelainZ(out: string): string[] {
  const entries = out.split("\0");
  // `-z` NUL-TERMINATES every record, so splitting on NUL leaves one trailing
  // empty string that is not a record at all.
  if (entries.length > 0 && entries[entries.length - 1] === "") entries.pop();
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 3) continue; // defensive: too short to hold "XY path"
    const status = entry.slice(0, 2);
    const destPath = entry.slice(3);
    const isRename = status[0] === "R" || status[1] === "R";
    const isCopy = status[0] === "C" || status[1] === "C";
    if (isRename || isCopy) {
      const srcPath = entries[++i]; // the extra NUL field: rename/copy source
      files.push(destPath);
      if (isRename && srcPath !== undefined) files.push(srcPath);
      // copy: source is untouched — deliberately NOT pushed.
    } else {
      files.push(destPath);
    }
  }
  return files;
}

/** Porcelain-parsed list of changed paths in `cwd` (tracked + untracked). See `parsePorcelainZ`. */
export async function changedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["status", "--porcelain=v1", "-z"]);
  return parsePorcelainZ(out);
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
 * Every path a worktree run touched relative to the commit it was cut from:
 * committed changes (`git diff --name-only <base> HEAD`) UNION uncommitted
 * ones (`git status --porcelain`). The porcelain half is load-bearing, not
 * defensive: a worker that edits a forbidden file and never commits is the
 * same contract breach as one that commits it, and a diff-only check would
 * call the first one clean.
 *
 * TWO-dot diff (`<base> HEAD`), not three-dot (`<base>...HEAD`): three-dot
 * diffs the merge-base of the two, which requires `base` and `HEAD` to share
 * ancestry. `base` is the frozen SHA the worktree was cut from — normally an
 * ancestor of HEAD, where two-dot and three-dot agree — but a worker that
 * rewrites its branch onto an unrelated/orphan HEAD has no merge-base with
 * that SHA at all, and three-dot then fails outright, leaving the terminal
 * validation silently unable to see anything (the exact failure this
 * function's caller must not treat as "nothing touched" — see the catch in
 * `computeContractViolations`, manager.ts). Two-dot performs a direct tree
 * comparison and needs no common ancestor, so it still finds real violations
 * on a HEAD that three-dot could not even diff against.
 */
export async function changedFilesSince(worktreePath: string, base: string): Promise<string[]> {
  const out = await git(worktreePath, ["diff", "--name-only", base, "HEAD"]);
  const committed = out.split("\n").filter((line) => line.trim().length > 0);
  const uncommitted = await changedFiles(worktreePath);
  return [...new Set([...committed, ...uncommitted])];
}

/**
 * Match touched paths against `doNotTouch` patterns. A pattern matches a file
 * when the file equals it, or when the file sits under it as a directory
 * prefix — so "src/" and "src" both match "src/foo.ts", and "src" does NOT
 * match "src2/foo.ts" (the prefix boundary is a path separator, not a string
 * prefix, or one directory's contract would swallow its sibling).
 */
export function matchDoNotTouch(
  patterns: readonly string[],
  files: readonly string[],
): { pattern: string; files: string[] }[] {
  const violations: { pattern: string; files: string[] }[] = [];
  for (const pattern of patterns) {
    const dir = pattern.replace(/\/+$/, "");
    if (!dir) continue;
    const matched = files.filter((file) => file === dir || file.startsWith(dir + "/"));
    if (matched.length > 0) violations.push({ pattern, files: matched });
  }
  return violations;
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
