/**
 * Worktree lifecycle (spec §8) — the server owns creation, change detection,
 * and cleanup so worktrees no longer scatter across lane-run / companion / hand
 * git. Worktrees are always cut from origin/main, never the primary checkout.
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
 * Create a worktree for `branch`, cut from origin/main.
 *
 * @returns the absolute worktree path.
 */
export async function createWorktree(branch: string, baseRepo = BASE_REPO): Promise<string> {
  const wtPath = deriveWorktreePath(branch);
  if (fs.existsSync(wtPath)) {
    throw new Error(`worktree path already exists: ${wtPath} (choose a different branch name)`);
  }
  fs.mkdirSync(WORKTREES_ROOT, { recursive: true });
  await git(baseRepo, ["worktree", "add", wtPath, "-b", branch, "origin/main"]);
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
 * Remove a worktree if it has no changes. Returns true if removed, false if it
 * was retained because of local changes.
 */
export async function removeIfClean(worktreePath: string, baseRepo = BASE_REPO): Promise<boolean> {
  const changes = await changedFiles(worktreePath);
  if (changes.length > 0) return false;
  // A clean tree can still hold UNPUSHED commits (the lane committed its
  // work but nothing has shipped it yet). Removing the tree then is how a
  // finished lane's deliverable vanished mid-review on 2026-07-10 — the
  // branch ref survived, but every path-based consumer (review dispatches,
  // verify seats) broke. Retain the tree until its commits are on a remote.
  try {
    const ahead = (
      await git(worktreePath, ["rev-list", "--count", "origin/main..HEAD"])
    ).trim();
    if (ahead !== "0") return false;
  } catch {
    // If we cannot prove the tree holds nothing unpushed, keep it.
    return false;
  }
  try {
    await git(baseRepo, ["worktree", "remove", worktreePath]);
  } catch {
    await git(baseRepo, ["worktree", "remove", "--force", worktreePath]);
  }
  return true;
}
