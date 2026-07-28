/**
 * Grok diagnostics — reads Grok CLI's own log to recover the real error its
 * ACP bridge swallows.
 *
 * Issue #9: Grok's ACP bridge turns a backend HTTP 402 (balance exhausted)
 * into a bare JSON-RPC -32603 "Internal error" — the real status_code and
 * message never reach Clanker's captured stderr. They do land in Grok's own
 * private log at `$GROK_HOME/logs/unified.jsonl`, one JSON line appended per
 * event (including one line per inference attempt/failure). This module
 * tails that file for the failing turn's time window and surfaces the
 * underlying status_code + message.
 *
 * Schema below is hand-verified (not just quoted from the issue) against a
 * live `~/.grok/logs/unified.jsonl` on this machine, 2026-07-28, grok CLI
 * v0.2.111. A representative failure pair looks like:
 *
 *   {"ts":"2026-07-24T03:26:54.663Z","lvl":"error",
 *    "msg":"shell.turn.inference_failed",
 *    "ctx":{"status_code":402,
 *           "message":"API error (status 402 Payment Required): Grok Build usage balance exhausted", ...}}
 *   {"ts":"2026-07-24T03:26:54.663Z","lvl":"warn",
 *    "msg":"turn.terminal_failure",
 *    "ctx":{"status_code":402,
 *           "message":"API error (status 402 Payment Required): Grok Build usage balance exhausted", ...}}
 *
 * Two field-name gotchas the issue's excerpt didn't make obvious: `ts` is an
 * ISO-8601 string, not epoch millis; and the failure tag lives on `msg`
 * (e.g. "shell.turn.inference_failed" / "turn.terminal_failure"), not on a
 * `kind`/`type` field — `ctx.kind` (when present) is instead a coarse class
 * like "api" and does not itself say "failed".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the Grok CLI's config/log directory the same way the installed
 * binary does: `$GROK_HOME` when set, else `$HOME/.grok`. Verified via
 * `strings` on the installed `grok` binary, which embeds its own docs:
 * "GROK_HOME | Override config directory (default: `~/.grok`)" and
 * "no user grok home (set $GROK_HOME or $HOME)". Shared by backends.ts's
 * spawn-env fix and this module's log tail so both agree on one location —
 * see backends.ts's grok case for why the env var is pinned explicitly there.
 */
export function resolveGrokHome(): string {
  return process.env.GROK_HOME ?? path.join(os.homedir(), ".grok");
}

const FAILURE_MSG_PATTERN = /inference_failed|terminal_failure/;

/**
 * Tail `$GROK_HOME/logs/unified.jsonl` for the last inference_failed /
 * terminal_failure line whose timestamp falls in `[turnStartMs, now]`, and
 * return its `status_code` + `message` as one string. Returns `null` on any
 * read/parse failure, missing file, or no matching line in the window —
 * never throws, since this is best-effort diagnostic enrichment layered onto
 * an already-failed turn, not a control-flow path that itself may fail.
 */
export function grokFailureDetail(turnStartMs: number, now: number = Date.now()): string | null {
  try {
    const logPath = path.join(resolveGrokHome(), "logs", "unified.jsonl");
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.split("\n");
    // Scan backward: the first match encountered this way is the most recent
    // qualifying line, which is exactly "the last matching line in the window".
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !FAILURE_MSG_PATTERN.test(line)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const rec = parsed as { ts?: unknown; msg?: unknown; ctx?: { status_code?: unknown; message?: unknown } };
      if (typeof rec.msg !== "string" || !FAILURE_MSG_PATTERN.test(rec.msg)) continue;
      const ts = typeof rec.ts === "string" ? Date.parse(rec.ts) : NaN;
      if (!Number.isFinite(ts) || ts < turnStartMs || ts > now) continue;
      const statusCode = rec.ctx?.status_code;
      const message = rec.ctx?.message;
      if (statusCode === undefined && message === undefined) continue;
      return `Grok backend error — status_code=${statusCode ?? "?"} message=${message ?? "?"}`;
    }
    return null;
  } catch {
    return null;
  }
}
