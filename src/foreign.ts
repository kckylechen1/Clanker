/**
 * Runs that belong to another server process (#32).
 *
 * A host spawns one Clanker server per session — three concurrent Claude Code
 * sessions on one machine means three `clanker-mcp.mjs` children, each with its
 * own `LaneManager`, each holding its jobs in a plain in-memory Map. Every
 * lifecycle tool resolves through that Map, so a job started in session A is
 * invisible to session B.
 *
 * That would merely be awkward if jobs died with their session. They do not,
 * and not dying is the entire point of dispatching through Clanker: the worker
 * is an independent process, so a relay seat — or its whole session — can go
 * away while the job runs to completion and opens its PR. The consequence is
 * the exact inversion of what the registry was for:
 *
 *   **the job outlives the only record that it exists.**
 *
 * And the failure was silent. `clanker_list` answered `[]` — not "I cannot
 * see", just "nothing" — so the documented orphan-scan ("call clanker_list,
 * see whether the job is alive, then decide whether to re-dispatch") read that
 * empty list as "the job never started" and re-dispatched. Two workers, one
 * contract, both opening PRs.
 *
 * The durable record already existed: every run writes `telemetry.json` into
 * its own directory under `RUNS_ROOT`, and that file has everything a scan
 * needs — lane, host, created_at, terminal_at, the model that actually ran.
 * Nothing read it back. This module does.
 *
 * WHAT THIS DOES NOT FIX. Visibility is recoverable from disk; CONTROL is not.
 * `wait` and `cancel` need the process holding the child's stdio, and no file
 * grants that. So a foreign run is reported as exactly what it is — visible,
 * not controllable — and the tools refuse it with that sentence instead of the
 * old `run '<id>' not found`, which is the lie that caused the double
 * dispatch. Being told "someone else owns this" is a usable answer. Being told
 * "this does not exist" is not.
 */
import fs from "node:fs";
import path from "node:path";
import { RUNS_ROOT } from "./constants.js";
import { realpathBestEffort } from "./worktree.js";
import { RESULT_FILE } from "./run.js";
import type { RunStatus } from "./types.js";

export interface ForeignRun {
  id: string;
  /** Everything below is best-effort: telemetry.json is written by another process and may be mid-rewrite. */
  lane: string | null;
  host: string | null;
  created_at: string | null;
  terminal_at: string | null;
  terminal_reason: string | null;
  /** The model that actually ran — the field a silent swap shows up in (#25). */
  observed_model: string | null;
  read_only: boolean | null;
  turns: number | null;
  /**
   * Process identity, written by the owning server (#32 segment 1) and read
   * here by the adoption protocol (adopt.ts). `server_pid` decides whether
   * control may transfer at all; the worker pair decides what may be signalled
   * once it has. All three are null on records written before PR #40, and that
   * null is what makes adoption fail closed on them.
   */
  server_pid: number | null;
  worker_pid: number | null;
  worker_started_at: number | null;
  /**
   * The #27 issue-comment account, as the dead owner left it on disk.
   *
   * Projected here for the same reason the feature exists at all: a dispatcher
   * asks whether the verdict reached the ticket, and until now the ONE reader
   * who cannot ask the owning process — the disk-poll reader — was also the one
   * reader shown nothing about it. A run whose owner died between raising
   * `issue_comment_pending` and settling it leaves a permanent `pending` on
   * disk; that is not a gap needing more machinery but a legible state, since
   * `terminal_at` is set and the comment never resolved, which reads as
   * "nobody will ever finish this post — check the ticket yourself".
   */
  issue_comment_error: string | null;
  issue_comment_pending: boolean;
  run_dir: string;
  /** Present only when the verdict file exists and is non-empty. */
  result_path?: string;
  /** Age of the newest artifact in the run directory: how long ago this run last did anything observable. */
  last_activity_ms: number;
}

interface Telemetry {
  lane?: string;
  host?: string;
  created_at?: string;
  terminal_at?: string | null;
  terminal_reason?: string | null;
  observed_model?: string | null;
  read_only?: boolean;
  turns?: number;
  server_pid?: number;
  worker_pid?: number;
  worker_started_at?: number;
  issue_comment_error?: string;
  issue_comment_pending?: boolean;
}

