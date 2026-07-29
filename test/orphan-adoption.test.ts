/**
 * Orphan adoption — cross-process CONTROL (#32 segments 2 and 3).
 *
 * Visibility for foreign runs came first and was deliberately powerless:
 * `cancel`/`wait` refused any run this process did not hold, because control
 * needs the process holding the worker's stdio. That refusal is right exactly
 * as long as that process EXISTS. When it does not, the refusal protects
 * nobody — it leaves a live worker holding a worktree, burning tokens, with
 * every lifecycle tool politely declining to stop it.
 *
 * So the property under test is a conditional transfer, and every test here
 * exists to pin one half of it:
 *
 *   - owner alive  → refuse, and send NO signal (a cancel that "helpfully"
 *                    kills a worker whose session is alive is two processes
 *                    fighting over one child)
 *   - owner dead   → adopt: verify the pid is still the worker, kill its whole
 *                    group, RE-verify between TERM and KILL, and close the
 *                    record so the corpse leaves the orphan board
 *   - unverifiable → archive, never signal
 *
 * The fixtures are real processes, not mocks, because every claim here is a
 * claim about the operating system: that a pid is gone, that a grandchild died
 * with its group, that a SIGTERM was ignored. A faked `kill` would prove that
 * the code calls a function.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { scanForeignRuns } from "../src/foreign.js";
import { probeOwner, verifyWorkerIdentity } from "../src/adopt.js";
import { dropMutant, fakeSpec, loadMutantManager, until } from "./helpers.js";

/** Is this pid still signalable? (`kill(pid, 0)` — no signal delivered.) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process that does nothing but stay alive — the stand-in for another session's MCP server. */
function spawnIdle(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  child.unref();
  return child;
}

/** Kill a stand-in and wait until its pid is genuinely reaped, so `kill(pid, 0)` really says ESRCH. */
async function killAndReap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
    await exited;
  }
  await until(() => !alive(child.pid!), 4_000);
}

/**
 * A worker fixture shaped like a real lane worker: `detached`, so it LEADS its
 * own process group (exactly what acp-client.ts does since PR #40), and with a
 * child of its own inside that group — the stand-in for `codex app-server`,
 * the grandchild a single-pid kill leaves running.
 */
interface WorkerFixture {
  child: ChildProcess;
  pid: number;
  grandchildPid: number;
  startedAt: number;
  cleanup: () => void;
}

async function spawnWorker(opts: { ignoreTerm?: boolean } = {}): Promise<WorkerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-adopt-worker-"));
  const pidFile = path.join(dir, "pids.json");
  const script = [
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    "if (process.env.IGNORE_TERM) process.on('SIGTERM', () => {});",
    // NOT detached: the grandchild stays inside this process's group, so a
    // group kill reaches it and a single-pid kill does not.
    "const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });",
    "kid.unref();",
    "fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ worker: process.pid, grandchild: kid.pid }));",
    "setInterval(() => {}, 1e9);",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PID_FILE: pidFile, ...(opts.ignoreTerm ? { IGNORE_TERM: "1" } : {}) },
  });
  const startedAt = Date.now();
  child.unref();
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").includes("grandchild"), 8_000);
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { worker: number; grandchild: number };
  assert.equal(pids.worker, child.pid, "fixture must report its own pid");
  assert.ok(alive(pids.grandchild), "the grandchild must be running before anything is killed");
  return {
    child,
    pid: child.pid!,
    grandchildPid: pids.grandchild,
    startedAt,
    cleanup: () => {
      for (const pid of [pids.grandchild, pids.worker]) {
        if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* raced */ } }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeRunsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clanker-adopt-"));
}

/** Write the record another session's server would have left behind. */
function writeRun(root: string, id: string, telemetry: Record<string, unknown>): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify(telemetry, null, 2));
  return dir;
}

function readTelemetry(root: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, id, "telemetry.json"), "utf8")) as Record<string, unknown>;
}

function orphanTelemetry(ownerPid: number, worker: WorkerFixture, overrides: Record<string, unknown> = {}) {
  return {
    lane: "codex",
    host: "claude",
    created_at: new Date(worker.startedAt).toISOString(),
    terminal_at: null,
    server_pid: ownerPid,
    worker_pid: worker.pid,
    worker_started_at: worker.startedAt,
    ...overrides,
  };
}

function manager(root: string, graceMs = 800): LaneManager {
  return new LaneManager({
    resolveSpec: () => fakeSpec(),
    disableReaper: true,
    baseRepo: os.tmpdir(),
    runsRoot: root,
    cancelGraceMs: graceMs,
  });
}

// ---- the liveness gate ------------------------------------------------------

