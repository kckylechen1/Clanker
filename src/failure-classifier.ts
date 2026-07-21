/**
 * Turn-failure classification — distinguishes backend infra failures from
 * ordinary content/runtime failures so callers don't burn retries on a
 * request the backend will reject identically every time.
 *
 * 2026-07-13 incident: a turn-1, zero-tool-call HTTP 400
 * ("invalid_request_error", param:"tools", "Function 'collaboration.spawn_agent'
 * is reserved...") was retried three times by hand as if it were a content
 * failure, before anyone noticed the backend itself was rejecting the request
 * shape. The specific cause is already patched (src/backends.ts disables
 * multi_agent_v2 unconditionally, see 9bb88d7) — this classifier exists so
 * the *next* unknown API-schema rejection is labeled instead of silently
 * re-burned.
 */

/** Machine-checkable tag surfaced on wait/status output for an infra-class failure. */
export const INFRA_FAILURE_TAG = "CLANKER-INFRA-FAILURE";

/** Human-readable guidance appended alongside the tag. */
export const INFRA_FAILURE_ADVISORY =
  "infra 层故障，重试无益；先跑 `npm run smoke -- <lane>` 复验车道健康，再决定是否重派。";

/**
 * Machine-checkable tag for an authentication/credential rejection (401/403/
 * invalid API key). Distinct from CLANKER-INFRA-FAILURE: an auth failure
 * isn't a permanent request-shape rejection, it's a permanent *credential*
 * rejection — retrying the identical request against the same bad
 * credential never helps, and the fix is out-of-band (rotate/fix the key),
 * not a resend. Never classified capacity-transient (see
 * CAPACITY_TRANSIENT_PATTERNS below): an expired/invalid key will fail
 * identically forever, so auto-retry would just burn attempts.
 */
export const AUTH_FAILURE_TAG = "CLANKER-AUTH-FAILURE";

/** Human-readable guidance appended alongside CLANKER-AUTH-FAILURE. */
export const AUTH_FAILURE_ADVISORY = "认证/凭据被拒，重试无益；检查该车道的 API key/凭据后人工重派。";

/**
 * Machine-checkable tag for a local git index lock held by another
 * concurrent git process (`index.lock` present, or git's "Unable to create
 * ... .lock" message). Advisory only — this is a contention condition, not a
 * permanent rejection like auth or schema; the other process is expected to
 * release the lock, but it's not this classifier's job to decide whether/
 * when to retry.
 */
export const GIT_LOCK_TAG = "CLANKER-GIT-LOCK";

/** Human-readable guidance appended alongside CLANKER-GIT-LOCK. */
export const GIT_LOCK_ADVISORY = "另一个 git 进程持有 index.lock；等待其退出或人工清锁后再重派。";

/**
 * API-level / schema-rejection error signatures — the backend refused the
 * request shape before the model did anything, as opposed to a content
 * failure (bad prompt, tool error, model refusal) or a transient backend
 * hiccup (capacity/overload — see isCapacityTransient below).
 */
const API_SCHEMA_ERROR_PATTERNS: readonly RegExp[] = [
  /invalid_request_error/i,
  /"param"\s*:\s*"tools"/i,
  /reserved for use by this model/i,
];

/**
 * Authentication/credential-rejection signatures (401/403, an explicit
 * invalid-API-key message, or the backend's own "authentication error"/
 * "unauthorized" text). Unlike the schema-rejection check above, these are
 * classified regardless of turn count or tool-call count: a bad credential
 * fails identically on every turn, not just the first, so there's no reason
 * to gate detection to "turn 1, zero tool calls".
 */
const AUTH_ERROR_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /invalid[_ -]?api[_ -]?key/i,
  /authentication[_ -]?error/i,
  /\bunauthorized\b/i,
];

/**
 * Local git index-lock contention signatures — another git process (a
 * concurrent lane, a stray `git` invocation) is holding `index.lock` in the
 * same worktree. Advisory only: this is transient contention, not a
 * permanent rejection, but it's not this classifier's job to decide a retry
 * policy for it (unlike capacity, there's no fixed backoff that reliably
 * outlives another process's lock hold).
 */
const GIT_LOCK_PATTERNS: readonly RegExp[] = [/index\.lock/, /[Uu]nable to create.*\.lock/];

/**
 * Classify a failed turn's terminal error message, returning a
 * machine-checkable tag when it matches a known permanent/advisory failure
 * shape, so callers don't burn retries on a request that will fail
 * identically every time:
 *
 * - CLANKER-INFRA-FAILURE: dies on the very first turn, zero tool calls
 *   observed, carrying an API-level schema-rejection signature. That
 *   combination means the backend rejected the request before the agent got
 *   to do anything — no amount of retrying the identical prompt/shape will
 *   help. Gated to turn 1 / zero tool calls specifically because a later
 *   turn already proved the session's request shape works.
 * - CLANKER-AUTH-FAILURE: an authentication/credential rejection, any turn.
 * - CLANKER-GIT-LOCK: a local git index-lock contention signature, any turn.
 *
 * Returns undefined for every other failure (ordinary content/runtime
 * failure that matches none of the above).
 */
export function classifyTurnFailure(params: {
  message: string;
  turnsCount: number;
  toolCalls: number;
}): typeof INFRA_FAILURE_TAG | typeof AUTH_FAILURE_TAG | typeof GIT_LOCK_TAG | undefined {
  if (params.turnsCount === 1 && params.toolCalls === 0) {
    if (API_SCHEMA_ERROR_PATTERNS.some((re) => re.test(params.message))) {
      return INFRA_FAILURE_TAG;
    }
  }
  if (AUTH_ERROR_PATTERNS.some((re) => re.test(params.message))) {
    return AUTH_FAILURE_TAG;
  }
  if (GIT_LOCK_PATTERNS.some((re) => re.test(params.message))) {
    return GIT_LOCK_TAG;
  }
  return undefined;
}

/**
 * Backend transient-capacity signatures — "at capacity", overload, a bare
 * 5xx status, or a 429 (rate-limited — retrying after backoff is exactly the
 * right response, same as a 5xx). Distinct from CLANKER-INFRA-FAILURE (a
 * permanent schema rejection) and CLANKER-AUTH-FAILURE (a permanent
 * credential rejection — deliberately NOT included here: retrying an
 * invalid/expired key never succeeds, so it must never be folded into the
 * "worth one retry" bucket). These are worth exactly one automatic retry
 * after a backoff, because the same request will very likely succeed once
 * the backend has room again. A message classified CLANKER-INFRA-FAILURE or
 * CLANKER-AUTH-FAILURE by classifyTurnFailure must never be retried even if
 * it also happens to match one of these patterns — callers must check
 * classifyTurnFailure first.
 */
const CAPACITY_TRANSIENT_PATTERNS: readonly RegExp[] = [
  /model[ _-]?at[ _-]?capacity/i,
  /\boverloaded\b/i,
  /\bservice unavailable\b/i,
  /\b(429|500|502|503|504)\b/,
];

/** True when the error text looks like a transient backend-capacity condition worth one retry. */
export function isCapacityTransient(message: string): boolean {
  return CAPACITY_TRANSIENT_PATTERNS.some((re) => re.test(message));
}
