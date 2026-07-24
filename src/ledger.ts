/**
 * Native dispatch-ledger writer.
 *
 * Since v0.3.0's unified clanker_start, MCP-direct dispatches never pass
 * through the host harness's PostToolUse hook (matcher "Agent|Workflow") —
 * that hook only fires for Task/Agent-tool invocations, not for calls made
 * directly against this MCP server. Result: MCP-direct jobs silently vanish
 * from ~/.agents/dispatch-ledger/ledger.jsonl, and downstream tooling
 * (query.py) never sees them.
 *
 * Fix: LaneRun itself appends one row when a run reaches its true terminal
 * state — wired from the tail of `completeTurn()`/`failTurn()`/`cancelTurn()`
 * in run.ts (see LaneRun.writeLedgerRowOnce()'s doc comment for why NOT
 * manager.ts's `close()`/`closeRun()`, despite that being the more obvious
 * "single choke point" candidate: in this one-shot job controller, every
 * `close()` call site runs strictly *before* the matching
 * completeTurn/failTurn/cancelTurn call, so turnStatus/error are still
 * unset at closeRun() time). Every lifecycle path (normal done/error/
 * cancelled turn, idle-reaper close, the cancel()-driven forced kill, and
 * server shutdown()) eventually drives exactly one of those three methods
 * exactly once per run — each already guarded by the same
 * `isTerminalTurn()` check (per-run state, not a module-level set) that
 * makes the first one to fire win and every later one for the same run a
 * no-op.
 *
 * Fail-silent by design: a ledger write must NEVER fail or delay terminal
 * handling of a real dispatch. Any exception here is swallowed and logged to
 * hook_errors.log instead of propagating.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEDGER_DIR =
  process.env.CLANKER_LEDGER_DIR ?? path.join(os.homedir(), ".agents", "dispatch-ledger");
const LEDGER_PATH = path.join(LEDGER_DIR, "ledger.jsonl");
const HOOK_ERRORS_PATH = path.join(LEDGER_DIR, "hook_errors.log");

const PROMPT_HEAD_CHAR_BUDGET = 200;
const ERROR_CLASS_CHAR_BUDGET = 200;
/** Default caller-selectable agent profile name; every lane currently retires
 * override capability (see LaneRequestOptions.profile in types.ts, whose only
 * non-default value today is "kimi-crew" for the OpenCode GLM lane), so in
 * practice this is the value seen on the overwhelming majority of runs — the
 * `:profile` suffix exists so a non-default profile (e.g. kimi-crew) is still
 * visible in the ledger's agent_type column. */
const DEFAULT_AGENT_PROFILE = "worker";

export interface LedgerRunInput {
  /** Run id, e.g. "codex-39cad" — used verbatim as `label`. */
  id: string;
  lane: string;
  /** Dispatch cwd (worktree path or base repo) at the time the run was created. */
  cwd: string;
  /** LaneRequestOptions.profile — undefined for the overwhelming majority of runs today. */
  agentProfile?: string;
  /** Resolved model (see LaneRun.telemetry().resolved_model), else null. */
  model: string | null;
  /** The dispatch's original prompt (first turn) — never the arg to a later clanker_prompt continuation. */
  initialPrompt: string;
  /** run.turnStatus at close() time. */
  turnStatus: string;
  /** run.error at close() time, present only when turnStatus === "error". */
  error?: string;
}

/** Exactly the 13 keys downstream query.py greps for; do not add/remove/rename. */
export interface LedgerRow {
  ts: string;
  session: null;
  repo: string;
  tool: "ClankerMCP";
  agent_type: string;
  model: string | null;
  label: string;
  prompt_head: string;
  outcome: "blocked" | null;
  review: null;
  refix_rounds: null;
  error_class: string | null;
  lesson_ref: null;
}

export function buildLedgerRow(input: LedgerRunInput): LedgerRow {
  const profile = input.agentProfile ?? DEFAULT_AGENT_PROFILE;
  const agentType = profile !== DEFAULT_AGENT_PROFILE ? `${input.lane}:${profile}` : input.lane;
  const isError = input.turnStatus === "error";
  return {
    ts: new Date().toISOString(),
    session: null,
    repo: input.cwd,
    tool: "ClankerMCP",
    agent_type: agentType,
    model: input.model ?? null,
    label: input.id,
    prompt_head: input.initialPrompt.slice(0, PROMPT_HEAD_CHAR_BUDGET),
    outcome: isError ? "blocked" : null,
    review: null,
    refix_rounds: null,
    error_class: isError && input.error ? input.error.slice(0, ERROR_CLASS_CHAR_BUDGET) : null,
    lesson_ref: null,
  };
}

/**
 * Append one ledger row for a run at terminal state. Never throws: any
 * failure (missing dir, disk full, permissions) is best-effort logged to
 * hook_errors.log and otherwise swallowed so it can never fail or delay the
 * caller's terminal handling.
 */
export function appendLedgerRow(input: LedgerRunInput): void {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(buildLedgerRow(input)) + "\n");
  } catch (error) {
    logHookError(input.id, error);
  }
}

function logHookError(runId: string, error: unknown): void {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    fs.appendFileSync(
      HOOK_ERRORS_PATH,
      `[${new Date().toISOString()}] native-ledger-writer append failed for run '${runId}': ${message}\n`,
    );
  } catch {
    /* truly best-effort: even the error-log write failed, swallow it */
  }
}
