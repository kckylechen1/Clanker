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
 * Classify a failed turn as CLANKER-INFRA-FAILURE when it dies on the very
 * first turn, with zero tool calls observed, carrying an API-level schema
 * rejection signature. That combination means the backend rejected the
 * request before the agent got to do anything — no amount of retrying the
 * identical prompt/shape will help.
 *
 * Returns undefined for every other failure (ordinary content/runtime
 * failure, or a later turn, or one that made at least one tool call).
 */
export function classifyTurnFailure(params: {
  message: string;
  turnsCount: number;
  toolCalls: number;
}): typeof INFRA_FAILURE_TAG | undefined {
  if (params.turnsCount !== 1 || params.toolCalls !== 0) return undefined;
  if (API_SCHEMA_ERROR_PATTERNS.some((re) => re.test(params.message))) {
    return INFRA_FAILURE_TAG;
  }
  return undefined;
}

/**
 * Backend transient-capacity signatures — "at capacity", overload, or a bare
 * 5xx status. Distinct from CLANKER-INFRA-FAILURE (a permanent schema
 * rejection): these are worth exactly one automatic retry after a backoff,
 * because the same request will very likely succeed once the backend has
 * room again. A message classified CLANKER-INFRA-FAILURE by
 * classifyTurnFailure must never be retried even if it also happens to match
 * one of these patterns — callers must check classifyTurnFailure first.
 */
const CAPACITY_TRANSIENT_PATTERNS: readonly RegExp[] = [
  /model[ _-]?at[ _-]?capacity/i,
  /\boverloaded\b/i,
  /\bservice unavailable\b/i,
  /\b(500|502|503|504)\b/,
];

/** True when the error text looks like a transient backend-capacity condition worth one retry. */
export function isCapacityTransient(message: string): boolean {
  return CAPACITY_TRANSIENT_PATTERNS.some((re) => re.test(message));
}
