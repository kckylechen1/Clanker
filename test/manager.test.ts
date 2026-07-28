import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, assertWorktreeOutsideRepo, type SpecResolver, type WaitResult } from "../src/manager.js";
import { ENV_DRIFT_TAG, INFRA_FAILURE_TAG } from "../src/failure-classifier.js";
import { LaneRun } from "../src/run.js";
import type { LaneRequestOptions } from "../src/types.js";
import { fakeResolver, fakeSpec, until } from "./helpers.js";

function makeCrewBaseRepo(): { base: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-kimi-crew-manager-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["clone", origin, base]);
  return { base, root };
}

function makeManager(
  opts: {
    stallThresholdMs?: number;
    sessionTtlMs?: number;
    turnTimeoutMs?: number;
    capacityRetryBackoffMs?: number;
    cancelGraceMs?: number;
    processTerminateGraceMs?: number;
  } = {},
) {
  return new LaneManager({
    resolveSpec: fakeResolver,
    disableReaper: true,
    baseRepo: os.tmpdir(),
    stallThresholdMs: opts.stallThresholdMs ?? 300_000,
    sessionTtlMs: opts.sessionTtlMs ?? 600_000,
    turnTimeoutMs: opts.turnTimeoutMs ?? 2_700_000,
    capacityRetryBackoffMs: opts.capacityRetryBackoffMs,
    cancelGraceMs: opts.cancelGraceMs,
    processTerminateGraceMs: opts.processTerminateGraceMs,
  });
}

async function waitTerminal(m: LaneManager, id: string, timeoutMs = 5000): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  let last!: WaitResult;
  while (Date.now() < deadline) {
    last = await m.wait(id, 200);
    if (last.status !== "running") return last;
  }
  return last;
}

test("dispatch start + wait completes with final_message = prompt", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "hello-lane", cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.final_message, "hello-lane");
  } finally {
    await m.shutdown();
  }
});

test("terminal telemetry observes ACP config and usage and is persisted atomically", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "opencode", prompt: "TELEMETRY", cwd: os.tmpdir(), readOnly: true, model: "glm" });
    const r = await waitTerminal(m, id);
    assert.equal(r.telemetry?.resolved_model, "zhipuai-coding-plan/glm-5.2");
    assert.equal(r.telemetry?.observed_model, "observed/model");
    assert.equal(r.telemetry?.observed_effort, "high");
    assert.deepEqual(r.telemetry?.session_usage, { used: 123, size: 4096, cost: { amount: 0.25, currency: "USD" } });
    assert.deepEqual(r.telemetry?.prompt_usage, {
      totalTokens: 15, inputTokens: 10, outputTokens: 5, thoughtTokens: 2,
      cachedReadTokens: 3, cachedWriteTokens: null,
    });
    assert.deepEqual(Object.keys(r.telemetry?.prompt_usage ?? {}).sort(),
      ["cachedReadTokens", "cachedWriteTokens", "inputTokens", "outputTokens", "thoughtTokens", "totalTokens"].sort());
    assert.ok((r.telemetry?.duration_ms ?? -1) >= 0);
    assert.equal(r.telemetry?.terminal_reason, "done");
    assert.equal(r.telemetry?.host, "standalone");
    assert.equal(r.telemetry?.requested_lane, "opencode");
    assert.equal(r.telemetry?.actual_lane, "opencode");
    const persisted = JSON.parse(fs.readFileSync(path.join(process.env.CLANKER_RUNS_ROOT!, id, "telemetry.json"), "utf8"));
    assert.equal(persisted.observed_model, "observed/model");
    assert.equal(m.status(id).telemetry?.tool_calls, 0);
  } finally { await m.shutdown(); }
});

test("plan events project into status + touched_files from tool locations", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "grok", prompt: "PLAN please", cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.ok(r.plan_final, "plan_final present");
    assert.equal(r.plan_final!.total, 3);
    assert.equal(r.plan_final!.completed, 1);
    assert.equal(r.plan_final!.inProgress, 1);
    assert.equal(r.plan_final!.pending, 1);
    assert.equal(r.plan_final!.currentStep, "write the accessor");
    assert.ok(
      (r.touched_files ?? []).some((f) => f.endsWith("planned.txt")),
      `touched_files should include planned.txt, got ${JSON.stringify(r.touched_files)}`,
    );
  } finally {
    await m.shutdown();
  }
});

