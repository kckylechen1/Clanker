import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKEND_AUTH_TAG,
  BACKEND_BILLING_TAG,
  classifyBackendFailure,
  isCapacityTransient,
} from "../src/failure-classifier.js";
import { grokFailureDetail } from "../src/grok-diagnostics.js";
import { LaneManager, type WaitResult } from "../src/manager.js";
import { fakeResolver } from "./helpers.js";

// ---- (a) classifyBackendFailure -------------------------------------------
//
// Issue #9: Grok's ACP bridge collapsed a real HTTP 402 (balance exhausted)
// into a bare -32603 "Internal error". Once grokFailureDetail (below) splices
// the real status_code/message back into the turn's error text, that text
// must be tagged as a permanent billing/auth failure — distinct from the
// generic capacity/5xx signatures, which are worth exactly one retry.

test("classifyBackendFailure tags a 402/balance message as CLANKER-BACKEND-BILLING", () => {
  assert.equal(
    classifyBackendFailure("Grok backend error — status_code=402 message=API error (status 402 Payment Required): Grok Build usage balance exhausted"),
    BACKEND_BILLING_TAG,
  );
  assert.equal(classifyBackendFailure("insufficient credit to complete this request"), BACKEND_BILLING_TAG);
  assert.equal(classifyBackendFailure("your billing plan does not cover this model"), BACKEND_BILLING_TAG);
});

test("classifyBackendFailure tags a 401/403 message as CLANKER-BACKEND-AUTH", () => {
  assert.equal(classifyBackendFailure("401 Unauthorized: invalid api key"), BACKEND_AUTH_TAG);
  assert.equal(classifyBackendFailure("request forbidden: authentication required"), BACKEND_AUTH_TAG);
});

test("classifyBackendFailure does not swallow a generic capacity/5xx message (that stays isCapacityTransient's retry class)", () => {
  const capacityMessages = [
    "model at capacity, please retry",
    "upstream overloaded, backing off",
    "503 Service Unavailable",
    "request failed with status 502",
  ];
  for (const message of capacityMessages) {
    assert.equal(classifyBackendFailure(message), undefined, `misclassified: ${message}`);
    assert.equal(isCapacityTransient(message), true, `expected capacity-transient: ${message}`);
  }
});

test("classifyBackendFailure boundary: it is a dumb string matcher — the safety that content never reaches it is structural (call-site discipline), not lexical", () => {
  // This is exactly the shape the lane card warns about: "HTTP 403 in
  // retrieved web page content" is TASK CONTENT (something the agent
  // fetched), not a backend failure signal. Fed directly to the classifier
  // it WOULD misfire, because the function cannot distinguish content from
  // a real rejection by string content alone — the guarantee instead comes
  // from manager.ts's runTurn only ever calling classifyBackendFailure
  // against the message from its own catch clause (timeout / process-exit /
  // connection-closed text), never a successful turn's agent_message.
  assert.equal(
    classifyBackendFailure("the page reported: HTTP 403 in retrieved web page content"),
    BACKEND_AUTH_TAG,
    "demonstrates the risk this classifier cannot resolve on its own — see call-site boundary test below",
  );
});

// ---- (c, partial) call-site boundary: success path never classifies ------
//
// Proves the actual production call site respects the boundary above: a
// successful turn whose final agent message happens to contain "HTTP 403 in
// retrieved web page content" (e.g. the agent quoting a page it fetched)
// must complete `done`, with no failure_class at all — because
// classifyTurnFailure/classifyBackendFailure are only ever invoked from
// runTurn's catch path, never against a successful turn's message.

function makeManager(): LaneManager {
  return new LaneManager({
    resolveSpec: fakeResolver,
    disableReaper: true,
    baseRepo: os.tmpdir(),
    stallThresholdMs: 300_000,
    sessionTtlMs: 600_000,
    turnTimeoutMs: 2_700_000,
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

test("a successful turn whose final message contains '403' content text is never routed through the backend-failure classifier", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "the page reported: HTTP 403 in retrieved web page content",
      cwd: os.tmpdir(),
      readOnly: true,
    });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.failure_class, undefined);
  } finally {
    await m.shutdown();
  }
});

// ---- (b) grokFailureDetail --------------------------------------------------
//
// Schema hand-verified against a live ~/.grok/logs/unified.jsonl on this
// machine (grok CLI v0.2.111, 2026-07-28) — see grok-diagnostics.ts's header
// comment for the full note. `ts` is ISO-8601; the failure tag lives on
// `msg`, not `kind`/`type`.

function withGrokHome<T>(dir: string, fn: () => T): T {
  const original = process.env.GROK_HOME;
  process.env.GROK_HOME = dir;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = original;
  }
}

