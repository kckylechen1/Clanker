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
 */
const SECRET_PATTERN = /(api[_-]?key|token|secret|authorization|bearer)(\s*[=:]\s*)\S+/gi;
export function redact(text: string): string {
  return text.replace(SECRET_PATTERN, (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`);
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