/**
 * #32: the durable record has to name the processes involved, or a later
 * session that finds an in-flight run on disk can see it and still not touch
 * it. The three fields are written by exactly two places — the dispatch stub
 * (server_pid, manager.ts) and the spawn hook (worker pair, run.ts
 * noteWorkerSpawned) — and, this segment, read by nobody: the adoption
 * protocol that consumes them is a separate change. So the assertion has to be
 * that they are on disk, live, and true, while the worker is still running.
 */
test("#32: telemetry.json names the server pid and the live worker's pid/start time", async () => {
  const m = makeManager();
  try {
    // STALL never answers, so the worker is guaranteed alive while we look at it.
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "STALL forever", cwd: os.tmpdir(), readOnly: true });
    const telemetryPath = path.join(process.env.CLANKER_RUNS_ROOT!, id, "telemetry.json");
    const read = () => JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    await until(() => read().worker_pid !== undefined, 5_000);

    const t = read();
    assert.equal(t.server_pid, process.pid, "server_pid must be THIS process — the one holding the worker's stdio");
    assert.ok(Number.isInteger(t.worker_pid) && t.worker_pid > 0, `worker_pid must be a real pid, got ${t.worker_pid}`);
    assert.notEqual(t.worker_pid, process.pid, "the worker is a separate process, not the server");
    // The pid on disk must be the process that is actually running the lane,
    // not merely a number of the right shape.
    assert.doesNotThrow(() => process.kill(t.worker_pid, 0), "worker_pid must name a process that is alive right now");

    const createdAtMs = Date.parse(t.created_at);
    assert.ok(Number.isFinite(createdAtMs), "created_at must parse");
    assert.ok(
      Math.abs(t.worker_started_at - createdAtMs) < 60_000,
      `worker_started_at (${t.worker_started_at}) must be ms-epoch near created_at (${createdAtMs})`,
    );
    assert.ok(t.worker_started_at <= Date.now(), "worker_started_at must not be in the future");
  } finally {
    await m.shutdown();
  }
});

test("a read-only run's touched_files does NOT pick up a tool_call's read-kind location", async () => {
  // codex-212e2 (a read-only cold-review dispatch) reported a pile of `src/`
  // files as touched_files on a tree with ZERO actual diff: the ACP
  // "follow-along" `locations` signal fires on reads exactly like writes
  // (kind: "read" vs "edit"), and toolTouchedFiles() used to union in every
  // reported location regardless of kind. A read-only dispatch never has a
  // real write signal to report, so its touched_files must come back empty
  // even though the fake agent below reports a location (see READTOOL in
  // fake-acp-agent.mjs, kind: "read").
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "READTOOL src/looked-at.ts",
      cwd: os.tmpdir(),
      readOnly: true,
    });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.deepEqual(r.touched_files, [], "a read-kind location must never surface as touched_files");
  } finally {
    await m.shutdown();
  }
});

test("clanker_wait returns early on event arrival (long-poll wakes on events)", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "opencode", prompt: "SLOW stream", cwd: os.tmpdir(), readOnly: true });
    // A 3s-budget wait must return well before the budget because events arrive.
    const t0 = Date.now();
    const first = await m.wait(id, 3000);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2500, `first wait should return early on events, took ${elapsed}ms`);

    let digest = first.digest;
    let r = first;
    while (r.status === "running") {
      r = await m.wait(id, 1000);
      digest += "\n" + r.digest;
    }
    assert.equal(r.status, "done");
    assert.ok(digest.includes("first-chunk-marker"), "digest should carry streamed message text");
    assert.ok(digest.includes("second-chunk-marker"), "digest should carry later message text");
  } finally {
    await m.shutdown();
  }
});

test("quiet mode (default): a lone tool_call (grep/read-shaped) does not cut a wait short", async () => {
  // Stall threshold parked far above the wait budget so this isolates the
  // "trivial tool_call event alone" case from suspected-stall wake-ups.
  const m = makeManager({ stallThresholdMs: 60_000 });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "STALL now", cwd: os.tmpdir(), readOnly: true });
    // "STALL now" emits exactly one tool_call, then the fake agent hangs
    // forever — the shape of "codex fires a tool_call for every grep/read".
    await until(() => m.status(id).tool_calls >= 1, 4000);
    // Prime-drain: turn_start is itself a significant digest entry, so the
    // very first wait on a fresh run always wakes fast regardless of quiet
    // mode. Drain it here so the *timed* wait below measures only what
    // happens during it (the lone trivial tool_call — nothing else).
    const primed = await m.wait(id, 50);
    assert.ok(primed.digest.includes("stalling tool"), "priming drain picks up the trivial tool_call digest");

    const t0 = Date.now();
    const r = await m.wait(id, 400); // quiet defaults to true; nothing new arrives during this window
    const elapsed = Date.now() - t0;
    assert.equal(r.status, "running");
    assert.ok(
      elapsed >= 350,
      `quiet-mode wait should block to (near) the 400ms budget since only a trivial event happened, took ${elapsed}ms`,
    );
  } finally {
    await m.shutdown();
  }
});

