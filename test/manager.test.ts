import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, type SpecResolver, type WaitResult } from "../src/manager.js";
import { INFRA_FAILURE_TAG } from "../src/failure-classifier.js";
import type { LaneRequestOptions } from "../src/types.js";
import { fakeResolver, fakeSpec, until } from "./helpers.js";

function makeManager(
  opts: {
    stallThresholdMs?: number;
    sessionTtlMs?: number;
    turnTimeoutMs?: number;
    capacityRetryBackoffMs?: number;
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

test("dispatchStart forwards the sandbox override through to the spec resolver", async () => {
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
      sandbox: "workspace-write",
    });
    assert.equal(capturedOpts?.sandbox, "workspace-write");
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
  } finally {
    await m.shutdown();
  }
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

// ---- #6: LaneManager runs/warningsById GC (memory-leak fix) --------------
//
// Prior to this fix, close() only ever flipped `sessionClosed`, never
// deleted the run's `runs`/`warningsById` map entries — every dispatched run
// stayed resident in this stdio server's memory for the process lifetime.
// A private-field cast is used here (not new public API) purely to make the
// map-entry deletion itself directly observable, on top of the black-box
// proof (status()/wait() now genuinely throw "not found" post-GC, a real
// behavior change from before this fix, where they'd return the closed run's
// last state forever).

function mapsOf(m: LaneManager): { runs: Map<string, unknown>; warningsById: Map<string, unknown> } {
  return m as unknown as { runs: Map<string, unknown>; warningsById: Map<string, unknown> };
}

test("#6: a closed non-seat run's map entries survive the tick it closed in, then are freed on the NEXT reap tick", async () => {
  const m = makeManager({ sessionTtlMs: 60 });
  try {
    const { id } = await m.dispatchStart({ lane: "opencode", prompt: "gc-me", cwd: os.tmpdir(), readOnly: true });
    await waitTerminal(m, id);
    assert.ok(mapsOf(m).runs.has(id), "run present immediately after dispatch completes");

    await new Promise((r) => setTimeout(r, 120));
    const firstReap = await m.reap();
    assert.ok(firstReap.includes(id), "idle-TTL close happens on this tick");

    // Not deleted yet — a caller mid-poll (clanker_wait/clanker_status) right
    // after the auto/idle-close must still be able to read the terminal
    // result; that's the whole reason deletion is deferred to the *next*
    // tick instead of living inside close() itself.
    assert.ok(mapsOf(m).runs.has(id), "run entry NOT deleted on the same tick it closed in");
    assert.ok(mapsOf(m).warningsById.has(id), "warningsById entry NOT deleted on the same tick it closed in");
    const statusAfterFirstReap = m.status(id);
    assert.equal(statusAfterFirstReap.status, "done", "status() still readable right after the closing tick");

    const secondReap = await m.reap();
    assert.ok(!secondReap.includes(id), "nothing live left to close/kill on the second tick");
    assert.equal(mapsOf(m).runs.has(id), false, "run entry freed on the reap tick AFTER it closed");
    assert.equal(mapsOf(m).warningsById.has(id), false, "warningsById entry freed alongside it");
    assert.throws(() => m.status(id), /not found/, "status() now genuinely reports the run gone, not stale-forever");
  } finally {
    await m.shutdown();
  }
});

test("#6: an explicitly-closed non-seat run is also freed on the next reap tick (not just idle-TTL closes)", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "opencode", prompt: "gc-me-explicit", cwd: os.tmpdir(), readOnly: true });
    await waitTerminal(m, id);
    await m.close(id); // explicit clanker_close, not idle-TTL
    assert.ok(mapsOf(m).runs.has(id), "still present immediately after the explicit close call");

    await m.reap();
    assert.equal(mapsOf(m).runs.has(id), false, "freed on the next reap tick even for an explicit close");
    assert.equal(mapsOf(m).warningsById.has(id), false);
  } finally {
    await m.shutdown();
  }
});

test("#6: a seat run's map entries are exempted from GC even after an explicit clanker_close", async () => {
  const m = makeManager({ sessionTtlMs: 60 });
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      prompt: "seat-gc-check",
      cwd: os.tmpdir(),
      readOnly: true,
      seat: true,
    });
    await waitTerminal(m, id);

    // Idle-TTL path: seats only ever get soft-reaped (subprocess killed,
    // sessionClosed stays false) — never eligible for GC via that path.
    await new Promise((r) => setTimeout(r, 120));
    await m.reap();
    assert.ok(mapsOf(m).runs.has(id), "soft-reaped seat is never GC-eligible (sessionClosed stays false)");

    // Explicit clanker_close DOES set sessionClosed — this fix deliberately
    // scopes GC to non-seat runs only, so the entry must still survive a
    // subsequent reap tick (respawn plumbing/seat.json semantics for a
    // closed seat are out of scope for this change).
    await m.close(id);
    await m.reap();
    assert.ok(mapsOf(m).runs.has(id), "explicitly-closed seat is exempted from this fix's GC");
    const status = m.status(id);
    assert.equal(status.status, "done", "closed seat's status is still readable (unchanged behavior)");
  } finally {
    await m.shutdown();
  }
});
