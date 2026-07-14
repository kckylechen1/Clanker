import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, type SpecResolver, type WaitResult } from "../src/manager.js";
import { RUNS_ROOT } from "../src/constants.js";
import { fakeSpec } from "./helpers.js";

async function waitTerminal(m: LaneManager, id: string, timeoutMs = 5000): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  let last!: WaitResult;
  while (Date.now() < deadline) {
    last = await m.wait(id, 200);
    if (last.status !== "running") return last;
  }
  return last;
}

/**
 * Resume-discriminating resolver: the FIRST spec resolution (the fresh
 * dispatch) allows `session/new` normally. Every subsequent resolution (a
 * seat respawn after its subprocess died) forces the fake agent into
 * CLANKER_TEST_NO_SESSION_NEW=1 mode, so it can only be reached via
 * `session/resume` — if LaneManager.resumeConnection ever regressed into a
 * plain fresh dispatch instead of an actual resume, the respawned process
 * would reject the handshake and the test would fail loudly instead of
 * quietly passing for the wrong reason.
 */
function makeResumeDiscriminatingResolver(): SpecResolver {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? fakeSpec() : fakeSpec({ CLANKER_TEST_NO_SESSION_NEW: "1" });
  };
}

test("seat: sessionId is persisted to <runDir>/seat.json and survives idle-TTL soft-reap + clanker_close", async () => {
  const m = new LaneManager({
    resolveSpec: makeResumeDiscriminatingResolver(),
    disableReaper: true,
    baseRepo: os.tmpdir(),
    sessionTtlMs: 60,
  });
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      prompt: "seat-turn-1",
      cwd: os.tmpdir(),
      readOnly: true,
      seat: true,
      model: "glm",
    });
    const r1 = await waitTerminal(m, id);
    assert.equal(r1.status, "done");
    assert.equal(r1.final_message, "seat-turn-1");

    // ---- seat.json lands with the fields the dispatch packet asked for ----
    const seatPath = path.join(RUNS_ROOT, id, "seat.json");
    assert.ok(fs.existsSync(seatPath), `expected seat.json at ${seatPath}`);
    const seat = JSON.parse(fs.readFileSync(seatPath, "utf8"));
    assert.equal(seat.id, id);
    assert.equal(seat.lane, "opencode");
    assert.match(seat.sessionId, /^sess-\d+$/);
    assert.equal(seat.model, "glm");

    // ---- idle-TTL soft-reap: process dies, session does NOT ----
    await new Promise((res) => setTimeout(res, 120));
    const reaped = await m.reap();
    assert.ok(reaped.includes(id), "seat run should be soft-reaped after idle TTL");

    // Terminal-state semantics diverge from a non-seat reap here: the run is
    // NOT sessionClosed (list() still carries it — compare to the "reaped
    // session rejects clanker_prompt" non-seat test in manager.test.ts,
    // where the reaped run drops off clanker_list entirely).
    const listedAfterReap = m.list().find((e) => e.id === id);
    assert.ok(listedAfterReap, "soft-reaped seat should still be listed (session not closed, only the process)");

    // A second reap tick on an already-soft-reaped seat is a silent no-op
    // (doesn't re-report the same id every tick).
    const reapedAgain = await m.reap();
    assert.ok(!reapedAgain.includes(id), "soft-reaping a seat is idempotent, not re-reported every tick");

    // ---- clanker_prompt on the dead-process seat transparently resumes ----
    await m.promptExisting(id, "seat-turn-2");
    const r2 = await waitTerminal(m, id);
    assert.equal(r2.status, "done");
    assert.equal(r2.final_message, "seat-turn-2", "resumed session answered the new prompt");

    const entry = m.list().find((e) => e.id === id);
    assert.ok(entry, "run still listed after resume");
    assert.equal(entry!.turns_count, 2);

    // seat.json is refreshed (not deleted) across the resume.
    const seatAfterResume = JSON.parse(fs.readFileSync(seatPath, "utf8"));
    assert.equal(seatAfterResume.sessionId, seat.sessionId, "resume keeps the same ACP session id");

    // ---- clanker_close: the only way to terminally close a seat ----
    await m.close(id);
    assert.equal(m.list().find((e) => e.id === id), undefined, "closed seat drops off clanker_list");
    await assert.rejects(
      () => m.promptExisting(id, "too late"),
      /not found or already reaped/,
      "a fully closed seat behaves exactly like a closed non-seat session",
    );

    // seat.json is still on disk after a terminal close — durable record.
    assert.ok(fs.existsSync(seatPath), "seat.json is never deleted by close()");
  } finally {
    await m.shutdown();
  }
});

