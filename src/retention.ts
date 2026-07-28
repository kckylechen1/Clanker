/**
 * Run-artifact retention.
 *
 * Every dispatch leaves a directory under `RUNS_ROOT` holding four things
 * (run.ts): `events.jsonl` (the raw ACP event stream), `chunks.log` (the
 * thought/message fragments), `telemetry.json` (the live projection) and
 * `result.md` (the verdict). Until this file, nothing ever deleted any of it.
 *
 * Measured on one operator's accumulated 477 runs, 2026-07-28:
 *
 *     events.jsonl    445 files   282.2 MB
 *     chunks.log      301 files    33.0 MB
 *     telemetry.json  309 files     0.2 MB
 *     result.md        84 files     0.5 MB
 *
 * The split is the whole design. The two streams are 99.8% of the disk and the
 * only part with a short half-life — they exist so a human can reconstruct a
 * dispatch that failed strangely, which nobody does three weeks later. The
 * remaining 0.2% is load-bearing indefinitely and must never be swept:
 *
 *   - `result.md` is not an archive, it is the live delivery contract. Relay
 *     seats hand back `result_path` and are forbidden to restate the verdict
 *     (plugin/README.md), so deleting it does not lose history, it breaks a
 *     delivery.
 *   - `telemetry.json` is the only record of what a dispatch ACTUALLY did, as
 *     opposed to what its dispatcher believes it asked for. `observed_model`
 *     (#25) is what caught the out-of-band `~/.codex/config.toml` edit that
 *     silently moved every run onto another model with zero signal (af0dea5).
 *     A hand-written lane card structurally cannot catch that: the card is the
 *     dispatcher's own account, and the account is exactly what was wrong.
 *
 * So the sweep is per-file, not per-directory. A swept run keeps its verdict
 * and its measurement and loses only the bytes nobody reads.
 *
 * AGE IS THE STREAMS' OWN MTIME, NOT `telemetry.terminal_at`.
 *
 * Keying off telemetry looks more principled and is worse twice over. It would
 * strand every run that predates `telemetry.json` (6d29c9c) — 137 of the 477
 * dirs above, and most of the 282 MB — because a missing `terminal_at` cannot
 * be compared against anything, so the bulk of the problem would never be
 * reclaimed. And it would be a weaker guard, not a stronger one: mtime is
 * defined for every run ever written, and it moves whenever a live run appends.
 * No profile's turn ceiling exceeds 45 minutes (profiles.ts), so a stream that
 * has been silent for three days cannot belong to a turn still in progress —
 * the file's own quiet IS the terminality signal, and it needs no schema.
 */
import fs from "node:fs";
import path from "node:path";
import { RUN_STREAM_TTL_MS, RUNS_ROOT } from "./constants.js";
import { RUN_STREAM_FILES } from "./run.js";

export interface SweepReport {
  /** Run directories examined. */
  scanned: number;
  /** Run directories from which at least one stream was reclaimed. */
  sweptRuns: number;
  sweptFiles: number;
  bytesFreed: number;
  /** Run directories removed because the sweep left them with nothing at all. */
  removedRuns: number;
  /** Streams that were past the TTL but could not be unlinked. */
  failures: number;
}

export interface SweepOptions {
  runsRoot?: string;
  ttlMs?: number;
  now?: number;
}

/**
 * Reclaim cold run streams. Never throws: retention is maintenance, and a
 * server that refuses to start because a cache directory is odd would trade a
 * disk-space problem for an outage.
 */
export function sweepRunStreams(options: SweepOptions = {}): SweepReport {
  const runsRoot = options.runsRoot ?? RUNS_ROOT;
  const ttlMs = options.ttlMs ?? RUN_STREAM_TTL_MS;
  const now = options.now ?? Date.now();
  const report: SweepReport = { scanned: 0, sweptRuns: 0, sweptFiles: 0, bytesFreed: 0, removedRuns: 0, failures: 0 };

  if (!(ttlMs > 0)) return report;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    // No runs root yet (first start), or it is unreadable. Nothing to do.
    return report;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    report.scanned++;
    const runDir = path.join(runsRoot, entry.name);

    // Collect the run's streams and the mtime of the most recently touched one.
    // Judging the pair together, rather than each file on its own, keeps a run
    // whose `chunks.log` is still warm from losing its `events.jsonl`: the two
    // are read as a set when reconstructing a failure, so half a set is not
    // worth keeping and not worth deleting.
    const streams: { file: string; size: number }[] = [];
    let newestMtimeMs = 0;
    for (const name of RUN_STREAM_FILES) {
      const file = path.join(runDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue; // absent, or vanished under us — either way nothing to reclaim
      }
      if (!stat.isFile()) continue;
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      streams.push({ file, size: stat.size });
    }

    if (streams.length === 0) continue;
    if (now - newestMtimeMs <= ttlMs) continue;

    let swept = 0;
    for (const stream of streams) {
      try {
        fs.rmSync(stream.file);
        report.sweptFiles++;
        report.bytesFreed += stream.size;
        swept++;
      } catch {
        report.failures++;
      }
    }
    if (swept > 0) {
      report.sweptRuns++;
      // A run that predates telemetry.json holds NOTHING but the two streams,
      // so sweeping it leaves a bare directory behind — and unlinking a file
      // bumps the directory's own mtime, so the leftover also looks brand new.
      // That is not merely litter: an empty run directory is the only trace a
      // dispatch that died before its first write leaves behind (manager.ts
      // mkdirs the run dir before resolveSpec and before any spawn), and the
      // first real sweep of one operator's cache turned 31 such directories
      // into 137 freshly-stamped ones. Retention has to leave that signal where
      // it found it, so a directory the sweep itself emptied is removed;
      // directories that were ALREADY empty are evidence and stay untouched.
      if (isEmptyDir(runDir) && removeDir(runDir)) report.removedRuns++;
    }
  }

  return report;
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function removeDir(dir: string): boolean {
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable one-liner for the startup log; `null` when nothing was reclaimed. */
export function formatSweepReport(report: SweepReport): string | null {
  if (report.sweptFiles === 0 && report.failures === 0) return null;
  const mb = (report.bytesFreed / 1_048_576).toFixed(1);
  const removed = report.removedRuns > 0 ? `, ${report.removedRuns} emptied dir(s) removed` : "";
  const failed = report.failures > 0 ? `, ${report.failures} failed` : "";
  return `retention: reclaimed ${report.sweptFiles} stream file(s) from ${report.sweptRuns} run(s), ${mb} MB${removed}${failed} (${report.scanned} scanned)`;
}
