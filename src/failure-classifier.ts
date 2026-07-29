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

/** Machine-checkable tag for a local ENVIRONMENT failure: the spawn never reached any backend. */
export const ENV_DRIFT_TAG = "CLANKER-ENV-DRIFT";

/**
 * The backend refused the MODEL, not the request: the id is unknown to it, or
 * this account/plan cannot reach it right now. Permanent for that id, but
 * distinct from billing (the account is fine) and from auth (credentials are
 * fine) — and, measured 2026-07-29, sometimes TRANSIENT at the vendor: one
 * cursor smoke run died in 10s on `Cannot use this model: composer-2.5` and
 * the very next identical run passed in 28s. A dispatcher that cannot tell
 * "my dispatch is wrong" from "the vendor is having a moment" retries the
 * wrong thing, or gives up on a lane that is actually fine.
 */
export const BACKEND_MODEL_TAG = "CLANKER-BACKEND-MODEL";

/**
 * Model-rejection signatures. Kept narrow and vendor-quoted: these are the
 * exact shapes seen from real CLIs, not a guess at what a rejection reads like.
 *
 * ORDER: after billing, BEFORE auth. Billing first for the reason it always
 * was — an account out of money frequently reports it as a model it can no
 * longer reach, and the money is the more actionable truth. Auth after,
 * because cold review (run codex-aed92) probed the shipped classifier with the
 * vendor's own line
 *
 *     403 Forbidden: Cannot use this model: composer-2.5. Available models: …
 *
 * and got CLANKER-BACKEND-AUTH: `\b40[13]\b` matched first and sent the
 * dispatcher to go check credentials that were never the problem. A message
 * carrying BOTH a 403 and a named model rejection is a model diagnosis — it
 * says which model, and the remediation is to dispatch another one. A bare
 * 403/401/unauthorized with no model signature has no such specificity and
 * stays AUTH.
 */
const BACKEND_MODEL_PATTERNS: readonly RegExp[] = [
  /cannot use this model/i,
  /model .{0,80}(is )?(not available|unavailable|not supported|unknown model)/i,
  /no access to model/i,
];

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
 * Local environment drift — the spawn itself failed to find its command, so
 * nothing was ever asked of any backend (issue #37).
 *
 * 2026-07-28: a homebrew revision bump deleted the Cellar directory three
 * hours-old MCP servers had cached in `process.execPath`, and every subsequent
 * lane spawn came back `spawn /opt/homebrew/Cellar/node/26.5.0/bin/node
 * ENOENT`. The relay seat reported it verbatim and correctly, but as an
 * untagged CLANKER-FAILURE it reads exactly like a task/backend failure — the
 * dispatcher's first instinct is to re-dispatch, and re-dispatching is
 * precisely useless: nothing about the environment changed. node-binary.ts now
 * degrades around the common cause; this tag is what a dispatcher sees when
 * the spawn dies anyway, and it says the fix is on the machine, not in the
 * task. Same family as #9's GROK_HOME drift: long-lived process vs. an
 * environment that moved underneath it.
 *
 * Checked AFTER billing/auth, deliberately: those two describe what a backend
 * said, and a backend that answered at all was reached by a spawn that
 * succeeded — so on a message that merely MENTIONS an ENOENT alongside a
 * backend's answer, the backend's own words are the more specific truth.
 * (SPAWN_FAILURE_PATTERNS below is the one exception, and it runs first.)
 */
const ENV_DRIFT_PATTERNS: readonly RegExp[] = [
  // Node's own spawn error text: `spawn <command> ENOENT` (the command may
  // itself contain spaces, hence `.+` rather than `\S+`).
  /spawn .+ ENOENT/i,
];

/**
 * The one signature that outranks billing and auth: acp-client.ts's own
 * spawn-failure wrapper, `failed to spawn '<command>': spawn <command> ENOENT`
 * (src/acp-client.ts:330 → manager.ts's runTurn → here).
 *
 * The order is load-bearing and it is the REVERSE of the ENV_DRIFT_PATTERNS
 * rule above. PR #40's cold review (run codex-62e86) probed the shipped
 * classifier and got:
 *
 *     failed to spawn '/tmp/billing/node': ... ENOENT      -> CLANKER-BACKEND-BILLING
 *     failed to spawn '/tmp/unauthorized/node': ... ENOENT -> CLANKER-BACKEND-AUTH
 *
 * Both pattern sets match bare substrings (`billing`, `unauthorized`, a loose
 * `\b40[13]\b`), and the failing COMMAND PATH is part of the message — so any
 * lane whose node happened to live under such a directory had its ENVIRONMENT
 * failure routed to the account team, and the dispatcher was told to go check a
 * balance that was never queried. A spawn that failed opened no socket: there is
 * no backend that could have said anything about a balance or a credential, so
 * this shape short-circuits before either of them.
 *
 * Deliberately narrow — the whole wrapper, not a bare `ENOENT` — so prose that
 * only mentions an earlier spawn failure next to a real backend answer still
 * classifies as what the backend said.
 */
const SPAWN_FAILURE_PATTERNS: readonly RegExp[] = [
  // Anchored to acp-client's EXACT wrapper (`failed to spawn '<cmd>': ...`,
  // acp-client.ts spawn-error reject) — anchored at message start, quoted
  // command, colon. Round-2 review (codex-749a3) proved the previous
  // substring form was wider than its own prose: a REAL backend 402 whose
  // text embedded a "failed to spawn helper ENOENT" diagnostic hijacked the
  // short-circuit and misrouted billing to ENV-DRIFT. Only the wrapper shape
  // this codebase itself produces may take the pre-billing shortcut; any
  // spawn-ish text merely quoted inside a backend answer falls through to
  // the billing/auth/capacity passes below.
  /^failed to spawn '[^']+':.*\bENOENT\b/i,
];