/**
 * The shape a run id is allowed to have — the first of two independent guards
 * against a caller-supplied id being spent as a path segment (#32 cold review,
 * run codex-aed92).
 *
 * `id` arrives here straight from `clanker_wait`/`clanker_cancel`'s bare
 * `z.string()` (tools.ts) and everything below joins it onto `runsRoot`, so
 * `id: "../elsewhere"` used to read a `telemetry.json` from OUTSIDE the runs
 * root. A foreign record is not inert data: cancel archives into its
 * `run_dir` and signals the `worker_pid` written in it (manager.ts
 * cancelForeign → adopt.ts). Caller-chosen telemetry deciding which pid this
 * server SIGKILLs is the actual severity, not the read.
 *
 * The pattern is derived from the only thing that mints run ids — manager.ts's
 * ``` `${params.lane}-${(++this.counter).toString(36)}${randomBytes(2).hex}` ```
 * in dispatchStartInternal, whose lane comes from LANE_NAMES (all lowercase
 * alphanumerics, no separators) — and checked against this machine's cache:
 * 563 of 563 run directories match it. Extra `-` segments are tolerated on
 * purpose: an id this pattern rejects is a run nobody can see or cancel, which
 * would be an availability bug in the module whose entire job is not losing
 * track of orphans. What is NOT tolerated is anything that can move the read:
 * a separator, a `.` segment, an empty segment, whitespace, a NUL.
 */
// Lowercase only: `manager.ts` mints `${lane}-${counter36}${hex}` and every
// lane name is lowercase, so `/i` admitted a shape the generator never
// produces. On a case-insensitive volume that let `CODEX-1ABCD` miss the
// in-memory map and then alias the lowercase directory on disk — two names
// for one run, which is the ambiguity an id guard exists to remove
// (round-2 review, codex-dcbfb).
const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/** True when `id` has the shape manager.ts mints. See RUN_ID_PATTERN for why the shape is a security guard. */
export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 128 && RUN_ID_PATTERN.test(id);
}

/**
 * Second guard, deliberately redundant with the first: where does the read
 * ACTUALLY land? The pattern above is a claim about what ids look like; this
 * is a claim about the resolved path, and the two fail for different reasons
 * (a pattern widened by a later edit; a relative or oddly-nested runsRoot).
 * Either alone would close today's hole — both are here so closing it does not
 * depend on one line staying correct forever.
 *
 * Returns null when `id` resolves anywhere but strictly inside `runsRoot`.
 */
function containedRunDir(runsRoot: string, id: string): string | null {
  // realpath, not just resolve: a LEXICAL check answers "does this string sit
  // under that string", which a symlink makes irrelevant. Planting
  // `$runsRoot/codex-link -> ../elsewhere/codex-outside` produced an id that
  // passed the pattern AND lexical containment, and then read an outside
  // telemetry whose `worker_pid` drives a real signal (round-2 review
  // codex-dcbfb; reproduced before this fix). `worktree.ts` learned the same
  // lesson in #12 and has carried `realpathBestEffort` ever since — this is
  // that guard, reused rather than re-derived.
  //
  // Both sides are resolved: a runsRoot that is ITSELF a symlink (a very
  // ordinary macOS `/var` → `/private/var` shape) must not make every honest
  // run look like an escape.
  const root = realpathBestEffort(path.resolve(runsRoot));
  const runDir = realpathBestEffort(path.resolve(path.resolve(runsRoot), id));
  // Strict containment: the runs root itself is never a run directory, and an
  // absolute `id` resolves away from the root entirely — both land here.
  if (runDir === root || !runDir.startsWith(root + path.sep)) return null;
  return runDir;
}

/** Read one run directory's durable record, or null when there is nothing readable there. */
export function readForeignRun(id: string, runsRoot = RUNS_ROOT, now = Date.now()): ForeignRun | null {
  if (!isValidRunId(id)) return null;
  const runDir = containedRunDir(runsRoot, id);
  if (runDir === null) return null;
  let telemetry: Telemetry;
  try {
    telemetry = JSON.parse(fs.readFileSync(path.join(runDir, "telemetry.json"), "utf8")) as Telemetry;
  } catch {
    // No telemetry: either a run that predates the file, or one that died
    // before its first write (#35). Either way there is no durable record to
    // report, and inventing one from a directory name would be worse than
    // silence — it would put a job on the board that may never have spawned.
    return null;
  }

  let newestMtimeMs = 0;
  try {
    for (const entry of fs.readdirSync(runDir)) {
      try {
        newestMtimeMs = Math.max(newestMtimeMs, fs.statSync(path.join(runDir, entry)).mtimeMs);
      } catch { /* vanished under us */ }
    }
  } catch { /* directory vanished under us */ }

  let resultPath: string | undefined;
  try {
    if (fs.statSync(path.join(runDir, RESULT_FILE)).size > 0) resultPath = path.join(runDir, RESULT_FILE);
  } catch { /* no verdict file yet */ }

  return {
    id,
    lane: telemetry.lane ?? null,
    host: telemetry.host ?? null,
    created_at: telemetry.created_at ?? null,
    terminal_at: telemetry.terminal_at ?? null,
    terminal_reason: telemetry.terminal_reason ?? null,
    observed_model: telemetry.observed_model ?? null,
    read_only: telemetry.read_only ?? null,
    turns: telemetry.turns ?? null,
    server_pid: typeof telemetry.server_pid === "number" ? telemetry.server_pid : null,
    worker_pid: typeof telemetry.worker_pid === "number" ? telemetry.worker_pid : null,
    worker_started_at: typeof telemetry.worker_started_at === "number" ? telemetry.worker_started_at : null,
    issue_comment_error: typeof telemetry.issue_comment_error === "string" ? telemetry.issue_comment_error : null,
    issue_comment_pending: telemetry.issue_comment_pending === true,
    run_dir: runDir,
    ...(resultPath ? { result_path: resultPath } : {}),
    last_activity_ms: newestMtimeMs > 0 ? Math.max(0, now - newestMtimeMs) : -1,
  };
}