test("quiet:false restores the legacy any-event wake-up on the same trivial tool_call", async () => {
  const m = makeManager({ stallThresholdMs: 60_000 });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "STALL now", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).tool_calls >= 1, 4000);
    const t0 = Date.now();
    const r = await m.wait(id, 2000, false);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, "running");
    assert.ok(elapsed < 1000, `quiet:false should wake immediately on the trivial event, took ${elapsed}ms`);
  } finally {
    await m.shutdown();
  }
});

test("quiet mode: a trivial tool_call doesn't wake a wait, but a later plan event does", async () => {
  // TRICKLE emits one trivial tool_call, then ~150ms later a significant
  // plan update, then ends the turn — proving both halves of the debounce
  // contract inside a single live wait: the trivial event doesn't cut it
  // short, the significant one does (well before the much larger budget).
  const m = makeManager({ stallThresholdMs: 60_000 });
  try {
    const { id } = await m.dispatchStart({ lane: "opencode", prompt: "TRICKLE please", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).tool_calls >= 1, 4000);
    const primed = await m.wait(id, 50); // drain turn_start + the trivial tool_call
    assert.equal(primed.status, "running");

    const t0 = Date.now();
    const r = await m.wait(id, 2000); // budget far larger than the ~150ms plan delay
    const elapsed = Date.now() - t0;
    assert.equal(r.status, "running");
    assert.ok(
      elapsed < 1000,
      `the plan event should wake the quiet-mode wait well before the 2000ms budget, took ${elapsed}ms`,
    );
    assert.notEqual(r.plan_summary, "no plan yet", "plan should be projected by the time this wait returns");
  } finally {
    await m.shutdown();
  }
});

test("silence flags suspected_stall (warning) then the turn timeout forces a terminal state", async () => {
  // CP1: suspected_stall stays a warning, but a silent turn must still reach a
  // terminal state — here via the hard per-turn timeout.
  const m = makeManager({ stallThresholdMs: 150, turnTimeoutMs: 1500 });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "STALL now", cwd: os.tmpdir(), readOnly: true });
    // Ensure the tool_call event is ingested, then drain pending digest.
    await until(() => m.status(id).tool_calls >= 1, 4000);
    await m.wait(id, 300);
    // Silent: warning fires while still running.
    const warning = await m.wait(id, 400);
    assert.equal(warning.status, "running");
    assert.equal(warning.suspected_stall, true);
    assert.ok(warning.last_event_age_ms >= 150);
    // The turn timeout provides the guaranteed terminal path.
    const terminal = await waitTerminal(m, id, 4000);
    assert.equal(terminal.status, "error");
    assert.match(terminal.error ?? "", /CLANKER_TURN_TIMEOUT_MS/);
  } finally {
    await m.shutdown();
  }
});

test("CP1: a subprocess that exits mid-turn drives the run to error and dispatch returns", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "grok", prompt: "CRASH now", cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id, 5000);
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /exited mid-turn/);
  } finally {
    await m.shutdown();
  }
});

/**
 * #37: the 2026-07-28 shape end to end — the command a long-lived server spawns
 * is gone, so connect() never gets a process at all. That failure used to be
 * the ONE terminal path carrying no failure_class, which is how an environment
 * break reached the dispatcher wearing a task failure's clothes.
 */
test("#37: a spawn ENOENT reaches the dispatcher tagged CLANKER-ENV-DRIFT", async () => {
  const gone = path.join(os.tmpdir(), "clanker-node-bumped-away", "bin", "node");
  const m = new LaneManager({
    resolveSpec: () => ({ command: gone, args: ["whatever.mjs"], env: {}, warnings: [] }),
    disableReaper: true,
    baseRepo: os.tmpdir(),
  });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "hello", cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id, 5000);
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /ENOENT/);
    assert.equal(r.failure_class, ENV_DRIFT_TAG, "an ENOENT spawn is the environment, not the task");
    assert.equal(m.status(id).failure_class, ENV_DRIFT_TAG, "status must carry the same verdict as wait");
  } finally {
    await m.shutdown();
  }
});

