import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTurnFailure,
  INFRA_FAILURE_TAG,
  AUTH_FAILURE_TAG,
  GIT_LOCK_TAG,
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

test("isCapacityTransient recognizes 429 (rate-limited — same one-retry treatment as 5xx)", () => {
  assert.equal(isCapacityTransient("429 Too Many Requests"), true);
  assert.equal(isCapacityTransient("request failed with status 429"), true);
});

test("isCapacityTransient does not match ordinary failures or 4xx client errors", () => {
  assert.equal(isCapacityTransient("turn exceeded CLANKER_TURN_TIMEOUT_MS"), false);
  assert.equal(isCapacityTransient("lane process exited mid-turn (code=1 signal=null)"), false);
  assert.equal(isCapacityTransient('{"error":{"type":"invalid_request_error","param":"tools"}}'), false);
  assert.equal(isCapacityTransient("HTTP 400 bad request"), false);
});

test("isCapacityTransient does not match an auth rejection (401/403 must not be folded into transient-retry)", () => {
  assert.equal(isCapacityTransient("401 Unauthorized: invalid_api_key"), false);
  assert.equal(isCapacityTransient("403 Forbidden: authentication_error"), false);
});

// ---- #5b: over-match regression guards (context-anchored, not bare digits/substrings) ----

test("#5b: isCapacityTransient does NOT fire on a bare numeric field that happens to equal a status code", () => {
  assert.equal(isCapacityTransient('{"line":429}'), false, "a line number, not an HTTP status");
  assert.equal(isCapacityTransient('{"port":503}'), false, "a port number, not an HTTP status");
});

// ---- CLANKER-AUTH-FAILURE classification ---------------------------------

test("tags a 401 status as CLANKER-AUTH-FAILURE, any turn/tool-call count", () => {
  const cls = classifyTurnFailure({
    message: "request failed: 401 Unauthorized",
    turnsCount: 1,
    toolCalls: 0,
  });
  assert.equal(cls, AUTH_FAILURE_TAG);
});

test("tags a 403 status as CLANKER-AUTH-FAILURE", () => {
  const cls = classifyTurnFailure({
    message: "request failed: 403 Forbidden",
    turnsCount: 3,
    toolCalls: 2,
  });
  assert.equal(cls, AUTH_FAILURE_TAG);
});

test("tags an explicit invalid_api_key message as CLANKER-AUTH-FAILURE", () => {
  const cls = classifyTurnFailure({
    message: '{"error":{"type":"authentication_error","message":"invalid_api_key: revoked"}}',
    turnsCount: 5,
    toolCalls: 4,
  });
  assert.equal(cls, AUTH_FAILURE_TAG);
});

test("tags an 'unauthorized' backend message as CLANKER-AUTH-FAILURE even mid-conversation", () => {
  const cls = classifyTurnFailure({
    message: "lane process exited mid-turn: Unauthorized — credential rejected",
    turnsCount: 2,
    toolCalls: 1,
  });
  assert.equal(cls, AUTH_FAILURE_TAG);
});

test("#5b: a bare 401/403 digit with NO auth context is not tagged CLANKER-AUTH-FAILURE", () => {
  const cls = classifyTurnFailure({
    message: "parse error at line 401: unexpected token",
    turnsCount: 1,
    toolCalls: 0,
  });
  assert.equal(cls, undefined, "a line number, not an auth rejection — no auth-shaped context present");
});

// ---- CLANKER-GIT-LOCK classification --------------------------------------

test("tags an index.lock message as CLANKER-GIT-LOCK", () => {
  const cls = classifyTurnFailure({
    message: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    turnsCount: 1,
    toolCalls: 3,
  });
  assert.equal(cls, GIT_LOCK_TAG);
});

test("tags a bare 'index.lock' mention as CLANKER-GIT-LOCK", () => {
  const cls = classifyTurnFailure({
    message: "git commit failed: index.lock exists, another git process is running",
    turnsCount: 4,
    toolCalls: 6,
  });
  assert.equal(cls, GIT_LOCK_TAG);
});

test("does not tag an ordinary content/runtime failure as auth or git-lock", () => {
  const cls = classifyTurnFailure({
    message: "turn exceeded CLANKER_TURN_TIMEOUT_MS (2700000ms) with no completion; killing the Clanker",
    turnsCount: 1,
    toolCalls: 0,
  });
  assert.equal(cls, undefined);
});

test("#5b: an unrelated 'myindex.lock' filename (no git context) is not tagged CLANKER-GIT-LOCK", () => {
  const cls = classifyTurnFailure({
    message: "renamed the working copy to myindex.lock as a backup",
    turnsCount: 1,
    toolCalls: 2,
  });
  assert.equal(cls, undefined, "'myindex.lock' contains the substring 'index.lock' but isn't git-related");
});

test("#5b: an unrelated '.lock' file outside a git context is not tagged CLANKER-GIT-LOCK", () => {
  const cls = classifyTurnFailure({
    message: "wrote the daily report snapshot to /tmp/report.lock",
    turnsCount: 1,
    toolCalls: 1,
  });
  assert.equal(cls, undefined, "an arbitrary .lock file with no git mention anywhere in the message");
});
