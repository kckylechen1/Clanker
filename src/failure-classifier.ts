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
 * Authentication/credential-rejection signatures: an explicit
 * invalid-API-key message, or the backend's own "authentication error" /
 * "unauthorized" / "forbidden" text. These are self-contained phrases — the
 * word itself already IS the auth context, so no extra anchor is needed.
 * Unlike the schema-rejection check above, these are classified regardless
 * of turn count or tool-call count: a bad credential fails identically on
 * every turn, not just the first, so there's no reason to gate detection to
 * "turn 1, zero tool calls".
 */
const AUTH_PHRASE_PATTERNS: readonly RegExp[] = [
  /invalid[_ -]?api[_ -]?key/i,
  /authentication[_ -]?error/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
];

/**
 * A bare 401/403 status code, by itself, is NOT enough — e.g. a line number,
 * a port, or an unrelated numeric field can read as "401"/"403" with zero
 * auth relevance. Only classify a bare status code as CLANKER-AUTH-FAILURE
 * when it co-occurs (anywhere in the same message) with auth-shaped context:
 * "auth"/"unauthorized"/"forbidden"/"api key"/"credential".
 */
const AUTH_STATUS_CODE_PATTERN = /\b(401|403)\b/;
const AUTH_CONTEXT_PATTERN = /\b(auth\w*|unauthorized|forbidden|api[ _-]?key|credential\w*)\b/i;

/**
 * Local git index-lock contention signatures — another git process (a
 * concurrent lane, a stray `git` invocation) is holding `index.lock` in the
 * same worktree. Advisory only: this is transient contention, not a
 * permanent rejection like auth or schema; the other process is expected to
 * release the lock, but it's not this classifier's job to decide a retry
 * policy for it (unlike capacity, there's no fixed backoff that reliably
 * outlives another process's lock hold).
 *
 * `GIT_LOCK_PATH_PATTERN` matches the real artifact's path shape directly
 * (`.git/index.lock` / `.git\index.lock`) — self-contained, no extra anchor
 * needed. The looser `index.lock` substring match and the generic "Unable
 * to create ... .lock" phrasing are both over-broad on their own (they'd
 * match `myindex.lock` or an unrelated `/tmp/report.lock`), so those only
 * count when the message also mentions `git` somewhere.
 */
const GIT_LOCK_PATH_PATTERN = /\.git[\\/]index\.lock/i;
const GIT_CONTEXT_PATTERN = /\bgit\b/i;
const GIT_LOCK_GENERIC_PATTERN = /index\.lock|unable to create.*\.lock/i;

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
  if (AUTH_PHRASE_PATTERNS.some((re) => re.test(params.message))) {
    return AUTH_FAILURE_TAG;
  }
  if (AUTH_STATUS_CODE_PATTERN.test(params.message) && AUTH_CONTEXT_PATTERN.test(params.message)) {
    return AUTH_FAILURE_TAG;
  }
  if (GIT_LOCK_PATH_PATTERN.test(params.message)) {
    return GIT_LOCK_TAG;
  }
  if (GIT_CONTEXT_PATTERN.test(params.message) && GIT_LOCK_GENERIC_PATTERN.test(params.message)) {
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
 *
 * The phrase patterns below are self-contained (the phrase itself already IS
 * the capacity/overload context). A bare status code alone is NOT — e.g.
 * `{"line":429}` or a port/config value can read as one of these codes with
 * zero HTTP/rate-limit relevance — so a bare 429/500/502/503/504 only counts
 * when it co-occurs with HTTP/rate-limit context (http/status/rate limit/too
 * many requests/retry). That co-occurrence check naturally covers phrasings
 * like "429 Too Many Requests" / "HTTP 429" / "status: 429" without needing
 * a separate pattern per phrasing.
 */
const CAPACITY_TRANSIENT_PHRASE_PATTERNS: readonly RegExp[] = [
  /model[ _-]?at[ _-]?capacity/i,
  /\boverloaded\b/i,
  /\bservice unavailable\b/i,
];
const CAPACITY_STATUS_CODE_PATTERN = /\b(429|500|502|503|504)\b/;
const HTTP_STATUS_CONTEXT_PATTERN = /\b(http|status|rate limit|too many requests|retry)\b/i;

/** True when the error text looks like a transient backend-capacity condition worth one retry. */
export function isCapacityTransient(message: string): boolean {
  if (CAPACITY_TRANSIENT_PHRASE_PATTERNS.some((re) => re.test(message))) return true;
  return CAPACITY_STATUS_CODE_PATTERN.test(message) && HTTP_STATUS_CONTEXT_PATTERN.test(message);
}
