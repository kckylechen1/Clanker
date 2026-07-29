import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKEND_AUTH_TAG,
  BACKEND_BILLING_TAG,
  BACKEND_MODEL_TAG,
  ENV_DRIFT_TAG,
  classifyBackendFailure,
  classifyTurnFailure,
  INFRA_FAILURE_TAG,
  isCapacityTransient,
} from "../src/failure-classifier.js";
import { dropMutant, loadMutantModule } from "./helpers.js";

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

test("a backend that ANSWERED outranks a mere MENTION of env drift — billing/auth beat the loose pattern", () => {
  // Both signatures in one message, but the ENOENT is only mentioned in prose:
  // the backend was reached (so the spawn worked), and what it said is the more
  // specific truth. Contrast the test below, where the message IS acp-client's
  // spawn-failure wrapper and no backend was reached at all.
  const billing = "spawn helper ENOENT was logged earlier; API error (status 402): usage balance exhausted";
  assert.equal(classifyBackendFailure(billing), BACKEND_BILLING_TAG);
  const auth = "spawn helper ENOENT was logged earlier; 401 unauthorized";
  assert.equal(classifyBackendFailure(auth), BACKEND_AUTH_TAG);

  // Round-2 counterexample (codex-749a3, verified live against the previous
  // substring pattern): a real 402 whose text embeds the WORDS "failed to
  // spawn ... ENOENT" mid-sentence. Only acp-client's anchored wrapper shape
  // may take the pre-billing shortcut; this must stay BILLING.
  const embedded =
    "API error (status 402 Payment Required): usage balance exhausted; diagnostic: failed to spawn helper ENOENT";
  assert.equal(classifyBackendFailure(embedded), BACKEND_BILLING_TAG);
});

test("a spawn failure under a billing/auth-shaped PATH is ENV-DRIFT — no backend was reached to reject anything", () => {
  // PR #40 cold review (run codex-62e86) probed the shipped classifier with
  // these exact strings and got CLANKER-BACKEND-BILLING / CLANKER-BACKEND-AUTH:
  // billing and auth match bare substrings, and the failing COMMAND PATH is
  // part of acp-client.ts's wrapper text. A lane whose node lived under
  // /tmp/billing had its environment failure routed to the account team.
  assert.equal(
    classifyBackendFailure("failed to spawn '/tmp/billing/node': spawn /tmp/billing/node ENOENT"),
    ENV_DRIFT_TAG,
  );
  assert.equal(
    classifyBackendFailure("failed to spawn '/tmp/unauthorized/node': spawn /tmp/unauthorized/node ENOENT"),
    ENV_DRIFT_TAG,
  );
  // The same trap through the numeric branches of both patterns: `\b40[13]\b`
  // and `\b402\b` match a path segment just as happily as an HTTP status.
  assert.equal(
    classifyBackendFailure("failed to spawn '/opt/403/bin/node': spawn /opt/403/bin/node ENOENT"),
    ENV_DRIFT_TAG,
  );
  // And the incident's own literal text stays ENV-DRIFT.
  assert.equal(
    classifyBackendFailure(
      "failed to spawn '/opt/homebrew/Cellar/node/26.5.0/bin/node': spawn /opt/homebrew/Cellar/node/26.5.0/bin/node ENOENT",
    ),
    ENV_DRIFT_TAG,
  );
});

test("a real billing/auth rejection with no spawn-failure wrapper still classifies as what the backend said", () => {
  // The short-circuit above must not swallow the #9 shape it sits in front of.
  assert.equal(
    classifyBackendFailure("API error (status 402 Payment Required): Grok Build usage balance exhausted"),
    BACKEND_BILLING_TAG,
  );
  assert.equal(classifyBackendFailure("API error (status 401): invalid api key"), BACKEND_AUTH_TAG);
  assert.equal(classifyBackendFailure("403 forbidden: this credential cannot use the model"), BACKEND_AUTH_TAG);
});

test("ordinary failures are still untagged — ENOENT alone is not enough", () => {
  assert.equal(classifyBackendFailure("ENOENT: no such file or directory, open 'result.md'"), undefined);
  assert.equal(classifyBackendFailure("turn exceeded CLANKER_TURN_TIMEOUT_MS (2700000ms)"), undefined);
});