test("a turn-1, zero-tool-call API-schema-rejection is tagged CLANKER-INFRA-FAILURE on both wait and status, and is never retried", async () => {
  // capacityRetryBackoffMs is set high enough that a retry (which must NOT
  // happen for this failure class) would blow the test timeout, making a
  // wrongful retry fail loudly rather than silently passing.
  const m = makeManager({ capacityRetryBackoffMs: 10_000 });
  try {
    const t0 = Date.now();
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "SCHEMA400 please", cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id, 5000);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, "error");
    assert.equal(r.failure_class, INFRA_FAILURE_TAG);
    assert.match(r.error ?? "", /CLANKER-INFRA-FAILURE/);
    assert.match(r.error ?? "", /重试无益/);
    assert.ok(elapsed < 3000, `INFRA-FAILURE must fail fast, no retry backoff; took ${elapsed}ms`);

    const status = m.status(id);
    assert.equal(status.status, "error");
    assert.equal(status.failure_class, INFRA_FAILURE_TAG);
    assert.match(status.error ?? "", /CLANKER-INFRA-FAILURE/);
  } finally {
    await m.shutdown();
  }
});

test("a capacity-transient first-turn failure auto-retries once (after backoff) and succeeds", async () => {
  const m = makeManager({ capacityRetryBackoffMs: 30 });
  try {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-capacity-"));
    const markerPath = path.join(markerDir, "attempted");
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: `CAPACITY_ONCE ${markerPath}`,
      cwd: os.tmpdir(),
      readOnly: true,
    });

    let digest = "";
    let r = await m.wait(id, 500);
    digest += r.digest;
    while (r.status === "running") {
      r = await m.wait(id, 500);
      digest += "\n" + r.digest;
    }

    assert.equal(r.status, "done");
    assert.ok(
      r.final_message?.includes("capacity-retry-succeeded"),
      `expected the second-attempt success marker, got ${JSON.stringify(r.final_message)}`,
    );
    assert.ok(
      digest.includes("transient backend failure, retrying"),
      `expected a retry note in the digest, got: ${JSON.stringify(digest)}`,
    );
    assert.ok(fs.existsSync(markerPath), "marker file written by the first (failing) attempt should exist");
    assert.equal(r.failure_class, undefined, "a recovered retry must not carry a terminal failure_class");
  } finally {
    await m.shutdown();
  }
});

test("a capacity-transient failure on the SECOND attempt is not retried again (single-retry cap)", async () => {
  // No marker file ever gets created by this scenario keyword, so every
  // attempt "at capacity"s — proves the retry budget is exactly one, not
  // unbounded. status=error + /capacity/i alone is also satisfied by an
  // implementation that retries 5 times before giving up, so pin the actual
  // attempt count via the CLANKER_TEST_ATTEMPT_COUNTER mechanism used below
  // (:341+): exactly 2 (first attempt + one retry), never more.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-capacity-cap-"));
  const counter = path.join(dir, "attempts");
  const m = new LaneManager({
    resolveSpec: () => fakeSpec({ CLANKER_TEST_ATTEMPT_COUNTER: counter }),
    disableReaper: true,
    baseRepo: os.tmpdir(),
    capacityRetryBackoffMs: 20,
  });
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "CAPACITY_ALWAYS please",
      cwd: os.tmpdir(),
      readOnly: true,
    });
    const r = await waitTerminal(m, id, 5000);
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /capacity/i);
    assert.equal(fs.readFileSync(counter, "utf8"), "2", "exactly first attempt + one retry, no more");
  } finally {
    await m.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown wakes capacity backoff immediately without spawning attempt two", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-backoff-shutdown-"));
  const counter = path.join(dir, "attempts");
  const backoffMs = 4_000;
  const m = new LaneManager({
    resolveSpec: () => fakeSpec({ CLANKER_TEST_ATTEMPT_COUNTER: counter }),
    disableReaper: true,
    baseRepo: os.tmpdir(),
    capacityRetryBackoffMs: backoffMs,
  });
  try {
    const { id } = await m.dispatchStart({
      lane: "codex", prompt: "CAPACITY_ALWAYS please", cwd: os.tmpdir(), readOnly: true,
    });
    await until(() => m.status(id).telemetry?.retries === 1, 2_000);
    const started = Date.now();
    await m.shutdown();
    const elapsed = Date.now() - started;
    // Upper bound is generous (not tight-1s) because it includes OS process
    // teardown, not just this process's backoff-wake logic — see #29-class
    // note in test/gemini-acp.test.ts:285-297.
    assert.ok(elapsed < 5_000, `shutdown should wake backoff, elapsed=${elapsed}ms`);
    assert.equal(m.status(id).status, "cancelled");
    assert.equal(fs.readFileSync(counter, "utf8"), "1", "shutdown must not spawn attempt two");
  } finally {
    await m.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel wakes capacity backoff immediately without spawning attempt two", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-backoff-cancel-"));
  const counter = path.join(dir, "attempts");
  const backoffMs = 4_000;
  const m = new LaneManager({
    resolveSpec: () => fakeSpec({ CLANKER_TEST_ATTEMPT_COUNTER: counter }),
    disableReaper: true,
    baseRepo: os.tmpdir(),
    capacityRetryBackoffMs: backoffMs,
  });
  try {
    const { id } = await m.dispatchStart({
      lane: "codex", prompt: "CAPACITY_ALWAYS please", cwd: os.tmpdir(), readOnly: true,
    });
    await until(() => m.status(id).telemetry?.retries === 1, 2_000);
    const started = Date.now();
    m.cancel(id);
    await until(() => m.status(id).status === "cancelled", 1_000);
    const elapsed = Date.now() - started;
    // Upper bound is generous (not tight-1s) because it includes OS process
    // teardown, not just this process's backoff-wake logic — see #29-class
    // note in test/gemini-acp.test.ts:285-297.
    assert.ok(elapsed < 5_000, `cancel should wake backoff, elapsed=${elapsed}ms`);
    assert.equal(fs.readFileSync(counter, "utf8"), "1", "cancel must not spawn attempt two");
  } finally {
    await m.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatchStart forwards a strict sandbox override through to the spec resolver", async () => {
  // Regression coverage: dispatchStart's LaneRequestOptions construction once
  // dropped `sandbox` on the floor (only model/effort/readOnly were forwarded)
  // — a resolveSpec spy is the only way to catch that class of gap, since
  // buildSpawnSpec-level unit tests can't see whether the manager ever calls
  // it with the field populated.
  let capturedOpts: LaneRequestOptions | undefined;
  const spy: SpecResolver = (_lane, opts) => {
    capturedOpts = opts;
    return fakeSpec();
  };
  const m = new LaneManager({ resolveSpec: spy, disableReaper: true, baseRepo: os.tmpdir() });
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "hi",
      cwd: os.tmpdir(),
      readOnly: true,
      sandbox: "read-only",
    });
    assert.equal(capturedOpts?.sandbox, "read-only");
    // fakeSpec() spawns a real fake-agent process via the fire-and-forget
    // driveNewSession chain; wait for it to reach a terminal state so
    // shutdown() below actually has a live connection to close (otherwise
    // the connect+turn races past this test's own lifecycle and orphans the
    // child process into whichever test runs next).
    await waitTerminal(m, id);
  } finally {
    await m.shutdown();
  }
});