test("owner alive: cancel is refused and NOT ONE SIGNAL is sent", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  writeRun(root, "codex-live-owner", orphanTelemetry(owner.pid!, worker));
  const m = manager(root);
  try {
    await assert.rejects(() => m.cancel("codex-live-owner"), (error: Error) => {
      assert.match(error.message, /belongs to a different Clanker server process/);
      assert.match(error.message, /owner session is still alive/i, "the refusal must say WHY it refused");
      assert.match(error.message, /provably dead/, "and say what would change the answer");
      return true;
    });
    // The load-bearing half: refusing is not a message, it is an absence of
    // signals. A cancel that killed the worker anyway would still produce a
    // rejection above.
    assert.ok(alive(worker.pid), "the worker of a live session must be untouched");
    assert.ok(alive(worker.grandchildPid), "and so must its grandchild");
    assert.equal(readTelemetry(root, "codex-live-owner").terminal_at, null, "no archival either — the run is not ours to close");
  } finally {
    await m.shutdown();
    worker.cleanup();
    await killAndReap(owner);
  }
});

test("mutant: inverting the owner-liveness verdict kills a LIVE session's worker (proves the gate above)", async () => {
  const name = "adopt-owner-alive-inverted";
  const mutated = await loadMutantManager(name, [
    {
      file: "adopt.ts",
      find: '    process.kill(serverPid, 0);\n    return { state: "alive", pid: serverPid, detail: `server_pid ${serverPid} answers to kill(pid, 0)` };',
      replace: '    process.kill(serverPid, 0);\n    return { state: "dead", pid: serverPid, detail: "mutant: a live owner reported dead" };',
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  writeRun(root, "codex-live-owner", orphanTelemetry(owner.pid!, worker));
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 800,
  });
  try {
    const result = await m.cancel("codex-live-owner");
    assert.equal(result.adopted, true, "the mutant adopts a run whose owner is alive");
    await until(() => !alive(worker.pid), 4_000);
    assert.ok(
      !alive(worker.pid),
      "with the liveness check inverted the worker dies — so the previous test observes the gate, not luck",
    );
  } finally {
    await m.shutdown();
    worker.cleanup();
    await killAndReap(owner);
    dropMutant(name);
  }
});

test("no server_pid on record: liveness is unprovable, so control stays put", async () => {
  // Runs written before PR #40 carry no pid at all. "I cannot tell" must land
  // on the same side as "alive": adoption needs PROOF of death, and a missing
  // field is not proof of anything.
  const root = makeRunsRoot();
  writeRun(root, "codex-ancient", { lane: "codex", terminal_at: null });
  const m = manager(root);
  try {
    await assert.rejects(() => m.cancel("codex-ancient"), (error: Error) => {
      assert.match(error.message, /Ownership could not be established/);
      assert.match(error.message, /names no server_pid/);
      return true;
    });
    await assert.rejects(() => m.wait("codex-ancient", 10), /Ownership could not be established/);
  } finally {
    await m.shutdown();
  }
});

// ---- adoption proper --------------------------------------------------------

test("owner dead: the worker's whole group dies and the record is closed", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  const runDir = writeRun(root, "codex-orphan", orphanTelemetry(owner.pid!, worker));
  await killAndReap(owner); // the session that dispatched it is gone
  const m = manager(root);
  try {
    const result = await m.cancel("codex-orphan");
    assert.equal(result.adopted, true);
    assert.equal(result.status, "cancelled");
    assert.equal(result.identity_verified, true, "a matching start time is what makes the signal legal");
    assert.equal(result.killed, true);
    assert.equal(result.owner_pid, owner.pid);
    assert.equal(result.worker_pid, worker.pid);

    await until(() => !alive(worker.pid), 4_000);
    // The grandchild is the reason the kill is a GROUP kill: a single-pid kill
    // leaves it holding the worktree with nothing left that knows it exists.
    await until(() => !alive(worker.grandchildPid), 4_000);

    const telemetry = readTelemetry(root, "codex-orphan");
    assert.ok(telemetry.terminal_at, "an adopted run must be closed, or it haunts the orphan board forever");
    assert.equal(telemetry.terminal_reason, "cancelled-foreign", "and must be distinguishable from the owner's own cancel");
    assert.match(String(telemetry.error), new RegExp(`adopted and cancelled by Clanker server pid ${process.pid}`),
      "the record must name who closed it");
    assert.match(String(telemetry.error), new RegExp(`pid ${owner.pid}`), "and whose corpse justified it");
    // Fields written by the dead owner survive: archival fills a gap, it does
    // not rewrite the record.
    assert.equal(telemetry.lane, "codex");
    assert.equal(telemetry.worker_pid, worker.pid);

    const stub = fs.readFileSync(path.join(runDir, "result.md"), "utf8");
    assert.match(stub, /## adoption/);
    assert.match(stub, /no verdict/i, "a stub must not read like a verdict the worker produced");
    // realpath, not the lexical join: containment now resolves symlinks
    // (round-2 review codex-dcbfb) and the resolved path is what the caller is
    // handed, so on macOS this is /private/var..., not /var....
    assert.equal(result.result_path, path.join(fs.realpathSync(runDir), "result.md"));
  } finally {
    await m.shutdown();
    worker.cleanup();
  }
});

test("an adopted run leaves the in-flight board", async () => {
  // The closing of the loop: without archival the kill is invisible to the one
  // board an orphan sweep reads, so the sweep keeps reporting a dead job as
  // running and the next seat re-dispatches or waits on a corpse.
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  writeRun(root, "codex-board", orphanTelemetry(owner.pid!, worker));
  await killAndReap(owner);
  const m = manager(root);
  try {
    assert.equal(scanForeignRuns({ runsRoot: root }).length, 1, "before: it is on the board");
    assert.ok(m.list().some((e) => e.id === "codex-board" && e.owner === "foreign"));

    await m.cancel("codex-board");

    assert.deepEqual(scanForeignRuns({ runsRoot: root }).map((r) => r.id), [], "after: the corpse is off the board");
    assert.equal(m.list().some((e) => e.id === "codex-board"), false);
    // Still visible when asked for terminal runs too — archived, not erased.
    assert.deepEqual(
      scanForeignRuns({ runsRoot: root, inFlightOnly: false }).map((r) => r.terminal_reason),
      ["cancelled-foreign"],
    );
  } finally {
    await m.shutdown();
    worker.cleanup();
  }
});

test("mutant: without archival the killed orphan stays 'in flight' forever (proves the test above)", async () => {
  const name = "adopt-no-archive";
  const mutated = await loadMutantManager(name, [
    {
      file: "manager.ts",
      find: "    const archive = archiveAdoptedRun({",
      replace: "    const archive = ((_: unknown) => ({ telemetry_written: false, result_stub_written: false, problems: [] }))({",
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  writeRun(root, "codex-board", orphanTelemetry(owner.pid!, worker));
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 800,
  });
  try {
    await m.cancel("codex-board");
    await until(() => !alive(worker.pid), 4_000);
    assert.equal(
      scanForeignRuns({ runsRoot: root }).length,
      1,
      "the worker is dead and the board still says it is running — exactly the state archival exists to prevent",
    );
  } finally {
    await m.shutdown();
    worker.cleanup();
    dropMutant(name);
  }
});

// ---- the pid-reuse guard ----------------------------------------------------

test("pid reuse: a start time that does not match gets NO signal, only an archived record", async () => {
  // The whole hazard in one test. `worker_pid` names a NUMBER; the OS is free
  // to hand that number to anything once the worker is reaped. Here the record
  // claims a worker that started an hour before this process did, so the pid
  // cannot be the worker — and the process wearing it is a stranger.
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  writeRun(root, "codex-recycled", orphanTelemetry(owner.pid!, worker, {
    worker_started_at: worker.startedAt - 3_600_000,
  }));
  await killAndReap(owner);
  const m = manager(root);
  try {
    const result = await m.cancel("codex-recycled");
    assert.equal(result.adopted, true);
    assert.equal(result.identity_verified, false);
    assert.equal(result.killed, false, "an unverified pid must receive nothing at all");
    assert.match(result.note!, /recycled/);

    // The stranger lives. This assertion is the guard.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(worker.pid), "a pid that failed identity verification must not be signalled");
    assert.ok(alive(worker.grandchildPid), "and neither must its group");

    // Step 4 still runs: the record is closed even though nothing was killed,
    // because a run whose worker cannot be found is not a run that is still
    // going to finish.
    assert.equal(readTelemetry(root, "codex-recycled").terminal_reason, "cancelled-foreign");
  } finally {
    await m.shutdown();
    worker.cleanup();
  }
});

test("mutant: removing the identity guard kills the stranger (proves the guard above)", async () => {
  const name = "adopt-no-identity-guard";
  const mutated = await loadMutantManager(name, [
    {
      file: "adopt.ts",
      find: "  const probe = readProcessFacts(pid);\n  if (!probe.ok) return { verified: false, reason: probe.reason };",
      replace: "  const probe = readProcessFacts(pid);\n  if (!probe.ok) return { verified: false, reason: probe.reason };\n  if (true) return { verified: true, reason: \"mutant: identity never checked\" };",
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  writeRun(root, "codex-recycled", orphanTelemetry(owner.pid!, worker, {
    worker_started_at: worker.startedAt - 3_600_000,
  }));
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 800,
  });
  try {
    const result = await m.cancel("codex-recycled");
    assert.equal(result.killed, true, "the mutant signals a pid it cannot identify");
    await until(() => !alive(worker.pid), 4_000);
  } finally {
    await m.shutdown();
    worker.cleanup();
    dropMutant(name);
  }
});

test("identity verification is a real reading of the OS, not a lookup", () => {
  // Direct unit check on the primitive both kill steps depend on: a live pid
  // with the truth recorded verifies; the same live pid with a forged start
  // time does not.
  const self = process.pid;
  const truthful = verifyWorkerIdentity(self, Date.now() - 200, "codex", 60_000);
  assert.equal(truthful.verified, true, `this very process must verify against its own start (${truthful.reason})`);
  assert.ok(typeof truthful.observed_started_at === "number");
  assert.equal(verifyWorkerIdentity(self, Date.now() - 3_600_000, "codex").verified, false);
  // A pid that does not exist cannot be verified — and therefore cannot be signalled.
  assert.equal(verifyWorkerIdentity(2 ** 22 - 1, Date.now(), "codex").verified, false);
  // Missing record = no check possible = fail closed.
  assert.equal(verifyWorkerIdentity(self, null, "codex").verified, false);
});

test("owner liveness reads ESRCH as dead and everything else as not-dead", async () => {
  const child = spawnIdle();
  assert.equal(probeOwner(child.pid!).state, "alive");
  await killAndReap(child);
  assert.equal(probeOwner(child.pid!).state, "dead");
  assert.equal(probeOwner(undefined).state, "unknown");
  assert.equal(probeOwner(0).state, "unknown");
  // pid 1 (launchd/init) exists and is not ours: EPERM means alive, never dead.
  assert.notEqual(probeOwner(1).state, "dead");
  // This process is alive by definition; adopting one's own run is never right.
  assert.equal(probeOwner(process.pid).state, "alive");
});

// ---- the window between the two kills ---------------------------------------

test("a worker that ignores SIGTERM is re-verified and then SIGKILLed", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker({ ignoreTerm: true });
  writeRun(root, "codex-stubborn", orphanTelemetry(owner.pid!, worker));
  await killAndReap(owner);
  const m = manager(root, 400);
  try {
    const result = await m.cancel("codex-stubborn");
    assert.equal(result.killed, true);
    assert.equal(result.identity_verified, true, "the SECOND check is what authorized the SIGKILL");
    assert.match(result.note!, /survived SIGTERM/);
    assert.match(result.note!, /SIGKILLed/);
    await until(() => !alive(worker.pid), 4_000);
    await until(() => !alive(worker.grandchildPid), 4_000);
  } finally {
    await m.shutdown();
    worker.cleanup();
  }
});

test("mutant: a pid that stops matching DURING the grace gets no SIGKILL", async () => {
  // The grace window is precisely when a worker dies and its number becomes
  // reusable, so the check performed before SIGTERM is stale by the time
  // SIGKILL is due. There is no way to make the OS recycle a pid on cue, so the
  // recycling is simulated at the one place it would be observed: the RE-check
  // (and only the re-check) sees a start time that no longer matches.
  const name = "adopt-recheck-mismatch";
  const mutated = await loadMutantManager(name, [
    {
      file: "adopt.ts",
      find: "  const recheck = verifyWorkerIdentity(workerPid, workerStartedAt, lane);",
      replace: "  const recheck = verifyWorkerIdentity(workerPid, (workerStartedAt ?? 0) - 3_600_000, lane);",
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker({ ignoreTerm: true });
  writeRun(root, "codex-stubborn", orphanTelemetry(owner.pid!, worker));
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 400,
  });
  try {
    const result = await m.cancel("codex-stubborn");
    assert.equal(result.identity_verified, false);
    assert.match(result.note!, /SIGKILL withheld/);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(worker.pid), "a pid whose identity changed during the grace must survive the escalation");
  } finally {
    await m.shutdown();
    worker.cleanup();
    dropMutant(name);
  }
});

test("mutant: escalating on the FIRST check instead of re-checking kills the recycled pid", async () => {
  // Same simulated recycling as above, with the re-check reduced to a reuse of
  // the pre-SIGTERM verdict — which is what the code did before the second
  // check existed. The stubborn process dies, and that death is the bug the
  // re-check prevents.
  const name = "adopt-recheck-removed";
  const mutated = await loadMutantManager(name, [
    {
      file: "adopt.ts",
      find: "  const recheck = verifyWorkerIdentity(workerPid, workerStartedAt, lane);",
      replace: "  const recheck = identity; void verifyWorkerIdentity(workerPid, (workerStartedAt ?? 0) - 3_600_000, lane);",
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker({ ignoreTerm: true });
  writeRun(root, "codex-stubborn", orphanTelemetry(owner.pid!, worker));
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 400,
  });
  try {
    const result = await m.cancel("codex-stubborn");
    assert.equal(result.killed, true);
    await until(() => !alive(worker.pid), 4_000);
    assert.ok(!alive(worker.pid), "without the re-check the escalation lands on whatever holds the pid now");
  } finally {
    await m.shutdown();
    worker.cleanup();
    dropMutant(name);
  }
});

// ---- edges the protocol must not get wrong ----------------------------------

test("a run that never spawned a worker is archived, not signalled", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  writeRun(root, "codex-neverspawned", {
    lane: "codex", terminal_at: null, server_pid: owner.pid, created_at: new Date().toISOString(),
  });
  await killAndReap(owner);
  const m = manager(root);
  try {
    const result = await m.cancel("codex-neverspawned");
    assert.equal(result.killed, false);
    assert.equal(result.worker_pid, null);
    assert.match(result.note!, /never spawned|no worker_pid/);
    assert.equal(readTelemetry(root, "codex-neverspawned").terminal_reason, "cancelled-foreign");
  } finally {
    await m.shutdown();
  }
});

test("a record that is already terminal is not written to AT ALL", async () => {
  // Cancelling a foreign run that already finished must not turn `done` into
  // `cancelled`: the work happened, and its outcome is a fact about the past
  // rather than a field the canceller gets to set.
  //
  // Cold review (codex-aed92) then took the rule further, and this test moved
  // with it: the old version kept every write EXCEPT the terminal fields — an
  // appended `error` line saying "a stranger visited". That is still a
  // read-modify-write of a file this process does not own, on the one code path
  // where the owner demonstrably wrote something a moment ago. The visit is
  // reported to the CALLER instead (archived/archive_reason/note), which is
  // where it is actionable; the dead owner's file is left alone.
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const planted = {
    lane: "codex", server_pid: owner.pid,
    terminal_at: "2026-07-28T00:00:00.000Z", terminal_reason: "done",
  };
  const dir = writeRun(root, "codex-finished", planted);
  fs.writeFileSync(path.join(dir, "result.md"), "# verdict\n\nthe real thing\n");
  await killAndReap(owner);
  const m = manager(root);
  try {
    const result = await m.cancel("codex-finished");
    assert.equal(result.status, "done", "a finished run stays finished");
    assert.equal(result.archived, false, "the adoption must say it wrote nothing");
    assert.match(result.archive_reason!, /owner wrote terminal first/);
    assert.match(result.note!, /record NOT archived/);

    assert.deepEqual(readTelemetry(root, "codex-finished"), planted, "byte-for-byte the owner's record");
    assert.equal(fs.readFileSync(path.join(dir, "result.md"), "utf8"), "# verdict\n\nthe real thing\n");
  } finally {
    await m.shutdown();
  }
});

test("the owner winning the race mid-cancel costs nothing: no stub in front of the real verdict", async () => {
  // The race the re-read is for. The record is in flight when cancelForeign
  // reads it, and goes terminal while the worker is being killed — exactly the
  // producer order run.ts uses (markTerminal → persistTelemetry, THEN
  // writeResultFileOnce), so at the moment adoption would write, the owner's
  // verdict file is one rename away. Adoption must not put a stub there.
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const worker = await spawnWorker({ ignoreTerm: true }); // survives SIGTERM, so the kill takes the full grace
  const dir = writeRun(root, "codex-raced", orphanTelemetry(owner.pid!, worker));
  await killAndReap(owner);
  const m = manager(root, 600);
  try {
    const pending = m.cancel("codex-raced");
    // The "owner" lands its terminal telemetry during the SIGTERM grace.
    setTimeout(() => {
      fs.writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify({
        lane: "codex", server_pid: owner.pid,
        terminal_at: "2026-07-29T00:00:00.000Z", terminal_reason: "done",
      }, null, 2));
    }, 150);
    const result = await pending;

    assert.equal(result.killed, true, "the worker still gets killed — the abandonment is only about writes");
    assert.equal(result.archived, false, "…and the record that appeared under it is left alone");
    assert.match(result.archive_reason!, /owner wrote terminal first/);
    const telemetry = readTelemetry(root, "codex-raced");
    assert.equal(telemetry.terminal_at, "2026-07-29T00:00:00.000Z", "the owner's terminal write is not lost");
    assert.equal(telemetry.terminal_reason, "done");
    assert.equal(telemetry.error, undefined, "no adoption line appended over it");
    assert.equal(fs.existsSync(path.join(dir, "result.md")), false, "no stub where the owner's verdict goes");
    assert.equal(result.status, "done");
  } finally {
    await m.shutdown();
    worker.cleanup();
  }
});

test("mutant: without the pre-write re-read, adoption edits the record the owner just wrote", async () => {
  // Restores the old rule — keep terminal_at, append the visit — and shows what
  // it costs: a file written by another process is read, modified and renamed
  // back after that process's own write landed.
  const name = "adopt-archive-no-reread";
  const mutated = await loadMutantManager(name, [
    {
      file: "adopt.ts",
      find: "  if (record.terminal_at) {\n    return {\n      archived: false,",
      replace: "  if (false) {\n    return {\n      archived: false,",
    },
    {
      file: "adopt.ts",
      find: "    record.terminal_at = nowIso;\n    record.terminal_reason = ADOPTED_TERMINAL_REASON;",
      replace:
        "    if (!record.terminal_at) { record.terminal_at = nowIso; record.terminal_reason = ADOPTED_TERMINAL_REASON; }",
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const planted = {
    lane: "codex", server_pid: owner.pid,
    terminal_at: "2026-07-28T00:00:00.000Z", terminal_reason: "done",
  };
  const dir = writeRun(root, "codex-finished", planted);
  fs.writeFileSync(path.join(dir, "result.md"), "# verdict\n\nthe real thing\n");
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 400,
  });
  try {
    await m.cancel("codex-finished");
    const telemetry = readTelemetry(root, "codex-finished");
    assert.notDeepEqual(telemetry, planted, "the mutant rewrites another process's file");
    assert.match(String(telemetry.error), /adopted and cancelled by Clanker server pid/);
  } finally {
    await m.shutdown();
    dropMutant(name);
  }
});

test("a genuinely unknown id still says not found, even now that adoption exists", async () => {
  const root = makeRunsRoot();
  const m = manager(root);
  try {
    await assert.rejects(() => m.cancel("codex-never-existed"), /not found/);
    await assert.rejects(() => m.wait("codex-never-existed", 10), /no record of it on disk/);
  } finally {
    await m.shutdown();
  }
});

test("prompt across sessions stays refused, dead owner or not", async () => {
  // Explicitly out of scope by design: a correction turn needs a live ACP
  // session, and no amount of disk forensics produces one. The refusal is the
  // feature.
  const root = makeRunsRoot();
  const owner = spawnIdle();
  writeRun(root, "codex-noprompt", { lane: "codex", terminal_at: null, server_pid: owner.pid });
  await killAndReap(owner);
  const m = manager(root);
  try {
    await assert.rejects(
      () => m.promptExisting("codex-noprompt", "one more turn", true),
      /belongs to a different Clanker server process/,
    );
  } finally {
    await m.shutdown();
  }
});

// ---- segment 3: degraded wait ----------------------------------------------

test("foreign wait, owner alive: still refused", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  writeRun(root, "codex-waitlive", { lane: "codex", terminal_at: null, server_pid: owner.pid });
  const m = manager(root);
  try {
    await assert.rejects(() => m.wait("codex-waitlive", 50), (error: Error) => {
      assert.match(error.message, /owner session is still alive/i);
      assert.doesNotMatch(error.message, /disk-poll/);
      return true;
    });
  } finally {
    await m.shutdown();
    await killAndReap(owner);
  }
});

test("foreign wait, owner dead: polls the disk and says that is what it did", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const runDir = writeRun(root, "codex-degraded", {
    lane: "codex", terminal_at: null, server_pid: owner.pid, observed_model: "gpt-5.3-codex-spark",
  });
  await killAndReap(owner);
  const m = manager(root);
  try {
    // Terminal state appears on disk mid-wait: the result must come back
    // because the file changed, which is the only thing "polling" can mean.
    const started = Date.now();
    const pending = m.wait("codex-degraded", 5_000);
    setTimeout(() => {
      fs.writeFileSync(path.join(runDir, "result.md"), "# verdict\n\nreal verdict bytes\n");
      fs.writeFileSync(path.join(runDir, "telemetry.json"), JSON.stringify({
        lane: "codex", server_pid: owner.pid, observed_model: "gpt-5.3-codex-spark",
        terminal_at: new Date().toISOString(), terminal_reason: "done",
      }));
    }, 400);
    const result = await pending;
    const elapsed = Date.now() - started;

    assert.equal(result.degraded, "disk-poll", "the caller must be able to see this was not observed");
    assert.equal(result.status, "done");
    assert.ok(elapsed >= 350 && elapsed < 5_000, `must have returned on the file change, not on the deadline (${elapsed}ms)`);
    assert.equal(result.digest, "", "there is no event stream, so there is no digest");
    assert.match(result.degraded_note!, /NO digest/, "and the payload must SAY there is none, not just omit it");
    assert.equal(result.observed_model, "gpt-5.3-codex-spark", "a silent model swap stays visible across the grave");
    // realpath (see the note on the archival test above): containment resolves
    // symlinks, and the resolved path is what the caller is handed.
    const realRunDir = fs.realpathSync(runDir);
    assert.equal(result.result_path, path.join(realRunDir, "result.md"));
    assert.ok((result.result_bytes ?? 0) > 0);
    assert.equal(result.run_dir, realRunDir);
    assert.equal(result.final_message, undefined, "nothing is synthesized: no final message exists on this path");
  } finally {
    await m.shutdown();
  }
});

