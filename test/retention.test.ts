/**
 * Retention sweep acceptance.
 *
 * The property under test is a SPLIT, not a deletion: the two forensic streams
 * are reclaimable once cold, and the verdict (`result.md`) and the measurement
 * (`telemetry.json`) are not, ever. Every test below therefore asserts on BOTH
 * halves in the same directory — a sweep that deleted the whole run directory
 * would satisfy "the streams are gone" and destroy the delivery contract.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatSweepReport, sweepRunStreams } from "../src/retention.js";

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;
const TTL = 3 * DAY_MS;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clanker-retention-"));
}

/** Write a run directory whose files carry a chosen age in days. */
function makeRun(
  root: string,
  id: string,
  files: Record<string, { text: string; ageDays: number }>,
): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, spec] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, spec.text);
    const seconds = (NOW - spec.ageDays * DAY_MS) / 1000;
    fs.utimesSync(file, seconds, seconds);
  }
  return dir;
}

const exists = (dir: string, name: string): boolean => fs.existsSync(path.join(dir, name));

test("a cold run loses both streams and keeps its verdict and telemetry", () => {
  const root = tmpRoot();
  const dir = makeRun(root, "codex-cold", {
    "events.jsonl": { text: "x".repeat(1000), ageDays: 10 },
    "chunks.log": { text: "y".repeat(500), ageDays: 10 },
    "telemetry.json": { text: '{"terminal_at":"2026-07-01T00:00:00Z"}', ageDays: 10 },
    "result.md": { text: "# verdict", ageDays: 10 },
  });

  const report = sweepRunStreams({ runsRoot: root, ttlMs: TTL, now: NOW });

  assert.equal(exists(dir, "events.jsonl"), false);
  assert.equal(exists(dir, "chunks.log"), false);
  // The half that must survive. These two assertions are the point of the file.
  assert.equal(exists(dir, "telemetry.json"), true);
  assert.equal(exists(dir, "result.md"), true);
  assert.equal(fs.readFileSync(path.join(dir, "result.md"), "utf8"), "# verdict");

  assert.deepEqual(
    { scanned: report.scanned, sweptRuns: report.sweptRuns, sweptFiles: report.sweptFiles, bytesFreed: report.bytesFreed, failures: report.failures },
    { scanned: 1, sweptRuns: 1, sweptFiles: 2, bytesFreed: 1500, failures: 0 },
  );
});

test("a run inside the TTL is untouched", () => {
  const root = tmpRoot();
  const dir = makeRun(root, "codex-warm", {
    "events.jsonl": { text: "x", ageDays: 2 },
    "chunks.log": { text: "y", ageDays: 2 },
  });

  const report = sweepRunStreams({ runsRoot: root, ttlMs: TTL, now: NOW });

  assert.equal(exists(dir, "events.jsonl"), true);
  assert.equal(exists(dir, "chunks.log"), true);
  assert.equal(report.sweptFiles, 0);
  assert.equal(report.scanned, 1);
});

test("a warm chunks.log protects a cold events.jsonl — the streams age as a set", () => {
  // Reconstructing a failure reads both files together, so half a set is
  // neither worth keeping nor worth deleting. A per-file rule would silently
  // gut the pair of a run that is still being appended to.
  const root = tmpRoot();
  const dir = makeRun(root, "codex-mixed", {
    "events.jsonl": { text: "x", ageDays: 9 },
    "chunks.log": { text: "y", ageDays: 1 },
  });

  const report = sweepRunStreams({ runsRoot: root, ttlMs: TTL, now: NOW });

  assert.equal(exists(dir, "events.jsonl"), true);
  assert.equal(exists(dir, "chunks.log"), true);
  assert.equal(report.sweptFiles, 0);
});

test("a legacy run with no telemetry.json is still reclaimed", () => {
  // 137 of the 477 measured run directories predate telemetry.json (6d29c9c)
  // and hold most of the 282 MB. A sweep keyed on `terminal_at` would never
  // touch them, which is precisely why age comes from the streams' own mtime.
  const root = tmpRoot();
  const dir = makeRun(root, "opencode-legacy", {
    "events.jsonl": { text: "x".repeat(64), ageDays: 30 },
    "chunks.log": { text: "y".repeat(32), ageDays: 30 },
  });

  const report = sweepRunStreams({ runsRoot: root, ttlMs: TTL, now: NOW });

  assert.equal(exists(dir, "events.jsonl"), false);
  assert.equal(exists(dir, "chunks.log"), false);
  assert.equal(report.sweptFiles, 2);
  assert.equal(report.bytesFreed, 96);
});

test("ttl 0 disables the sweep entirely", () => {
  const root = tmpRoot();
  const dir = makeRun(root, "codex-ancient", {
    "events.jsonl": { text: "x", ageDays: 900 },
    "chunks.log": { text: "y", ageDays: 900 },
  });

  const report = sweepRunStreams({ runsRoot: root, ttlMs: 0, now: NOW });

  assert.equal(exists(dir, "events.jsonl"), true);
  assert.equal(exists(dir, "chunks.log"), true);
  assert.deepEqual(report, { scanned: 0, sweptRuns: 0, sweptFiles: 0, bytesFreed: 0, failures: 0 });
});

test("a missing runs root is not an error", () => {
  const report = sweepRunStreams({
    runsRoot: path.join(os.tmpdir(), "clanker-retention-does-not-exist-4f2a"),
    ttlMs: TTL,
    now: NOW,
  });
  assert.deepEqual(report, { scanned: 0, sweptRuns: 0, sweptFiles: 0, bytesFreed: 0, failures: 0 });
});

test("stray non-directory entries and empty run dirs are skipped without throwing", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "stray.txt"), "not a run");
  fs.mkdirSync(path.join(root, "codex-empty")); // a dispatch that died before its first write
  const dir = makeRun(root, "codex-cold", {
    "events.jsonl": { text: "x", ageDays: 10 },
  });

  const report = sweepRunStreams({ runsRoot: root, ttlMs: TTL, now: NOW });

  assert.equal(exists(dir, "events.jsonl"), false);
  assert.equal(fs.existsSync(path.join(root, "stray.txt")), true, "a non-directory entry must not be swept");
  assert.equal(fs.existsSync(path.join(root, "codex-empty")), true, "an empty run dir is evidence, not garbage");
  assert.equal(report.scanned, 2, "only directories count as scanned runs");
  assert.equal(report.sweptRuns, 1);
});

test("the startup line is silent when nothing was reclaimed and specific when something was", () => {
  assert.equal(formatSweepReport({ scanned: 12, sweptRuns: 0, sweptFiles: 0, bytesFreed: 0, failures: 0 }), null);
  const line = formatSweepReport({ scanned: 12, sweptRuns: 3, sweptFiles: 5, bytesFreed: 3_145_728, failures: 1 });
  assert.match(line ?? "", /5 stream file\(s\) from 3 run\(s\), 3\.0 MB, 1 failed \(12 scanned\)/);
});