function writeUnifiedLog(grokHome: string, lines: unknown[]): void {
  const logsDir = path.join(grokHome, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "unified.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("grokFailureDetail returns status_code + message for a terminal_failure line inside the turn's time window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-detail-hit-"));
  try {
    const turnStart = Date.parse("2026-07-24T03:26:50.000Z");
    const now = Date.parse("2026-07-24T03:27:00.000Z");
    writeUnifiedLog(dir, [
      { ts: "2026-07-24T03:26:54.663Z", lvl: "error", msg: "shell.turn.inference_failed", ctx: { status_code: 402, message: "API error (status 402 Payment Required): Grok Build usage balance exhausted" } },
      { ts: "2026-07-24T03:26:54.663Z", lvl: "warn", msg: "turn.terminal_failure", ctx: { status_code: 402, message: "API error (status 402 Payment Required): Grok Build usage balance exhausted" } },
    ]);
    const detail = withGrokHome(dir, () => grokFailureDetail(turnStart, now));
    assert.notEqual(detail, null);
    assert.match(detail ?? "", /402/);
    assert.match(detail ?? "", /Grok Build usage balance exhausted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("grokFailureDetail excludes a matching line whose timestamp falls outside [turnStartMs, now]", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-detail-outside-"));
  try {
    const turnStart = Date.parse("2026-07-24T03:26:50.000Z");
    const now = Date.parse("2026-07-24T03:27:00.000Z");
    // Same shape, but from a PRIOR turn — before the window starts.
    writeUnifiedLog(dir, [
      { ts: "2026-07-24T03:20:00.000Z", lvl: "warn", msg: "turn.terminal_failure", ctx: { status_code: 500, message: "stale prior-turn failure, must not be returned" } },
    ]);
    const detail = withGrokHome(dir, () => grokFailureDetail(turnStart, now));
    assert.equal(detail, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("grokFailureDetail returns the LAST matching line in the window when several are present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-detail-last-"));
  try {
    const turnStart = Date.parse("2026-07-24T03:26:00.000Z");
    const now = Date.parse("2026-07-24T03:27:00.000Z");
    writeUnifiedLog(dir, [
      { ts: "2026-07-24T03:26:10.000Z", lvl: "warn", msg: "turn.terminal_failure", ctx: { status_code: 500, message: "first attempt failure" } },
      { ts: "2026-07-24T03:26:11.000Z", lvl: "info", msg: "shell.turn.inference_start", ctx: {} },
      { ts: "2026-07-24T03:26:54.663Z", lvl: "warn", msg: "turn.terminal_failure", ctx: { status_code: 402, message: "second attempt failure (this one)" } },
    ]);
    const detail = withGrokHome(dir, () => grokFailureDetail(turnStart, now));
    assert.match(detail ?? "", /second attempt failure/);
    assert.doesNotMatch(detail ?? "", /first attempt failure/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("grokFailureDetail returns null (never throws) when the log file is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-detail-missing-"));
  try {
    // No logs/unified.jsonl written at all.
    const detail = withGrokHome(dir, () => grokFailureDetail(Date.now() - 1000, Date.now()));
    assert.equal(detail, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("grokFailureDetail returns null (never throws) on a malformed log line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-detail-malformed-"));
  try {
    const logsDir = path.join(dir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "unified.jsonl"), "not json at all { terminal_failure\n");
    const detail = withGrokHome(dir, () => grokFailureDetail(Date.now() - 1000, Date.now()));
    assert.equal(detail, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (c) manager.ts wiring: closed/exit branch splices grokFailureDetail --
//
// Timing note: run.turnStartedAtMs is set inside beginTurn, asynchronously
// after LaneConnection.connect() resolves — there is no test seam to observe
// that exact instant from outside. Rather than guess an offset (flaky under
// load), the fixture log is continuously rewritten with a fresh `ts =
// Date.now()` a few ms apart for the duration of the dispatch, so at
// whatever instant runTurn actually reads the file, the most recent line's
// timestamp is only a few ms old — always inside [turnStartMs, now] for any
// turn that takes more than a few ms to fail (every real one does: at least
// one subprocess round trip).

test("runTurn's closed/exit branch splices grokFailureDetail into the error message for the grok lane, and it auto-classifies as CLANKER-BACKEND-BILLING", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-wiring-"));
  const FIXTURE_MESSAGE = "TEST-FIXTURE billing detail: Grok Build usage balance exhausted";
  const logsDir = path.join(dir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "unified.jsonl");
  const writeFixture = () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      lvl: "warn",
      msg: "turn.terminal_failure",
      ctx: { status_code: 402, message: FIXTURE_MESSAGE },
    });
    fs.writeFileSync(logPath, line + "\n");
  };
  writeFixture();
  const rewriteTimer = setInterval(writeFixture, 5);
  rewriteTimer.unref?.();

  const original = process.env.GROK_HOME;
  process.env.GROK_HOME = dir;
  const m = makeManager();
  try {
    // "CRASH" is an existing fake-acp-agent.mjs scenario: emits one tool_call,
    // then exits(1) with an uninformative stderr line — standing in for
    // grok's real bug (the bridge's own stderr never carries the real
    // error). run.lane is "grok" regardless of which script actually spawns,
    // since fakeResolver ignores the lane argument.
    const { id } = await m.dispatchStart({ lane: "grok", prompt: "CRASH", cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id);
    clearInterval(rewriteTimer);
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /402/);
    assert.match(r.error ?? "", /TEST-FIXTURE billing detail/);
    // The grok detail is spliced in BEFORE the stderr tail (it carries more
    // signal) — assert the spliced detail appears earlier in the string
    // than the underlying process's own stderr text.
    const detailIdx = (r.error ?? "").indexOf("TEST-FIXTURE billing detail");
    const stderrIdx = (r.error ?? "").indexOf("simulated crash: worker unstable");
    assert.ok(detailIdx >= 0 && stderrIdx >= 0 && detailIdx < stderrIdx, `expected grok detail before stderr tail; error=${r.error}`);
    assert.equal(r.failure_class, BACKEND_BILLING_TAG);
  } finally {
    clearInterval(rewriteTimer);
    await m.shutdown();
    if (original === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
