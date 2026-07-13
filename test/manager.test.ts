import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, type WaitResult } from "../src/manager.js";
import { INFRA_FAILURE_TAG } from "../src/failure-classifier.js";
import { fakeResolver, until } from "./helpers.js";

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