test("kimi-crew profile fixes the single OpenCode lifecycle request", async () => {
  let capturedLane: string | undefined;
  let capturedOpts: LaneRequestOptions | undefined;
  const spy: SpecResolver = (lane, opts) => {
    capturedLane = lane;
    capturedOpts = opts;
    return fakeSpec();
  };
  const repo = makeCrewBaseRepo();
  const m = new LaneManager({ resolveSpec: spy, disableReaper: true, baseRepo: repo.base });
  const branch = `clanker/kimi-crew-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode", profile: "kimi-crew", prompt: "implement and review", worktree: branch,
    });
    assert.equal(capturedLane, "opencode");
    assert.equal(capturedOpts?.model, "kimi");
    assert.equal(capturedOpts?.readOnly, false);
    assert.equal(capturedOpts?.profile, "kimi-crew");
    await waitTerminal(m, id);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("CP2: write dispatch without a worktree is rejected", async () => {
  const m = makeManager();
  try {
    await assert.rejects(
      () => m.dispatchStart({ lane: "codex", prompt: "do work", readOnly: false }),
      /must run in an isolated worktree/,
    );
  } finally {
    await m.shutdown();
  }
});

test("CP2: a Codex read-only request with a write-capable sandbox still requires isolation", async () => {
  const m = makeManager();
  try {
    for (const sandbox of ["workspace-write", "danger-full-access"] as const) {
      await assert.rejects(
        () => m.dispatchStart({ lane: "codex", prompt: "review", readOnly: true, sandbox }),
        /write-capable dispatch must run in an isolated worktree/,
      );
    }
  } finally {
    await m.shutdown();
  }
});

test("manager requires explicit external write models and rejects unsupervised GLM on every lane", async () => {
  const m = makeManager();
  try {
    for (const lane of ["opencode", "grok"] as const) {
      await assert.rejects(
        () => m.dispatchStart({ lane, prompt: "write", readOnly: false, worktree: "never-created" }),
        new RegExp(`explicit model is required for write lane '${lane}'`),
      );
    }
    // The GLM gate is lane-agnostic on purpose — including on lanes whose own
    // backend pins a default model and therefore skips the loop above.
    for (const lane of ["codex", "opencode", "grok", "cursor"] as const) {
      await assert.rejects(
        () => m.dispatchStart({ lane, model: "glm", prompt: "write", readOnly: false, worktree: "never-created" }),
        /direct GLM write is prohibited; use profile='kimi-crew'/,
      );
    }
  } finally {
    await m.shutdown();
  }
});

test("CP2/#12: write dispatch whose cwd is not inside a git work tree is rejected loudly", async () => {
  // The host baseRepo is a REAL repo and the cwd is a real directory that is NOT
  // a git work tree AND is distinct from the host. Pre-#12 the manager's only
  // gate compared cwd against the host baseRepo, so this cwd passed it and the
  // manager silently cut the worktree from the host — no rejection at all. The
  // ONLY thing that can reject here now is resolveTargetRepo refusing a non-repo
  // cwd, so the assertion exercises that behavior, not a coincidental message.
  const host = makeCrewBaseRepo();
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-nonrepo-"));
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: host.base });
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "codex",
          prompt: "do work",
          readOnly: false,
          worktree: "nonrepo-branch",
          cwd: nonRepo,
        }),
      /not inside a git work tree/,
    );
  } finally {
    await m.shutdown();
    fs.rmSync(host.root, { recursive: true, force: true });
    fs.rmSync(nonRepo, { recursive: true, force: true });
  }
});

test("#12: assertWorktreeOutsideRepo rejects a worktree inside the target repo (literal + symlink)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-repo-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-out-"));
  try {
    // Literal: a worktree path inside the repo — or equal to it — is rejected.
    assert.throws(() => assertWorktreeOutsideRepo(path.join(repo, "wt"), repo), /overlaps the target repo/);
    assert.throws(() => assertWorktreeOutsideRepo(repo, repo), /overlaps the target repo/);
    // A genuinely-outside worktree path is allowed.
    assert.doesNotThrow(() => assertWorktreeOutsideRepo(path.join(outside, "wt"), repo));
    // Symlink bypass: a link whose LITERAL string is outside the repo but which
    // resolves INTO the repo must still be rejected (realpath hardening).
    const link = path.join(outside, "sneaky-link");
    fs.symlinkSync(repo, link); // link -> repo
    assert.throws(() => assertWorktreeOutsideRepo(path.join(link, "wt"), repo), /overlaps the target repo/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("#12: read-only dispatch with cwd+worktree also cuts from the cwd's repo, not the host", async () => {
  // The read-only path creates a worktree too (params.worktree) but does not
  // "require isolation". Pre-fix the targetRepo resolution was gated on
  // requiresIsolation, so this path skipped it and cut from the host baseRepo —
  // ignoring the explicit cwd. The resolution condition must match the creation
  // condition (params.worktree && params.cwd), read-only included.
  const host = makeCrewBaseRepo();
  const target = makeCrewBaseRepo();
  const targetOrigin = execFileSync("git", ["-C", target.base, "config", "--get", "remote.origin.url"])
    .toString()
    .trim();
  const hostOrigin = execFileSync("git", ["-C", host.base, "config", "--get", "remote.origin.url"])
    .toString()
    .trim();
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: host.base });
  const branch = `clanker/ro-xrepo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "read-only isolate",
      readOnly: true,
      worktree: branch,
      cwd: target.base,
    });
    const wt = m.status(id).worktree;
    assert.ok(wt, "a worktree path was created for the read-only dispatch");
    const wtOrigin = execFileSync("git", ["-C", wt!, "config", "--get", "remote.origin.url"])
      .toString()
      .trim();
    assert.equal(wtOrigin, targetOrigin, "read-only worktree cut from the target repo");
    assert.notEqual(wtOrigin, hostOrigin, "read-only worktree NOT cut from the host baseRepo");
    await waitTerminal(m, id);
  } finally {
    await m.shutdown();
    fs.rmSync(host.root, { recursive: true, force: true });
    fs.rmSync(target.root, { recursive: true, force: true });
  }
});

