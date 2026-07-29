/**
 * Small stateless helpers with zero coupling to LaneManager's instance state.
 *
 * Extracted from manager.ts's tail (#37 A4): these lived as free functions
 * below the LaneManager class only because that is where they were first
 * needed, not because they depend on anything the class owns. Keeping them
 * there made manager.ts's actual surface — the class — harder to see past
 * ~80 lines of unrelated utility code.
 */
import { INFRA_FAILURE_ADVISORY, INFRA_FAILURE_TAG } from "./failure-classifier.js";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "./constants.js";

/** Message text of any thrown value, Error or not. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A cancelable timeout whose promise resolves after `ms`. */
export function createTimeout(ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

export function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

export function clampWait(ms?: number): number {
  if (ms === undefined) return DEFAULT_WAIT_MS;
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_WAIT_MS;
  return Math.min(ms, MAX_WAIT_MS);
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Append the human-readable infra-failure advisory to an error message when classified. */
export function annotatedError(message: string, failureClass: string | undefined): string {
  if (failureClass === INFRA_FAILURE_TAG) {
    return `${message}\n\n[${INFRA_FAILURE_TAG}] ${INFRA_FAILURE_ADVISORY}`;
  }
  return message;
}

/**
 * Redact secret-shaped values (api keys/tokens/bearer credentials/auth
 * headers) out of arbitrary text before it is embedded in an error message
 * that reaches a caller, or written to disk (events.jsonl / result.md / the
 * dispatch ledger) — issue #8's first item. Keeps the key name and only
 * blanks the value, so the redaction is still legible evidence
 * ("API_KEY=[REDACTED]") instead of an unexplained gap in the text.
 *
 * LOCAL SINKS ONLY. Everything this function guards stays on the operator's
 * own disk, so it is deliberately conservative: it fires only on a NAMED key
 * (`API_KEY=…`, `token: …`) and leaves the rest of the text alone, because
 * over-redacting a local forensic artifact destroys the evidence the artifact
 * exists for. A credential that reaches a REMOTE sink is a different threat
 * model entirely and must go through `redactForPublic()` below.
 */
const SECRET_PATTERN = /(api[_-]?key|token|secret|authorization|bearer)(\s*[=:]\s*)\S+/gi;
export function redact(text: string): string {
  return text.replace(SECRET_PATTERN, (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`);
}

/**
 * Redact for a sink this machine does not own — today, the #27 issue comment.
 *
 * A SEPARATE function from `redact()` on purpose, and the separation is the
 * point rather than an accident of layering: the two sinks have different
 * threat models and therefore different correct answers.
 *
 *   - `redact()` guards `events.jsonl` / `result.md` / the ledger. Those files
 *     never leave the machine that wrote them; the cost of a miss is bounded
 *     by the disk it sits on, and the cost of a FALSE positive is a mangled
 *     piece of evidence in the only lossless copy of a verdict.
 *   - This guards a comment pushed to GitHub, which may be a public thread and
 *     is in any case out of reach the instant it lands — there is no unposting
 *     a leaked token, only rotating it. Here a miss is unbounded and a false
 *     positive costs a few unreadable characters in a comment whose lossless
 *     original is still on disk (the comment says so when it redacts).
 *
 * So this one is deliberately trigger-happy: on top of the named-key rule it
 * blanks anything SHAPED like a credential regardless of what introduces it —
 * known token prefixes, the value after `Bearer`/`token`, URL userinfo, and
 * any long high-entropy run. Reviewers of this function should resolve doubt
 * toward redacting: a verdict that reads a little worse is a cost paid to the
 * reader, a published token is a cost paid to everyone.
 *
 * The one carve-out is bare 40-char lowercase hex — a git SHA-1, the single
 * most load-bearing token in this repo's verdicts ("base ebd72ed…", "regressed
 * at <sha>"). Blanking those would gut the accounting this feature exists to
 * keep, and a secret that happens to be exactly-40 lowercase hex and appears
 * with no key name, no prefix and no URL around it is a shape this codebase has
 * never seen. SHA-256 (64 hex) is deliberately NOT carved out even though it is
 * also a digest: it appeared ONCE in the 290-verdict corpus, while sparing it
 * would spare every 32-byte hex API key — 100% of that family — so a rare
 * `[REDACTED]` where a sha256 digest stood is the cheaper of the two errors.
 * Second cold review flagged the older comment here for claiming 40/64; the
 * code has always been 40, and this is the comment being made to tell the truth
 * rather than the behaviour being widened to match a stale sentence.
 *
 * KNOWN AND ACCEPTED GAP: a credential broken up by whitespace or punctuation
 * (a token wrapped across two lines, say) is matched only in whatever
 * contiguous piece is long enough. Reassembling across separators before
 * matching was measured and rejected — it is the same move as putting `-`, `_`
 * and `/` back in the long-run class, which took the corpus false positives
 * from 10 spans to 227 (every file:line, every constant name). A fragment that
 * short is also not directly usable as a credential, so the trade buys back
 * nothing worth the evidence it would destroy.
 */
const PUBLIC_SECRET_RULES: readonly { readonly re: RegExp; readonly replace: string }[] = [
  // Known credential prefixes, matched on shape alone: GitHub (`ghp_`/`gho_`/
  // `ghu_`/`ghs_`/`ghr_`), OpenAI-style (`sk-`, which also covers `sk-ant-`,
  // `sk-live-`, `sk-proj-`), Slack, GitLab, npm, AWS access-key ids, Google.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[REDACTED]" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: "[REDACTED]" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "[REDACTED]" },
  { re: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: "[REDACTED]" },
  { re: /\bnpm_[A-Za-z0-9]{20,}/g, replace: "[REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{12,}/g, replace: "[REDACTED]" },
  { re: /\bAIza[A-Za-z0-9_-]{20,}/g, replace: "[REDACTED]" },
  // JWTs. `eyJ` is base64 of `{"`, so this is the one URL-safe-base64 shape
  // worth naming: the long-run rule below treats `-`/`_` as boundaries (see
  // there for why), which is exactly the alphabet a JWT is written in.
  { re: /\beyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+){0,2}/g, replace: "[REDACTED]" },
  // A bare `Bearer <token>` / `token <token>` with no header around it. The
  // header form is handled structurally before any of these rules run (see
  // AUTH_HEADER below); this one catches the scheme word standing on its own in
  // prose or in a curl line. Gated on a digit and 12+ characters so ordinary
  // prose about tokens ("the token is staged in a file") is not shredded — a
  // real credential essentially always carries one.
  { re: /\b(bearer|token)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/gi, replace: "$1$2[REDACTED]" },
  // URL userinfo: `https://user:pass@host` and the token-as-username form
  // `https://ghp_xxx@host`. The password half is always a credential; a lone
  // userinfo in a machine-generated URL is one too.
  { re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@:]+):[^\s/@]+@/g, replace: "$1$2:[REDACTED]@" },
  { re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]{8,}@/g, replace: "$1[REDACTED]@" },
];
/**
 * Unlabelled long runs — a credential with no key name, no known prefix and no
 * URL around it. This is the one rule that had to be MEASURED rather than
 * asserted, because "32 random-looking characters" is also the shape of a Go
 * test name and of every absolute path. It was tuned against the real corpus
 * (290 `result.md` verdicts under `~/.cache/clanker/runs`, 793k characters,
 * 2026-07-29) versus 2000 synthetic keys of each shape, and the numbers below
 * are that measurement, not an estimate. Re-tune the same way, not by taste.
 *
 * What the corpus said, in the order it killed the obvious designs:
 *
 *  1. THE NAIVE `[A-Za-z0-9+/=]{32,}` IS UNUSABLE: 227 distinct spans matched
 *     in the corpus, every one a false positive —`Users/kckylechen/Projects/
 *     Clanker` (33 chars: every file:line in every verdict),
 *     `DEFAULT_RAW_VECTOR_SIMILARITY_FLOOR`, `issue-2293-watchpoint-…`. A
 *     verdict whose evidence is blanked is not a redacted verdict, it is a
 *     destroyed one.
 *  2. ENTROPY DOES NOT SEPARATE THEM. Measured: corpus identifiers reach 4.51
 *     bits/char, 24-byte base64 keys start at 4.04 — the distributions overlap,
 *     so no threshold both spares a verdict and catches a key. What separates
 *     them is that identifiers are made of WORDS: every corpus false positive
 *     carries a same-case letter run of 6+ (`bservation`, `ontract`, `folders`),
 *     while a random blob's longest run is 2-3. Hence `longestSameCaseRun`.
 *  3. HEX NEEDS ITS OWN RULE, because it can reach neither the entropy nor the
 *     character mix of anything above (16 symbols cap it at ~3.9 bits/char), and
 *     it is free: the corpus holds ZERO non-SHA hex runs of 32+. The carve-out
 *     is exactly 40 lowercase hex — git SHA-1, 79 occurrences in the corpus and
 *     the single most load-bearing token this repo's verdicts contain. SHA-256
 *     is NOT carved out: it appeared once in 290 verdicts, and sparing it would
 *     mean sparing every 32-byte hex API key, which is 100% of that family.
 *
 * The two shapes that survive that are complementary, and the union is what
 * costs so little: SEPARATOR-FREE (a `-`, `_` or `/` ends the run) catches
 * short-but-random tokens down to 20 characters, where a path segment or a word
 * cannot reach; SEPARATOR-BEARING needs 32 and no word-run at all, which is how
 * base64 that happens to contain `/` or a URL-safe `-` is caught without eating
 * the paths that necessarily contain them. Measured on the corpus: 10 distinct
 * false-positive spans, 124 occurrences, and 107 of those 124 are ONE macOS
 * temp-dir token (`/var/folders/…/zblh0pcn7m9…/T`) — which is itself a random
 * machine-generated string, so redacting it is arguably the correct call and
 * the rest of the path survives around it. Missed keys: base64 0.3-1.9%,
 * URL-safe base64 1.6-2.7%, AWS-style 0.6%.
 */
const PUBLIC_HEX_BLOB = /\b[0-9a-fA-F]{32,}\b/g;
const PUBLIC_TIGHT_BLOB = /[A-Za-z0-9+]{20,}={0,2}/g;
const PUBLIC_LOOSE_BLOB = /[A-Za-z0-9+/_-]{32,}/g;
/** git SHA-1, spelled as git spells it. The one carve-out; see rule 3 above. */
const GIT_SHA = /^[0-9a-f]{40}$/;
/** Longest run of consecutive same-case letters — how a word betrays itself. */
function longestSameCaseRun(text: string): number {
  let best = 0;
  let current = 0;
  let kind = "";
  for (const ch of text) {
    const k = ch >= "a" && ch <= "z" ? "l" : ch >= "A" && ch <= "Z" ? "u" : "";
    if (k !== "" && k === kind) current += 1;
    else current = k === "" ? 0 : 1;
    kind = k;
    if (current > best) best = current;
  }
  return best;
}
/**
 * Fewer than 8 distinct characters is not a credential — it is a diffstat bar
 * (`++++++++++++++++`), a rule of `=`, or a padded field. Cheapest gate here and
 * it costs nothing in detection: 32 draws from base64 leave ~25 distinct, from
 * hex ~14.
 */
function looksRandom(span: string, requireDigitOrNoWord: boolean): boolean {
  if (GIT_SHA.test(span)) return false;
  if (new Set(span).size < 8) return false;
  if (longestSameCaseRun(span) < 6) return true;
  return requireDigitOrNoWord ? /\d/.test(span) : false;
}
/**
 * An HTTP authentication header, matched by its STRUCTURE rather than by a list
 * of scheme names: `Authorization: <scheme> <credentials>` (RFC 9110), plus the
 * proxy spelling. The credentials are blanked whole; the scheme word stays,
 * because "a Basic credential was published here" is exactly the evidence a
 * reader of a redacted verdict needs.
 *
 * Structure, not a name list, because the second cold review landed `Basic`
 * escaping through a rule that knew `bearer|token` — and the next report would
 * have been `Digest`, then `Negotiate`, then `ApiKey`. A rule that has to be
 * extended once per scheme is a rule that is wrong by construction.
 */
const AUTH_HEADER =
  /\b((?:proxy-)?authorization)(["']?[ \t]*[:=][ \t]*["']?)([A-Za-z][A-Za-z0-9._-]*)([ \t]+)[^\r\n'"`]+/gi;
/**
 * Where a matched header is parked while the other rules run.
 *
 * It has to be parked rather than merely rewritten in place, because `redact()`
 * would then eat the SCHEME: its pattern is `authorization\s*[:=]\s*\S+`, whose
 * `\S+` starts immediately after the colon and therefore covers `Basic`, not
 * the credential — which is the entire shape of the bug being fixed here
 * ("Authorization: [REDACTED] dXNlcjpodW50ZXIy"). Parking makes this rule the
 * OWNER of the headers it matches: no later rule can see them, and none can
 * un-redact them either, since what is parked is already the redacted form.
 */
const AUTH_PARK = /\[\[clanker-auth-(\d+)\]\]/g;
export function redactForPublic(text: string): string {
  const parked: string[] = [];
  let out = text.replace(AUTH_HEADER, (_m, name: string, sep: string, scheme: string, gap: string) => {
    parked.push(`${name}${sep}${scheme}${gap}[REDACTED]`);
    return `[[clanker-auth-${parked.length - 1}]]`;
  });
  out = redact(out);
  for (const { re, replace } of PUBLIC_SECRET_RULES) out = out.replace(re, replace);
  out = out.replace(PUBLIC_HEX_BLOB, (m) => (GIT_SHA.test(m) ? m : "[REDACTED]"));
  // Loose first: it consumes whole separator-bearing runs, so running it after
  // the tight rule would only ever see the fragments the tight rule left.
  out = out.replace(PUBLIC_LOOSE_BLOB, (m) => (looksRandom(m, false) ? "[REDACTED]" : m));
  out = out.replace(PUBLIC_TIGHT_BLOB, (m) => (looksRandom(m, true) ? "[REDACTED]" : m));
  // Unpark last. A placeholder the worker wrote itself has no entry and is left
  // exactly as it was typed; every entry that does exist is already redacted
  // text, so restoring can only ever put back something safe.
  return out.replace(AUTH_PARK, (m, index: string) => parked[Number(index)] ?? m);
}

/**
 * Format a subprocess stderr tail for inclusion in an error message: redact
 * secrets first, then trim and keep only the last 400 characters (a stderr
 * blob is evidence, not a report). Returns "" when there is nothing worth
 * showing, so a caller can splice this straight into a template string
 * without an empty "; stderr:" suffix hanging off the end.
 */
export function stderrSuffix(stderr: string): string {
  const cleaned = redact(stderr).trim();
  return cleaned ? `; stderr: ${cleaned.slice(-400)}` : "";
}
