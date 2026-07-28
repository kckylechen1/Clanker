import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKEND_AUTH_TAG,
  BACKEND_BILLING_TAG,
  ENV_DRIFT_TAG,
  classifyBackendFailure,
  classifyTurnFailure,
  INFRA_FAILURE_TAG,
  isCapacityTransient,
} from "../src/failure-classifier.js";

// ---- CLANKER-INFRA-FAILURE classification --------------------------------
//
// 2026-07-13 incident: a turn-1, zero-tool-call HTTP 400 was hand-retried 3x
// as a content failure. classifyTurnFailure must tag that exact shape and
// leave every other failure shape untagged.

test("tags a turn-1, zero-tool-call, API-schema-rejection message as CLANKER-INFRA-FAILURE", () => {
  const cls = classifyTurnFailure({
    message:
      'lane process exited mid-turn (code=1 signal=null); stderr: {"error":{"type":"invalid_request_error","message":"Invalid Value: \'tools\'.","param":"tools"}}',
    turnsCount: 1,
    toolCalls: 0,
  });
  assert.equal(cls, INFRA_FAILURE_TAG);
});

test("tags the reserved-schema message text directly (no invalid_request_error wrapper needed)", () => {
  const cls = classifyTurnFailure({
    message: "Function 'collaboration.spawn_agent' is reserved for use by this model and must match the configured schema.",
    turnsCount: 1,
    toolCalls: 0,
  });
  assert.equal(cls, INFRA_FAILURE_TAG);
});

test("does not tag a turn-1 schema-error message if a tool call already happened", () => {
  const cls = classifyTurnFailure({
    message: 'stderr: {"error":{"type":"invalid_request_error","param":"tools"}}',
    turnsCount: 1,
    toolCalls: 1,
  });
  assert.equal(cls, undefined);
});

test("does not tag a schema-error message on a later turn (session already proved itself on turn 1)", () => {
  const cls = classifyTurnFailure({
    message: 'stderr: {"error":{"type":"invalid_request_error","param":"tools"}}',
    turnsCount: 2,
    toolCalls: 0,
  });
  assert.equal(cls, undefined);
});

test("does not tag an ordinary content/runtime failure (no API-schema signature)", () => {
  const cls = classifyTurnFailure({
    message: "turn exceeded CLANKER_TURN_TIMEOUT_MS (2700000ms) with no completion; killing the Clanker",
    turnsCount: 1,
    toolCalls: 0,
  });
  assert.equal(cls, undefined);
});

test("does not tag a capacity/overload message (that's a transient-retry class, not infra)", () => {
  const cls = classifyTurnFailure({
    message: 'stderr: {"error":{"type":"overloaded_error","message":"model at capacity, please retry"}}',
    turnsCount: 1,
    toolCalls: 0,
  });
  assert.equal(cls, undefined);
});

// ---- capacity-transient classification (single-retry class) -------------

test("isCapacityTransient recognizes 'model at capacity' phrasing, with separator variants", () => {
  assert.equal(isCapacityTransient("model at capacity, please retry"), true);
  assert.equal(isCapacityTransient("Model_At_Capacity"), true);
  assert.equal(isCapacityTransient("model-at-capacity: try again shortly"), true);
});

test("isCapacityTransient recognizes overloaded / service unavailable / 5xx", () => {
  assert.equal(isCapacityTransient("upstream overloaded, backing off"), true);
  assert.equal(isCapacityTransient("503 Service Unavailable"), true);
  assert.equal(isCapacityTransient("request failed with status 502"), true);
});

test("isCapacityTransient does not match ordinary failures or 4xx client errors", () => {
  assert.equal(isCapacityTransient("turn exceeded CLANKER_TURN_TIMEOUT_MS"), false);
  assert.equal(isCapacityTransient("lane process exited mid-turn (code=1 signal=null)"), false);
  assert.equal(isCapacityTransient('{"error":{"type":"invalid_request_error","param":"tools"}}'), false);
  assert.equal(isCapacityTransient("HTTP 400 bad request"), false);
});

// ---- CLANKER-ENV-DRIFT classification (#37) ------------------------------
//
// The 2026-07-28 incident's literal text: a homebrew revision bump deleted the
// Cellar directory three long-lived servers had cached in process.execPath, and
// every lane spawn afterwards came back ENOENT. Untagged, that reads like a task
// failure and invites a useless re-dispatch.

test("tags a spawn ENOENT as CLANKER-ENV-DRIFT — the environment moved, not the task", () => {
  assert.equal(
    classifyBackendFailure(
      "failed to spawn '/opt/homebrew/Cellar/node/26.5.0/bin/node': spawn /opt/homebrew/Cellar/node/26.5.0/bin/node ENOENT",
    ),
    ENV_DRIFT_TAG,
  );
  // A command path with spaces in it still classifies.
  assert.equal(
    classifyBackendFailure("failed to spawn 'grok': spawn /Applications/My Tools/grok ENOENT"),
    ENV_DRIFT_TAG,
  );
});

test("a backend that ANSWERED outranks env drift — billing/auth are checked first", () => {
  // Both signatures in one message: the backend was reached (so the spawn
  // worked), and what it said is the more specific truth.
  const billing = "spawn helper ENOENT was logged earlier; API error (status 402): usage balance exhausted";
  assert.equal(classifyBackendFailure(billing), BACKEND_BILLING_TAG);
  const auth = "spawn helper ENOENT was logged earlier; 401 unauthorized";
  assert.equal(classifyBackendFailure(auth), BACKEND_AUTH_TAG);
});

test("ordinary failures are still untagged — ENOENT alone is not enough", () => {
  assert.equal(classifyBackendFailure("ENOENT: no such file or directory, open 'result.md'"), undefined);
  assert.equal(classifyBackendFailure("turn exceeded CLANKER_TURN_TIMEOUT_MS (2700000ms)"), undefined);
});