/**
 * Classify a failure message as a permanent backend billing or auth
 * rejection. Unlike classifyTurnFailure's CLANKER-INFRA-FAILURE (scoped to a
 * turn-1, zero-tool-call schema rejection), a billing/auth failure is
 * permanent regardless of turn number or tool-call count — the account
 * state doesn't change mid-session — so there is no turnsCount/toolCalls
 * gate here.
 *
 * Three tiers, in this order, and the order carries meaning:
 *  1. A structural spawn failure (SPAWN_FAILURE_PATTERNS) — nothing was ever
 *     asked of any backend, so no backend verdict can be the truth here.
 *  2. What a backend actually said: billing, then MODEL, then auth. Billing
 *     first because an empty account is the most actionable truth there is.
 *     Model before auth because the two overlap in one real message shape —
 *     `403 Forbidden: Cannot use this model: composer-2.5` (measured, run
 *     codex-aed92) — and between "your credential is bad" and "this model is
 *     not available to you", the one that names the model is the more specific
 *     diagnosis and points at the fix. A 403 with no model signature is still
 *     AUTH: auth is the fallback for a rejection nothing more specific claims.
 *  3. A looser environment-drift mention (ENV_DRIFT_PATTERNS), which loses to
 *     a backend that answered.
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
export function classifyBackendFailure(
  message: string,
):
  | typeof BACKEND_BILLING_TAG
  | typeof BACKEND_AUTH_TAG
  | typeof ENV_DRIFT_TAG
  | typeof BACKEND_MODEL_TAG
  | undefined {
  if (SPAWN_FAILURE_PATTERNS.some((re) => re.test(message))) return ENV_DRIFT_TAG;
  if (BACKEND_BILLING_PATTERNS.some((re) => re.test(message))) return BACKEND_BILLING_TAG;
  if (BACKEND_MODEL_PATTERNS.some((re) => re.test(message))) return BACKEND_MODEL_TAG;
  if (BACKEND_AUTH_PATTERNS.some((re) => re.test(message))) return BACKEND_AUTH_TAG;
  if (ENV_DRIFT_PATTERNS.some((re) => re.test(message))) return ENV_DRIFT_TAG;
  return undefined;
}

/** Machine-checkable tag for a turn that came back as a vendor policy refusal instead of a verdict. */
export const VENDOR_REFUSAL_TAG = "CLANKER-VENDOR-REFUSAL";

/** Human-readable guidance carried as the run's `error` when the tag fires. */
export const VENDOR_REFUSAL_ADVISORY =
  "该 lane 的 vendor 用安全/政策拒绝页替代了本轮产出：这一单没有产生判决，read result.md 看拒绝页原文。" +
  "重派同一 prompt 到同一 vendor 无用；改派异厂或改写 prompt。";

