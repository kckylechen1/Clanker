import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, type SpecResolver, type WaitResult } from "../src/manager.js";
import { INFRA_FAILURE_TAG } from "../src/failure-classifier.js";
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
    await m.promptExisting(id, "ordinary continuation");
    const continued = await waitTerminal(m, id);
    assert.equal(continued.telemetry?.prompt_usage, undefined, "turn-local prompt usage resets");
    assert.deepEqual(continued.telemetry?.session_usage, { used: 123, size: 4096, cost: { amount: 0.25, currency: "USD" } });
    assert.equal(continued.telemetry?.observed_model, "observed/model");
    assert.equal(continued.telemetry?.observed_effort, "high");
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
  // unbounded.
  const m = makeManager({ capacityRetryBackoffMs: 20 });
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
  } finally {
    await m.shutdown();
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
    assert.ok(elapsed < 1_000, `shutdown should wake backoff, elapsed=${elapsed}ms`);
    assert.equal(m.status(id).status, "cancelled");
    assert.equal(fs.readFileSync(counter, "utf8"), "1", "shutdown must not spawn attempt two");
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

test("dispatchKimiCrew fixes the single OpenCode lifecycle request", async () => {
  let capturedLane: string | undefined;
  let capturedOpts: LaneRequestOptions | undefined;
  const spy: SpecResolver = (lane, opts) => {
    capturedLane = lane;
    capturedOpts = opts;
    return fakeSpec();
  };
  const repo = makeCrewBaseRepo();
  const m = new LaneManager({ resolveSpec: spy, disableReaper: true, baseRepo: repo.base });
  const branch = `clanker/kimi-crew-test-${Date.now()}`;
  try {
    const { id } = await m.dispatchKimiCrew({ prompt: "implement and review", worktree: branch });
    assert.equal(capturedLane, "opencode");
    assert.equal(capturedOpts?.model, "kimi");
    assert.equal(capturedOpts?.readOnly, false);
    assert.equal(capturedOpts?.kimiCrew, true);
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
    for (const lane of ["codex", "opencode", "grok"] as const) {
      await assert.rejects(
        () => m.dispatchStart({ lane, model: "glm", prompt: "write", readOnly: false, worktree: "never-created" }),
        /GLM writes require clanker_dispatch_glm_write_start and Sonnet supervision/,
      );
    }
  } finally {
    await m.shutdown();
  }
});

test("CP2: write dispatch with cwd inside the base checkout is rejected", async () => {
  const m = makeManager(); // baseRepo = os.tmpdir()
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "codex",
          prompt: "do work",
          readOnly: false,
          worktree: "some-branch",
          cwd: os.tmpdir(),
        }),
      /inside the primary checkout/,
    );
  } finally {
    await m.shutdown();
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
    assert.ok(m.list().some((entry) => entry.id === id), "cooperative cancellation keeps the session available");
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
    await until(() => fs.existsSync(pidFile), 1000);
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

test("a reused session clears cancelled turn telemetry before the next successful turn", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "CANCELME", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).tool_calls >= 1, 4000);
    await m.cancel(id);
    assert.equal(m.status(id).telemetry?.terminal_reason, "cancelled");
    await m.promptExisting(id, "normal success", true);
    const running = m.status(id).telemetry!;
    assert.equal(running.terminal_at, undefined);
    assert.equal(running.terminal_reason, undefined);
    assert.equal(running.stop_reason, undefined);
    const done = await waitTerminal(m, id);
    assert.equal(done.status, "done");
    assert.equal(done.telemetry?.stop_reason, "end_turn");
    assert.equal(done.telemetry?.terminal_reason, "done");
    assert.equal(done.telemetry?.cancellation_requested, false);
    assert.equal(done.telemetry?.forced_kill, false);
    assert.equal(done.telemetry?.turns, 2);
    assert.equal(done.telemetry?.continuation_turns, 1);
    assert.equal(done.telemetry?.corrections, 1);
  } finally { await m.shutdown(); }
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
  await Promise.race([
    m.shutdown(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown deadlocked")), 1000)),
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

test("clanker_prompt reuses the session for a second turn", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "reuse-one", cwd: os.tmpdir(), readOnly: true });
    const r1 = await waitTerminal(m, id);
    assert.equal(r1.final_message, "reuse-one");

    await m.promptExisting(id, "reuse-two");
    const r2 = await waitTerminal(m, id);
    assert.equal(r2.status, "done");
    assert.equal(r2.final_message, "reuse-two");

    const entry = m.list().find((e) => e.id === id);
    assert.ok(entry, "run still listed while session alive");
    assert.equal(entry!.turns_count, 2);
    assert.equal(entry!.state, "idle");
  } finally {
    await m.shutdown();
  }
});

test("reaped session rejects clanker_prompt", async () => {
  const m = makeManager({ sessionTtlMs: 60 });
  try {
    const { id } = await m.dispatchStart({ lane: "opencode", prompt: "reap-me", cwd: os.tmpdir(), readOnly: true });
    await waitTerminal(m, id);
    await new Promise((r) => setTimeout(r, 120));
    const reaped = await m.reap();
    assert.ok(reaped.includes(id), "run should be reaped after idle TTL");
    assert.equal(m.list().find((e) => e.id === id), undefined, "reaped run drops off clanker_list");
    await assert.rejects(() => m.promptExisting(id, "too late"), /reaped|not found/);
  } finally {
    await m.shutdown();
  }
});