test("foreign wait that times out reports the run as still running, without inventing progress", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  writeRun(root, "codex-stillgoing", { lane: "codex", terminal_at: null, server_pid: owner.pid });
  await killAndReap(owner);
  const m = manager(root);
  try {
    const result = await m.wait("codex-stillgoing", 300);
    assert.equal(result.status, "running");
    assert.equal(result.degraded, "disk-poll");
    assert.equal(result.digest, "");
    assert.match(result.plan_summary, /foreign run/);
    assert.equal(result.result_path, undefined);
  } finally {
    await m.shutdown();
  }
});

test("mutant: a foreign wait that does not re-read the record can only report the past", async () => {
  const name = "adopt-wait-no-poll";
  const mutated = await loadMutantManager(name, [
    {
      file: "manager.ts",
      find: "      foreign = readForeignRun(id, this.runsRoot) ?? foreign;",
      replace: "      /* mutant: never re-read the record */",
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const runDir = writeRun(root, "codex-degraded", { lane: "codex", terminal_at: null, server_pid: owner.pid });
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root,
  });
  try {
    const pending = m.wait("codex-degraded", 800);
    setTimeout(() => {
      fs.writeFileSync(path.join(runDir, "telemetry.json"), JSON.stringify({
        lane: "codex", server_pid: owner.pid, terminal_at: new Date().toISOString(), terminal_reason: "done",
      }));
    }, 150);
    const result = await pending;
    assert.equal(result.status, "running", "the mutant burns the whole budget and reports a stale record as in flight");
  } finally {
    await m.shutdown();
    dropMutant(name);
  }
});

// ---- the id is a path segment (#32 cold review, run codex-aed92) ------------

/**
 * A runs root with a neighbour beside it: `<parent>/runs` is what the manager
 * is given, `<parent>/elsewhere/codex-outside` is the record the caller is not
 * entitled to, reachable only by an id that climbs out.
 */
function rootWithOutsider(): { root: string; outsideDir: string; escapingId: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-adopt-traversal-"));
  const root = path.join(parent, "runs");
  const outsideDir = path.join(parent, "elsewhere", "codex-outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  return { root, outsideDir, escapingId: path.join("..", "elsewhere", "codex-outside") };
}

test("a traversing id reaches no record, so it can drive no write and no signal", async () => {
  // The read was never the point. `cancel` uses the record it reads to choose
  // the directory it archives INTO and the pid it considers signalling, so a
  // caller who can point `id` outside the runs root gets to nominate both.
  const { root, outsideDir, escapingId } = rootWithOutsider();
  const owner = spawnIdle();
  const decoy = spawnIdle(); // the pid the planted record nominates
  const planted = {
    lane: "codex", terminal_at: null, server_pid: owner.pid,
    worker_pid: decoy.pid, worker_started_at: Date.now(),
  };
  fs.writeFileSync(path.join(outsideDir, "telemetry.json"), JSON.stringify(planted, null, 2));
  await killAndReap(owner); // owner provably dead: every adoption gate is otherwise OPEN
  const m = manager(root);
  try {
    for (const call of [
      () => m.cancel(escapingId),
      () => m.wait(escapingId, 10),
      () => m.promptExisting(escapingId, "x", true),
    ]) {
      await assert.rejects(call, (error: Error) => {
        assert.match(error.message, /MALFORMED/, "a malformed id is its own answer, not 'not found'");
        assert.doesNotMatch(error.message, /no record of it on disk/, "no lookup happened, so none may be claimed");
        return true;
      });
    }
    assert.throws(() => m.status(escapingId), /MALFORMED/);

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(outsideDir, "telemetry.json"), "utf8")),
      planted,
      "the outsider's record must be byte-identical: no terminal_at, no adoption error line",
    );
    assert.deepEqual(fs.readdirSync(outsideDir), ["telemetry.json"], "no result.md stub outside the runs root");
    assert.ok(alive(decoy.pid!), "the nominated pid was never signalled");
  } finally {
    await m.shutdown();
    try { process.kill(decoy.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("mutant: pre-fix, that same id kills the nominated worker and archives outside the runs root", async () => {
  // The whole chain, proven end to end against the unguarded line: attacker
  // telemetry outside the root → group kill of the pid it names → adoption's
  // terminal record written into a directory the manager was never pointed at.
  const name = "adopt-traversal-unguarded";
  const mutated = await loadMutantManager(name, [
    {
      file: "foreign.ts",
      find:
        "  if (!isValidRunId(id)) return null;\n" +
        "  const runDir = containedRunDir(runsRoot, id);\n" +
        "  if (runDir === null) return null;",
      replace: "  const runDir = path.join(runsRoot, id);",
    },
  ]);
  const { root, outsideDir, escapingId } = rootWithOutsider();
  const owner = spawnIdle();
  const worker = await spawnWorker();
  fs.writeFileSync(
    path.join(outsideDir, "telemetry.json"),
    JSON.stringify(orphanTelemetry(owner.pid!, worker), null, 2),
  );
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 800,
  });
  try {
    const result = await m.cancel(escapingId);
    assert.equal(result.killed, true, "pre-fix, a planted record gets its nominated pid signalled");
    await until(() => !alive(worker.pid), 4_000);
    const after = JSON.parse(fs.readFileSync(path.join(outsideDir, "telemetry.json"), "utf8"));
    assert.equal(after.terminal_reason, "cancelled-foreign", "…and the write lands outside the runs root");
  } finally {
    await m.shutdown();
    worker.cleanup();
    dropMutant(name);
  }
});

// ---- the group is the only target (#32 cold review, run codex-aed92) --------

/**
 * A worker that is alive but LEADS NO GROUP — spawned without `detached`, so it
 * sits in this test process's group and `kill(-pid)` answers ESRCH while
 * `kill(pid, 0)` answers yes.
 *
 * That is exactly the shape a recycled pid presents to the adoption path: the
 * number is alive, the group it was supposed to lead is not. Real workers are
 * always detached (acp-client.ts), so nothing legitimate looks like this.
 */
async function spawnNonLeader(): Promise<{ pid: number; startedAt: number; cleanup: () => void }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  const startedAt = Date.now();
  child.unref();
  await until(() => alive(child.pid!), 4_000);
  assert.throws(() => process.kill(-child.pid!, 0), "fixture must NOT be a group leader");
  return {
    pid: child.pid!,
    startedAt,
    cleanup: () => { if (alive(child.pid!)) { try { process.kill(child.pid!, "SIGKILL"); } catch { /* raced */ } } },
  };
}

test("group kill ESRCH ends it: no bare-pid second attempt on a pid whose group is gone", async () => {
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const stranger = await spawnNonLeader();
  writeRun(root, "codex-recycledpid", {
    lane: "codex", host: "claude", terminal_at: null, server_pid: owner.pid,
    worker_pid: stranger.pid, worker_started_at: stranger.startedAt,
  });
  await killAndReap(owner);
  const m = manager(root, 400);
  try {
    const result = await m.cancel("codex-recycledpid");
    // Identity passed (the recorded start time is this pid's start time — that
    // is what pid reuse looks like from disk), so this is not the identity
    // guard doing the work. The group's absence is.
    assert.equal(result.identity_verified, true);
    assert.equal(result.killed, false, "no signal may be delivered to a pid whose group does not exist");
    assert.match(result.note!, /ESRCH/);
    assert.match(result.note!, /not this run's worker/);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(stranger.pid), "the surviving pid is a stranger and must be left alone");
    // The record still gets closed — an unsignalled orphan that stays on the
    // board forever is the failure archival exists to prevent.
    assert.equal(readTelemetry(root, "codex-recycledpid").terminal_reason, "cancelled-foreign");
    assert.equal(result.status, "cancelled");
  } finally {
    await m.shutdown();
    stranger.cleanup();
  }
});

test("mutant: the old bare-pid fallback signals exactly the process it must not", async () => {
  // Restores the deleted fallback verbatim in behaviour. Same fixture, and the
  // stranger dies — which is the whole reason the fallback is gone.
  const name = "adopt-bare-pid-fallback";
  const mutated = await loadMutantManager(name, [
    {
      file: "adopt.ts",
      find: "    const code = (error as NodeJS.ErrnoException).code;\n    return {\n      sent: null,",
      replace:
        "    const code = (error as NodeJS.ErrnoException).code;\n" +
        "    if (alive(pid)) {\n" +
        "      try { process.kill(pid, signal); return { sent: `${signal}→pid ${pid} (mutant fallback)` }; }\n" +
        "      catch { /* fall through to the honest answer */ }\n" +
        "    }\n" +
        "    return {\n      sent: null,",
    },
  ]);
  const root = makeRunsRoot();
  const owner = spawnIdle();
  const stranger = await spawnNonLeader();
  writeRun(root, "codex-recycledpid", {
    lane: "codex", host: "claude", terminal_at: null, server_pid: owner.pid,
    worker_pid: stranger.pid, worker_started_at: stranger.startedAt,
  });
  await killAndReap(owner);
  const m = new mutated.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root, cancelGraceMs: 400,
  });
  try {
    const result = await m.cancel("codex-recycledpid");
    assert.equal(result.killed, true, "the fallback delivers a signal…");
    await until(() => !alive(stranger.pid), 4_000);
    assert.ok(!alive(stranger.pid), "…straight into a process that is not the worker");
  } finally {
    await m.shutdown();
    stranger.cleanup();
    dropMutant(name);
  }
});
