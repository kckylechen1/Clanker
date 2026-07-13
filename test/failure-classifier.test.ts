import test from "node:test";
import assert from "node:assert/strict";
import { classifyTurnFailure, INFRA_FAILURE_TAG } from "../src/failure-classifier.js";

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