test("a model the backend refuses is its own class — not billing, not auth, not env drift", () => {
  // Measured 2026-07-29 from a real cursor smoke run that died in 10s while
  // the identical next run passed in 28s: the vendor's own text, verbatim.
  assert.equal(
    classifyBackendFailure(
      "Clanker: Cursor cursor-agent failed (exit 1): Cannot use this model: composer-2.5. Available models:",
    ),
    BACKEND_MODEL_TAG,
  );
  assert.equal(classifyBackendFailure("model gpt-9 is not available on your plan"), BACKEND_MODEL_TAG);
  // Billing still outranks it: an account out of money frequently SAYS the
  // model is unavailable, and the money is the actionable truth.
  assert.equal(
    classifyBackendFailure("model x unavailable: usage balance exhausted (402)"),
    BACKEND_BILLING_TAG,
  );
  // And it outranks AUTH, which is the fix for PR #44's cold review (run
  // codex-aed92). Verbatim from that reviewer's probe against the shipped
  // classifier, which answered CLANKER-BACKEND-AUTH: `\b40[13]\b` matched
  // before the model tag could see the message, so a dispatcher was sent to
  // audit credentials that were fine while a named model sat in the text.
  assert.equal(
    classifyBackendFailure(
      "Clanker: Cursor cursor-agent failed (exit 1): 403 Forbidden: Cannot use this model: composer-2.5. " +
        "Available models:",
    ),
    BACKEND_MODEL_TAG,
  );
  assert.equal(
    classifyBackendFailure("401 Unauthorized: model gpt-9 is not available to this key"),
    BACKEND_MODEL_TAG,
    "the status code says a request was refused; the model name says WHICH refusal",
  );
  // The other side of the same line: a rejection with NO model signature has
  // nothing more specific to be, so auth keeps it.
  assert.equal(classifyBackendFailure("403 Forbidden"), BACKEND_AUTH_TAG);
  assert.equal(classifyBackendFailure("HTTP 401: unauthorized — invalid api key"), BACKEND_AUTH_TAG);
  assert.equal(
    classifyBackendFailure("403 forbidden: this credential cannot use the model"),
    BACKEND_AUTH_TAG,
    "prose ABOUT a model is not a model-rejection signature",
  );
  // Billing beats both, even when all three signatures are in one message.
  assert.equal(
    classifyBackendFailure("403 Forbidden: Cannot use this model: composer-2.5 (usage balance exhausted)"),
    BACKEND_BILLING_TAG,
  );
  // And a spawn failure still short-circuits ahead of everything.
  assert.equal(
    classifyBackendFailure("failed to spawn '/x/node': spawn /x/node ENOENT — cannot use this model"),
    ENV_DRIFT_TAG,
  );
});

test("mutant: with model checked AFTER auth, the vendor's own 403 misroutes to credentials", async () => {
  // The pre-fix order, restored line for line. It is the exact probe cold
  // review (run codex-aed92) ran against the shipped classifier, and it is the
  // reason the two lines are now the other way round: the dispatcher was told
  // to go fix an account that was never asked about.
  const name = "classifier-model-after-auth";
  const mutated = await loadMutantModule<typeof import("../src/failure-classifier.js")>(name, [
    {
      file: "failure-classifier.ts",
      find:
        "  if (BACKEND_MODEL_PATTERNS.some((re) => re.test(message))) return BACKEND_MODEL_TAG;\n" +
        "  if (BACKEND_AUTH_PATTERNS.some((re) => re.test(message))) return BACKEND_AUTH_TAG;",
      replace:
        "  if (BACKEND_AUTH_PATTERNS.some((re) => re.test(message))) return BACKEND_AUTH_TAG;\n" +
        "  if (BACKEND_MODEL_PATTERNS.some((re) => re.test(message))) return BACKEND_MODEL_TAG;",
    },
  ], "failure-classifier.ts");
  try {
    assert.equal(
      mutated.classifyBackendFailure(
        "Clanker: Cursor cursor-agent failed (exit 1): 403 Forbidden: Cannot use this model: composer-2.5. " +
          "Available models:",
      ),
      BACKEND_AUTH_TAG,
      "pre-fix, a named model rejection wearing a 403 is filed as a credential problem",
    );
    // …while the halves that must NOT move stay put under the mutant, so this
    // proves an ordering change and not a pattern change.
    assert.equal(mutated.classifyBackendFailure("403 Forbidden"), BACKEND_AUTH_TAG);
    assert.equal(
      mutated.classifyBackendFailure("Cannot use this model: composer-2.5"),
      BACKEND_MODEL_TAG,
    );
  } finally {
    dropMutant(name);
  }
});
