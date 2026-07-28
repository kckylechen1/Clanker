/**
 * Which `node` a spawned sidecar actually runs on (#37).
 *
 * 2026-07-28 17:27: homebrew bumped node `26.5.0` to `26.5.0_1` — a REVISION
 * bump, i.e. the same version moved into a new Cellar directory and the old one
 * was deleted. Three Clanker MCP servers that had been up for hours kept
 * running fine (their inode was still open), but the path they had cached in
 * `process.execPath` — `/opt/homebrew/Cellar/node/26.5.0/bin/node` — no longer
 * existed. Every lane spawn from that moment on died with:
 *
 *     CLANKER-FAILURE: failed to spawn '/opt/homebrew/Cellar/node/26.5.0/bin/node': spawn ... ENOENT
 *
 * `process.execPath` is a correct spawn command for a short-lived process and a
 * lifetime-long assumption for a long-lived one. A brew revision bump is a
 * routine operation, not an anomaly, so the server has to survive one.
 *
 * The shape (issue #37, option 2 — explicit check + audible degradation +
 * major-version sanity check):
 *
 *   1. Resolve `process.execPath` once at startup and remember it.
 *   2. Before every spawn, check that it is still there. Normal case: use it,
 *      silently — same runtime as the server, which is the property the
 *      execPath spawn was chosen for in the first place.
 *   3. Gone: SAY SO on stderr, then fall back to bare `"node"` and let execvp
 *      resolve it through PATH. Report whether the PATH node is even the same
 *      major version, and spawn anyway — a lane on a possibly-different runtime
 *      beats a server whose every dispatch is ENOENT. Refusing loudly is a
 *      worse answer than degrading loudly, but degrading SILENTLY would be the
 *      worst of the three: an unexplained runtime swap is exactly the class of
 *      thing that gets debugged for a day.
 *
 * The complement is failure-classifier.ts's CLANKER-ENV-DRIFT: if a spawn still
 * dies with ENOENT, the dispatcher gets told that it is the environment, not
 * the task.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Bare command name — handed to execvp so PATH decides, which is the whole point of the fallback. */
export const PATH_NODE = "node";

/**
 * The binary running this server, resolved through symlinks once at load.
 *
 * NOTE on realpath (measured, not assumed): on this machine `process.execPath`
 * already comes back fully resolved (`/opt/homebrew/Cellar/node/26.5.0_1/bin/node`,
 * not the `/opt/homebrew/bin/node` symlink), so realpath is a no-op here and
 * the existsSync check below is what actually carries the fix. It is kept
 * because on setups where execPath IS a symlink (some nvm/volta layouts) a
 * stable real path is the more honest thing to record and check.
 */
const RESOLVED_NODE = resolveAtStartup();

function resolveAtStartup(): string {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    // Already gone before we even got here — hand the raw path to the same
    // existence check every spawn goes through, and let it degrade there.
    return process.execPath;
  }
}

/**
 * The spawn command for a Node sidecar: the server's own binary while it is
 * still there, otherwise `"node"` off PATH with an audible complaint.
 */
export function resolveNodeBinary(): string {
  return resolveNodeBinaryFrom(RESOLVED_NODE);
}

/**
 * The pure half of the above, taking the recorded path as an argument.
 *
 * Exported because a test cannot make the running node's own path disappear,
 * and a drift guard that has only ever been exercised on the happy path is not
 * a guard. The seam is the honest one: everything the decision depends on
 * except `process.version` is right here in the signature.
 */
export function resolveNodeBinaryFrom(recorded: string): string {
  if (fs.existsSync(recorded)) return recorded;
  console.error(
    `[clanker] node binary drift (#37): '${recorded}' no longer exists ` +
      `(homebrew revision bump, or an in-place runtime upgrade) — falling back to '${PATH_NODE}' on PATH. ` +
      driftDetail(),
  );
  return PATH_NODE;
}

/** Whether the PATH node this fallback lands on is the same major as the server's own. */
function driftDetail(): string {
  const probed = probePathNodeVersion();
  if (probed === null) {
    return (
      `Could not run '${PATH_NODE} --version' either — sidecar spawns will most likely fail with ENOENT ` +
      `(CLANKER-ENV-DRIFT). Restart the MCP server on a node that exists.`
    );
  }
  const theirs = majorOf(probed);
  const ours = majorOf(process.version);
  if (theirs !== null && theirs === ours) {
    return `PATH ${PATH_NODE} is ${probed}, same major as this server's ${process.version} — degraded but consistent.`;
  }
  return (
    `MAJOR VERSION MISMATCH: PATH ${PATH_NODE} is ${probed}, this server runs ${process.version}. ` +
    `Spawning anyway — a lane on a different major beats no lane at all — but sidecars are NO LONGER on the ` +
    `server's runtime. Restart the MCP server to get back onto one node.`
  );
}

/** `node --version` off PATH, or null when PATH has no runnable node. */
function probePathNodeVersion(): string | null {
  try {
    const out = execFileSync(PATH_NODE, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function majorOf(version: string): string | null {
  return /^v?(\d+)\./.exec(version.trim())?.[1] ?? null;
}