/**
 * ORDER — and this one is not a position in the five-way chain above, it is a
 * DIFFERENT CHANNEL, which is the whole reason it is a separate function.
 *
 * classifyBackendFailure's BOUNDARY note (above) states the rule the five
 * existing classes live by: they are only ever run against the error/stderr
 * text a FAILED turn carries, because a string like "HTTP 403" inside content
 * the agent produced is content, not a backend rejection. A vendor refusal
 * arrives on the exact opposite channel — a turn that SUCCEEDED
 * (`stop_reason: end_turn`, `terminal_reason: done`) whose agent_message is
 * the vendor's policy page. Folding it into classifyBackendFailure would break
 * that boundary in both directions at once: this predicate would start seeing
 * arbitrary stderr, and billing/auth/model/env patterns would start seeing
 * arbitrary model prose. So it is checked FIRST on the success path and never
 * on the failure path, and the two sets never meet.
 *
 * 2026-07-29 (#48), run codex-45fd0: `clanker:codex` came back
 * `status: done`, 15s, zero tool calls, `final_message` entirely OpenAI's
 * "flagged for possible cybersecurity risk … Trusted Access for Cyber" page.
 * At the API layer that is indistinguishable from a clean read-only review
 * (which also finishes `done` with an empty touched_files). It was caught by a
 * human noticing the run was too fast; one less suspicious duration and a
 * review that never happened would have been booked as a review that found
 * nothing.
 *
 * WHY LEXICAL, AND WHY NOT STRUCTURAL — measured over all 588 runs in
 * ~/.cache/clanker/runs (297 with result.md, 264 carrying a final_message,
 * 163 real vendor verdicts):
 *
 *  - `touched_files` is not on result.md at all (0 of 264), so it cannot gate
 *    anything here — the #49 trap of reading a tree-level signal as a seat's
 *    own output.
 *  - `tool_calls: 0` does NOT mean "did no work". The gemini lane's ACP bridge
 *    emits one `update` event per turn and reports 0 tool calls for every run,
 *    including gemini-ccfb4 — a 10,757-character review quoting real
 *    `src/cursor-acp.ts:167` line numbers. 170 of 178 zero-tool-call `done`
 *    runs are ordinary. Gating on it would add false negatives and remove no
 *    false positives.
 *  - Duration does not separate either: the gemini refusal took 24,518ms and a
 *    legitimate `DONE` smoke reply took 24,520ms.
 *
 * The text is the only thing that separates the two groups, so the rule is
 * lexical — narrow and vendor-quoted, in the same spirit as
 * BACKEND_MODEL_PATTERNS.
 */
const VENDOR_REFUSAL_PATTERNS: readonly RegExp[] = [
  // OpenAI's cyber-policy interstitial, verbatim from run codex-45fd0.
  /\bflagged for possible cybersecurity risk\b/i,
  /\bTrusted Access for Cyber\b/i,
  // Gemini's shape, from run gemini-b3dc1: a first-person refusal to do the
  // job. Generalized only along the axis the two vendors already differ on —
  // which verb follows — because the sentence frame ("I <cannot> <do the
  // work>") is what a refusal IS, while `flagged for possible cybersecurity
  // risk` is one vendor's wording for it.
  /\bI (?:cannot|can(?:no|')?t|am unable to|'m unable to|will not|won'?t) (?:fulfill|comply with|assist|help|complete|carry out|proceed with|perform|conduct|provide|do)\b/i,
  /\bI (?:must|have to|will) (?:decline|refuse)\b/i,
];

/**
 * How far into the message a refusal phrase may appear. A policy page leads
 * with its refusal: the two measured samples match at index 18 (OpenAI) and 7
 * (Gemini), so 200 is generous by an order of magnitude.
 */
const VENDOR_REFUSAL_HEAD_CHARS = 200;

/**
 * Ceiling on the whole message. Both bounds are load-bearing TOGETHER, and the
 * reason is this classifier's own oldest hazard: the difference between a
 * signal and content that quotes the signal. A cold review of THIS repo that
 * cites issue #48 will contain the literal string
 * `flagged for possible cybersecurity risk` in its verdict, and an unbounded
 * match would classify that review — a real one, with real findings — as a
 * refusal and throw its verdict away. The head window alone does not save it
 * (a review may open by quoting); the ceiling alone does not either (it says
 * nothing about where the phrase sits).
 *
 * 600 is measured, not guessed. In the corpus, `done` final messages fall in
 * two disjoint clusters: terse machine answers (4–147 chars: `PONG`, `0.4.3`,
 * an `ABSENT` report) and substantive verdicts (968 chars and up, the smallest
 * being opencode-f0583's audit table). The two refusal pages are 213 and 263
 * chars. 600 sits in the empty band between 263 and 968 — above any refusal
 * observed, below any verdict that could quote one.
 *
 * KNOWN FALSE NEGATIVE, stated rather than papered over: a vendor policy page
 * longer than 600 characters is missed. With n=2 pages of language to go on,
 * a rule that stays narrow and lets a human catch the next shape is the honest
 * trade — widening it on speculation is how #27 spent six rounds.
 */
const VENDOR_REFUSAL_MAX_CHARS = 600;

/**
 * Classify a SUCCESSFUL turn's final message as a vendor policy refusal.
 *
 * BOUNDARY, the mirror of classifyBackendFailure's: only ever run this against
 * the agent's own final message on a turn that completed (run.ts
 * `completeTurn`). It must never see stderr or error text — the guarantee is
 * structural, from the single call site, not from anything this function can
 * check.
 *
 * Returns undefined for every ordinary verdict, including a short one.
 */
export function classifyVendorRefusal(finalMessage: string): typeof VENDOR_REFUSAL_TAG | undefined {
  const text = finalMessage.trim();
  if (text.length === 0 || text.length > VENDOR_REFUSAL_MAX_CHARS) return undefined;
  const head = text.slice(0, VENDOR_REFUSAL_HEAD_CHARS);
  if (VENDOR_REFUSAL_PATTERNS.some((re) => re.test(head))) return VENDOR_REFUSAL_TAG;
  return undefined;
}
