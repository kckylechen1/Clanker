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

/** Machine-checkable tag for a permanent backend billing/balance rejection. */
export const BACKEND_BILLING_TAG = "CLANKER-BACKEND-BILLING";

/** Machine-checkable tag for a permanent backend auth/credential rejection. */
export const BACKEND_AUTH_TAG = "CLANKER-BACKEND-AUTH";

/**
 * Backend billing-account failure signatures. 2026-07-24 incident (issue
 * #9): Grok's ACP bridge returned HTTP 402 ("API error (status 402 Payment
 * Required): Grok Build usage balance exhausted") from its backend, but its
 * own bridge collapsed that into a bare JSON-RPC -32603 "Internal error" —
 * Clanker's captured stderr never carried the real status_code/message. The
 * detail only lived in Grok's private `$GROK_HOME/logs/unified.jsonl` (see
 * grok-diagnostics.ts's grokFailureDetail, spliced into the turn's error
 * text by manager.ts). Once spliced in, it must classify as a permanent,
 * non-retryable failure — an empty account balance does not self-heal the
 * way an overloaded backend does — so this is checked before the generic
 * CAPACITY_TRANSIENT_PATTERNS below.
 */
const BACKEND_BILLING_PATTERNS: readonly RegExp[] = [
  /\b402\b|balance|billing|payment required|usage balance exhausted|insufficient credit/i,
];

/**
 * Backend auth/credential failure signatures — same permanent-failure
 * reasoning as BACKEND_BILLING_PATTERNS above (issue #9), for the sibling
 * case where the backend rejects the credential itself rather than the
 * account balance.
 */
const BACKEND_AUTH_PATTERNS: readonly RegExp[] = [
  /\b40[13]\b|unauthorized|forbidden|invalid api key|authentication/i,
];

/**
 * Classify a failure message as a permanent backend billing or auth
 * rejection. Unlike classifyTurnFailure's CLANKER-INFRA-FAILURE (scoped to a
 * turn-1, zero-tool-call schema rejection), a billing/auth failure is
 * permanent regardless of turn number or tool-call count — the account
 * state doesn't change mid-session — so there is no turnsCount/toolCalls
 * gate here. Billing is checked before auth only because 402 and 401/403 are
 * mutually exclusive HTTP statuses in practice; the two pattern sets
 * otherwise don't need a specific relative order.
 *
 * BOUNDARY: only ever run this against the error/stderr text a *failed* turn
 * carries — the same channel classifyTurnFailure/isCapacityTransient
 * consume (manager.ts's runTurn only calls these against the message from
 * its own catch clause: timeout / process-exit / connection-closed text,
 * never a successful turn's agent_message or tool-result content). A page
 * the agent fetched that itself contains the literal text "HTTP 403 in
 * retrieved web page content" is *content*, not a backend failure signal —
 * it must never be routed through this classifier. The guarantee is
 * structural (call-site discipline: only the catch-path message is ever
 * passed in), not lexical — this function cannot itself tell content from a
 * real backend rejection, since both are just strings.
 */
export function classifyBackendFailure(message: string): typeof BACKEND_BILLING_TAG | typeof BACKEND_AUTH_TAG | undefined {
  if (BACKEND_BILLING_PATTERNS.some((re) => re.test(message))) return BACKEND_BILLING_TAG;
  if (BACKEND_AUTH_PATTERNS.some((re) => re.test(message))) return BACKEND_AUTH_TAG;
  return undefined;
}