/**
 * The run status a durable record implies, for the paths that must answer with
 * a `RunStatus` for a run they never held (#32: adopted cancel, degraded wait).
 *
 * Derived from what is written down, never from what the caller wanted to hear:
 * a record with no `terminal_at` is still running no matter who is asking, and
 * an adopting process that just killed a worker must not restate a run the
 * owner already recorded as `done` — hence the mapping keys off the file, and
 * the archival path (adopt.ts) never overwrites an existing terminal_at.
 * `cancelled-foreign` is the adoption protocol's own reason and maps to
 * `cancelled`, which is what actually happened to it.
 */
export function foreignRunStatus(run: ForeignRun): RunStatus {
  if (!run.terminal_at) return "running";
  switch (run.terminal_reason) {
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "cancelled";
  }
}

export interface ScanOptions {
  runsRoot?: string;
  /** Ids owned by this process — excluded, since the live object is strictly better than its file. */
  exclude?: ReadonlySet<string>;
  /** Only report runs that never reached a terminal state. Default true: the question a scan asks is "what is still in flight elsewhere". */
  inFlightOnly?: boolean;
  now?: number;
}

/**
 * Every run on disk that this process does not own. Never throws: an
 * unreadable cache directory must degrade to "I saw nothing here", never take
 * down the tool that reports it.
 */
export function scanForeignRuns(options: ScanOptions = {}): ForeignRun[] {
  const runsRoot = options.runsRoot ?? RUNS_ROOT;
  const exclude = options.exclude ?? new Set<string>();
  const inFlightOnly = options.inFlightOnly ?? true;
  const now = options.now ?? Date.now();

  let ids: string[];
  try {
    ids = fs.readdirSync(runsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const found: ForeignRun[] = [];
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const run = readForeignRun(id, runsRoot, now);
    if (!run) continue;
    if (inFlightOnly && run.terminal_at) continue;
    found.push(run);
  }
  // Newest activity first: an orphan scan reads the top of this list. `-1`
  // is the "mtime unreadable" sentinel (see readForeignRun above), not a
  // real age — sorted as a bare number it is smaller than every real age and
  // would land AT THE TOP as if it were the most-recently-active run, which
  // is the opposite of what "unreadable" means. Rank it as +Infinity (last)
  // instead (#37 D4).
  const activityRank = (ms: number) => (ms < 0 ? Infinity : ms);
  found.sort((a, b) => activityRank(a.last_activity_ms) - activityRank(b.last_activity_ms));
  return found;
}

/**
 * The refusal a lifecycle tool gives for a run this process does not own.
 * Deliberately a full sentence with the run directory in it: the seat reading
 * it has to be able to tell "not mine" apart from "does not exist" without
 * asking anyone.
 *
 * `owner` (adopt.ts's liveness probe) is supplied by the tools that CAN adopt
 * an orphan — cancel and wait. When it is, the refusal also says why control
 * did not transfer, because "the owner is alive, go there" and "I cannot tell
 * whether the owner is alive" call for different next moves from the reader:
 * one is a redirect, the other is a run too old to carry a server_pid.
 */
export function foreignControlRefusal(
  id: string,
  run: ForeignRun,
  owner?: { state: "alive" | "dead" | "unknown"; pid: number | null; detail: string },
): string {
  const state = run.terminal_at ? `already terminal (${run.terminal_reason ?? "unknown"})` : "still in flight";
  const ownerClause =
    owner?.state === "alive"
      ? ` The owner session is still alive (${owner.detail}) — cancel or wait for this run from THAT session; ` +
        `control transfers only once the owning server is provably dead.`
      : owner?.state === "unknown"
        ? ` Ownership could not be established (${owner.detail}), so this process will not take it over: ` +
          `adoption requires proof the owning server is dead, and an unproven owner is treated as a live one.`
        : "";
  return (
    `run '${id}' belongs to a different Clanker server process and is ${state}. ` +
    `Each session spawns its own server, and control (wait/cancel/prompt) needs the process that holds the ` +
    `worker's stdio — it cannot be recovered from disk. You can read its record at ${run.run_dir}` +
    `${run.result_path ? ` and its verdict at ${run.result_path}` : ""}. ` +
    `Do NOT re-dispatch on the assumption that it never started.${ownerClause}`
  );
}