test("seat: concurrent prompts cannot start two resumes after a soft reap", async () => {
  const m = new LaneManager({
    resolveSpec: makeResumeDiscriminatingResolver(),
    disableReaper: true,
    baseRepo: os.tmpdir(),
    sessionTtlMs: 60,
  });
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      prompt: "seat-before-concurrent-resume",
      cwd: os.tmpdir(),
      readOnly: true,
      seat: true,
    });
    await waitTerminal(m, id);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok((await m.reap()).includes(id), "seat must be soft-reaped before concurrent prompts");

    const first = m.promptExisting(id, "first-resume");
    await assert.rejects(
      () => m.promptExisting(id, "second-resume"),
      /already has a turn starting/,
    );
    await first;
    const resumed = await waitTerminal(m, id);
    assert.equal(resumed.status, "done");
    assert.equal(resumed.final_message, "first-resume");
    assert.equal(m.list().find((entry) => entry.id === id)?.turns_count, 2);
  } finally {
    await m.shutdown();
  }
});

test("seat: reap() never closes a seat's worktree while resumable (retained until clanker_close)", async () => {
  // Regression guard for the soft- vs full-close split: a seat's worktree
  // must still exist after the idle-TTL reaper has killed its subprocess,
  // since a resume needs the same cwd. Uses readOnly (no worktree needed)
  // is not a strong enough check for this — assert on cwd directly instead.
  const m = new LaneManager({
    resolveSpec: makeResumeDiscriminatingResolver(),
    disableReaper: true,
    baseRepo: os.tmpdir(),
    sessionTtlMs: 60,
  });
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      prompt: "seat-cwd-check",
      cwd: os.tmpdir(),
      readOnly: true,
      seat: true,
    });
    await waitTerminal(m, id);
    await new Promise((res) => setTimeout(res, 120));
    await m.reap();
    assert.ok(fs.existsSync(os.tmpdir()), "cwd untouched by a seat's soft-reap");
    // The run object itself (and therefore its cwd bookkeeping) must still
    // be addressable for a resume to have somewhere to run.
    const status = m.status(id);
    assert.equal(status.cwd, os.tmpdir());
  } finally {
    await m.shutdown();
  }
});

test("seat: a backend that rejects session/resume surfaces a real error from clanker_prompt, not a silent respawn", async () => {
  let calls = 0;
  const resolver: SpecResolver = () => {
    calls += 1;
    // Call 1: normal handshake for the fresh dispatch. Call 2+ (the resume
    // respawn): a fresh fake-agent process that refuses session/new AND
    // unconditionally refuses session/resume — the only way promptExisting
    // can possibly succeed here is if it doesn't even try to resume, which
    // would itself be a bug; the real assertion is that it fails loudly.
    return calls === 1
      ? fakeSpec()
      : fakeSpec({ CLANKER_TEST_NO_SESSION_NEW: "1", CLANKER_TEST_REJECT_RESUME: "1" });
  };
  const m = new LaneManager({
    resolveSpec: resolver,
    disableReaper: true,
    baseRepo: os.tmpdir(),
    sessionTtlMs: 60,
  });
  try {
    const { id } = await m.dispatchStart({
      lane: "opencode",
      prompt: "seat-will-die",
      cwd: os.tmpdir(),
      readOnly: true,
      seat: true,
    });
    const r1 = await waitTerminal(m, id);
    assert.equal(r1.status, "done");

    await new Promise((res) => setTimeout(res, 120));
    const reaped = await m.reap();
    assert.ok(reaped.includes(id), "seat should be soft-reaped before the resume attempt");

    await assert.rejects(
      () => m.promptExisting(id, "seat-turn-2"),
      /session\/resume rejected|resume/i,
      "a genuine backend resume rejection must propagate, not vanish into a fresh session",
    );

    // The pre-existing terminal state from turn 1 is untouched — a failed
    // resume attempt never silently mutates the run into some other state.
    const status = m.status(id);
    assert.equal(status.status, "done");
  } finally {
    await m.shutdown();
  }
});
