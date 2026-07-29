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
 * The one carve-out is bare 40/64-char lowercase hex — git SHAs, which are the
 * single most load-bearing token in this repo's verdicts ("base ebd72ed…",
 * "regressed at <sha>"). Blanking those would gut the accounting this feature
 * exists to keep, and a secret that happens to be exactly-40 lowercase hex and
 * appears with no key name, no prefix and no URL around it is a shape this
 * codebase has never seen.
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
  // `Authorization: Bearer <token>` / `token <token>`. `redact()` already blanks
  // the value after a COLON, which on this header leaves the scheme word behind
  // and the token itself untouched ("Authorization: [REDACTED] ghp_…"); this
  // rule takes the value that follows the scheme instead. Gated on a digit and
  // 12+ characters so ordinary prose about tokens ("the token is staged in a
  // file") is not shredded — a real credential essentially always carries one.
  { re: /\b(bearer|token)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/gi, replace: "$1$2[REDACTED]" },
  // URL userinfo: `https://user:pass@host` and the token-as-username form
  // `https://ghp_xxx@host`. The password half is always a credential; a lone
  // userinfo in a machine-generated URL is one too.
  { re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@:]+):[^\s/@]+@/g, replace: "$1$2:[REDACTED]@" },
  { re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]{8,}@/g, replace: "$1[REDACTED]@" },
];
/**
 * Long high-entropy runs. `/` is excluded from the character class even though
 * base64 uses it: with it, `Users/kckylechen/Projects/Clanker` is a 33-char
 * match and every absolute path in every verdict — the file:line evidence a
 * review is made of — would be blanked. Real base64 blobs still trip this
 * (a `/` appears about once per 64 characters, so a key of any length still
 * carries a 32+ run without one).
 */
const PUBLIC_LONG_BLOB = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function redactForPublic(text: string): string {
  let out = redact(text);
  for (const { re, replace } of PUBLIC_SECRET_RULES) out = out.replace(re, replace);
  return out.replace(PUBLIC_LONG_BLOB, (match) => (GIT_SHA.test(match) ? match : "[REDACTED]"));
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