test("#12: write dispatch cuts its worktree from the cwd's repo, not the host baseRepo", async () => {
  // Two independent repos: the host baseRepo the server launched from, and a
  // SECOND repo the dispatch targets via cwd. Pre-fix, the worktree was always
  // cut from the host — so the worker's cwd was a worktree of the wrong repo,
  // and the target repo's primary checkout was the one that got polluted.
  const host = makeCrewBaseRepo();
  const target = makeCrewBaseRepo();
  const targetOrigin = execFileSync("git", ["-C", target.base, "config", "--get", "remote.origin.url"])
    .toString()
    .trim();
  const hostOrigin = execFileSync("git", ["-C", host.base, "config", "--get", "remote.origin.url"])
    .toString()
    .trim();
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: host.base });
  const branch = `clanker/xrepo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "isolate me",
      readOnly: false,
      worktree: branch,
      cwd: target.base,
    });
    const wt = m.status(id).worktree;
    assert.ok(wt, "a worktree path was created");
    // (a) the created worktree belongs to the SECOND (target) repo.
    const wtOrigin = execFileSync("git", ["-C", wt!, "config", "--get", "remote.origin.url"])
      .toString()
      .trim();
    assert.equal(wtOrigin, targetOrigin, "worktree cut from the target repo");
    assert.notEqual(wtOrigin, hostOrigin, "worktree NOT cut from the host baseRepo");
    // (b) the target repo's primary checkout stays clean.
    const dirty = execFileSync("git", ["-C", target.base, "status", "--porcelain"]).toString();
    assert.equal(dirty, "", "target repo primary checkout stays clean");
    await waitTerminal(m, id);
  } finally {
    await m.shutdown();
    fs.rmSync(host.root, { recursive: true, force: true });
    fs.rmSync(target.root, { recursive: true, force: true });
  }
});

test("CP5: read-only declines a write-permission request instead of approving it", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      prompt: "PERMWRITE please",
      cwd: os.tmpdir(),
      readOnly: true,
    });
    const r = await waitTerminal(m, id, 5000);
    assert.equal(r.status, "done");
    assert.equal(r.final_message, "PERMISSION_DENIED");
  } finally {
    await m.shutdown();
  }
});

test("CP6: a second concurrent clanker_wait on the same id is rejected", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "STALL now", cwd: os.tmpdir(), readOnly: true });
    const first = m.wait(id, 500);
    await assert.rejects(() => m.wait(id, 500), /already in progress/);
    await first;
  } finally {
    await m.shutdown();
  }
});

test("clanker_cancel maps a cancelled turn to status cancelled", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "grok", prompt: "CANCELME long", cwd: os.tmpdir(), readOnly: true });
    // Wait until the tool_call event has been ingested.
    await until(() => m.status(id).tool_calls >= 1, 4000);
    await m.cancel(id);
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "cancelled");
    assert.equal(r.telemetry?.forced_kill, false);
    assert.equal(
      m.list().some((entry) => entry.id === id),
      false,
      "one-shot cooperative cancellation closes the ACP session",
    );
  } finally {
    await m.shutdown();
  }
});

test("cancel during handshake waits for child exit and cannot publish a late connection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-pending-cancel-"));
  const pidFile = path.join(dir, "pid");
  const exitMarker = path.join(dir, "exited");
  const m = new LaneManager({
    resolveSpec: () => fakeSpec({
      CLANKER_TEST_HANDSHAKE_DELAY_MS: "250", CLANKER_TEST_PID_FILE: pidFile,
      CLANKER_TEST_EXIT_MARKER: exitMarker,
    }),
    disableReaper: true, baseRepo: os.tmpdir(), processTerminateGraceMs: 40,
  });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "too late", cwd: os.tmpdir(), readOnly: true });
    await until(() => fs.existsSync(pidFile), 10_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const result = await m.cancel(id);
    assert.equal(result.status, "cancelled");
    assert.ok(fs.existsSync(exitMarker), "cancel resolves only after the pending child handles termination");
    assert.equal(fs.readFileSync(exitMarker, "utf8"), String(pid));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(m.status(id).status, "cancelled");
    assert.equal(m.status(id).error, undefined);
    assert.equal(m.list().some((entry) => entry.id === id), false);
  } finally {
    await m.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ignored cancel activity cannot shorten grace; forced cancel awaits exit and stays terminal", async () => {
  const terminateGraceMs = 80;
  const m = new LaneManager({
    resolveSpec: (_lane, _opts, _runDir) => fakeSpec({ CLANKER_TEST_IGNORE_SIGTERM: "1" }),
    disableReaper: true, baseRepo: os.tmpdir(), cancelGraceMs: 90,
    processTerminateGraceMs: terminateGraceMs, turnTimeoutMs: 5_000,
  });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "STALL_ACTIVITY forever", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).tool_calls === 1, 4000);
    const started = Date.now();
    const result = await m.cancel(id);
    const elapsed = Date.now() - started;
    assert.equal(result.status, "cancelled");
    assert.ok(elapsed >= 75, `ordinary activity must not shorten 90ms grace (elapsed=${elapsed}ms)`);
    assert.ok(elapsed >= terminateGraceMs, `cancel must await SIGKILL-backed actual exit (elapsed=${elapsed}ms)`);
    assert.equal(m.status(id).telemetry?.forced_kill, true);
    assert.equal(m.list().some((entry) => entry.id === id), false, "forced cancellation must close the live session");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(m.status(id).status, "cancelled", "late runTurn failure must not overwrite cancellation");
  } finally { await m.shutdown(); }
});

test("shutdown terminates an active initial turn without deadlocking on its drive", async () => {
  const m = makeManager({ processTerminateGraceMs: 40 });
  const { id } = await m.dispatchStart({
    lane: "codex", prompt: "STALL during shutdown", cwd: os.tmpdir(), readOnly: true,
  });
  await until(() => m.status(id).tool_calls === 1, 4000);
  // 10s upper bound, not a deadlock detector: this waits on the OS actually
  // tearing down the terminated child process, not on this process's own
  // logic hanging — same class as #29 (test/gemini-acp.test.ts:285-297).
  await Promise.race([
    m.shutdown(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("shutdown did not settle within 10000ms")), 10_000),
    ),
  ]);
  assert.equal(m.status(id).status, "cancelled");
  assert.equal(m.list().some((entry) => entry.id === id), false);
  await assert.rejects(
    m.dispatchStart({ lane: "codex", prompt: "too late", cwd: os.tmpdir(), readOnly: true }),
    /shutting down/,
  );
});

test("telemetry persistence failure reports run id, path, and error on stderr", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-telemetry-fail-"));
  const invalidRunDir = path.join(parent, "not-a-directory");
  fs.writeFileSync(invalidRunDir, "file");
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  try {
    const run = new LaneRun({ id: "telemetry-failure-run", lane: "codex", cwd: os.tmpdir(),
      runDir: invalidRunDir, readOnly: true });
    run.requestCancellation();
  } finally {
    console.error = original;
    fs.rmSync(parent, { recursive: true, force: true });
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /telemetry-failure-run/);
  assert.match(messages[0], /telemetry\.json/);
  assert.match(messages[0], /ENOTDIR|not a directory/i);
});

test("reaper is idempotent after one-shot completion already closed the run", async () => {
  const m = makeManager({ sessionTtlMs: 60 });
  try {
    const { id } = await m.dispatchStart({ lane: "opencode", prompt: "reap-me", cwd: os.tmpdir(), readOnly: true });
    await waitTerminal(m, id);
    assert.equal(m.list().find((e) => e.id === id), undefined, "completion closes the run immediately");
    const reaped = await m.reap();
    assert.equal(reaped.includes(id), false, "reaper must not report an already-closed run again");
  } finally {
    await m.shutdown();
  }
});

test("reap() closes a supervised session's idle-past-TTL run and drops it from list()", async () => {
  // Unlike the one-shot run above, a supervised run (manager.ts:701) stays
  // open past its terminal turn — reap() is the only thing that ever closes
  // it, so this is the one path that actually exercises manual reaping rather
  // than reap() finding nothing to do.
  const repo = makeCrewBaseRepo();
  const m = new LaneManager({
    resolveSpec: () => fakeSpec(),
    disableReaper: true,
    baseRepo: repo.base,
    sessionTtlMs: 50,
  });
  try {
    const { id } = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "implement the frozen spec",
      worktree: `clanker/reap-${Math.random().toString(36).slice(2, 8)}`,
    });
    await until(() => m.status(id).status !== "running", 6_000);
    assert.ok(m.list().find((e) => e.id === id), "the supervised session must still be open right after its turn ends");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const reaped = await m.reap();
    assert.deepEqual(reaped, [id]);
    assert.equal(m.list().find((e) => e.id === id), undefined, "reap() must close the session (list() drops it)");
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("with the reaper enabled, a manager that was never dispatched to shuts down without hanging", async () => {
  // No dispatch at all — this is purely "does an enabled reaper's setInterval
  // keep the event loop (and thus `node --test`) alive forever", the thing
  // `.unref()` (manager.ts:225) exists to prevent. Deliberately NOT waiting
  // out a real reaper period (min 5s, manager.ts:223): the regression this
  // guards is a deleted `.unref()`, which would not fail shutdown() itself —
  // it would silently hang the whole test-file process after the last test —
  // so the race below is a fast, deterministic proxy, not a real-time wait.
  const m = new LaneManager({ resolveSpec: fakeResolver, baseRepo: os.tmpdir() });
  await Promise.race([
    m.shutdown(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("shutdown with reaper enabled hung")), 2_000),
    ),
  ]);
});
