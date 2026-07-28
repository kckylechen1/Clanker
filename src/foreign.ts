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
import { RESULT_FILE } from "./run.js";

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
}

/** Read one run directory's durable record, or null when there is nothing readable there. */
export function readForeignRun(id: string, runsRoot = RUNS_ROOT, now = Date.now()): ForeignRun | null {
  const runDir = path.join(runsRoot, id);
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
    run_dir: runDir,
    ...(resultPath ? { result_path: resultPath } : {}),
    last_activity_ms: newestMtimeMs > 0 ? Math.max(0, now - newestMtimeMs) : -1,
  };
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
 */
export function foreignControlRefusal(id: string, run: ForeignRun): string {
  const state = run.terminal_at ? `already terminal (${run.terminal_reason ?? "unknown"})` : "still in flight";
  return (
    `run '${id}' belongs to a different Clanker server process and is ${state}. ` +
    `Each session spawns its own server, and control (wait/cancel/prompt) needs the process that holds the ` +
    `worker's stdio — it cannot be recovered from disk. You can read its record at ${run.run_dir}` +
    `${run.result_path ? ` and its verdict at ${run.result_path}` : ""}. ` +
    `Do NOT re-dispatch on the assumption that it never started.`
  );
}
