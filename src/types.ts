/** Shared TypeScript types for the Clanker MCP server. */

export const LANE_NAMES = ["codex", "opencode", "grok", "gemini"] as const;

export type LaneName = (typeof LANE_NAMES)[number];

export type RunStatus = "running" | "done" | "error" | "cancelled";

/** Concrete spawn recipe for one lane, resolved from the registry. */
export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Warnings surfaced back to the caller (e.g. a requested model override the
   * lane cannot honor). Non-empty warnings never fail the dispatch silently —
   * they are echoed in the tool response.
   */
  warnings: string[];
}

/**
 * codex-native sandbox strictness, independent of the Clanker-level
 * `readOnly` gate. Values mirror codex-acp's own AgentMode.sandboxMode
 * labels (verified against codex-acp 1.1.2 source, INITIAL_AGENT_MODE env):
 *   - "read-only"          -> INITIAL_AGENT_MODE=read-only (no writes at all)
 *   - "workspace-write"    -> INITIAL_AGENT_MODE=agent (writes boxed to the
 *                             session cwd + tmp — the review-seat sweet spot:
 *                             `cargo test`/`go test` can write build/test
 *                             caches, but nothing outside the workspace)
 *   - "danger-full-access" -> INITIAL_AGENT_MODE=agent-full-access (writes
 *                             anywhere, no sandbox; requires an explicit
 *                             override)
 * Only the codex lane honors this caller-selected override. Grok has its own
 * fixed read-only/workspace sandbox mapping derived from `readOnly`, while
 * opencode uses its fixed worker permission profile; both warn and ignore
 * this codex-specific option.
 */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Per-lane request options that influence the spawn recipe. */
export interface LaneRequestOptions {
  model?: string;
  effort?: string;
  readOnly?: boolean;
  /** codex-only sandbox strictness override — see CodexSandboxMode. */
  sandbox?: CodexSandboxMode;
  /** Fixed Clanker-controlled OpenCode profile. */
  profile?: "worker" | "kimi-crew";
  /**
   * Vault-sourced env vars the dispatch profile declares (profiles.ts
   * `secrets`). Non-empty routes the spawn through `tachi vault exec
   * --keychain --require <vars> --` so the secret is materialized from the OS
   * keychain into the child at spawn time. Unioned with the model-derived
   * requirement in backends.ts, which stays authoritative on its own: a GLM
   * spawn is wrapped because it is GLM, not because a profile remembered to
   * say so.
   */
  secrets?: readonly string[];
  /**
   * gemini-only role selector: the dispatch profile id that owns this run
   * (e.g. "gemini-recon" / "gemini-research"). backends.ts forwards it as
   * CLANKER_GEMINI_ROLE so the shared sidecar picks the profile's role copy.
   */
  geminiRole?: string;
}

/** Plan projection derived from ACP `plan` events. */
export interface PlanState {
  entries: PlanEntrySnapshot[];
  completed: number;
  inProgress: number;
  pending: number;
  total: number;
  /** content of the first in_progress entry, if any. */
  currentStep: string | null;
}

export interface PlanEntrySnapshot {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Compact status view returned by clanker_status / embedded in clanker_list. */
export interface LaneStatusView {
  id: string;
  lane: LaneName;
  status: RunStatus;
  plan_summary: string;
  plan: PlanState;
  tool_calls: number;
  last_event_age_ms: number;
  suspected_stall: boolean;
  cwd: string;
  /** Absolute run directory (events.jsonl / chunks.log / telemetry.json / result.md). */
  run_dir: string;
  /** Absolute path of the terminal-judgment artifact, present only once it exists and is non-empty. */
  result_path?: string;
  worktree?: string;
  /** Present when status is "error" — same text clanker_wait would surface (advisory-annotated for infra failures). */
  error?: string;
  /** Present alongside `error` when classifyTurnFailure tagged it (e.g. CLANKER-INFRA-FAILURE). */
  failure_class?: string;
  telemetry?: RunTelemetry;
}

export interface RunTelemetry {
  host: import("./host.js").ClankerHost;
  requested_lane: LaneName;
  actual_lane: LaneName;
  requested_model?: string; resolved_model?: string | null; observed_model?: string | null;
  requested_effort?: string; observed_effort?: string | null;
  lane: LaneName; transport: "acp-stdio"; backend: string; read_only: boolean;
  sandbox?: CodexSandboxMode;
  /**
   * Full SHA the worktree was cut from when the dispatcher supplied an
   * explicit `base` (verified server-side, worktree.ts resolveBaseCommit).
   * Absent when the repo's default base resolution was used.
   */
  base_sha?: string;
  /** Hard per-turn ceiling actually in force for this run (per-profile, see profiles.ts). */
  turn_timeout_ms?: number;
  created_at: string; started_at?: string;
  terminal_at?: string; duration_ms?: number; turns: number; retries: number; corrections: number;
  continuation_turns: number; cancellation_requested: boolean; forced_kill: boolean;
  tool_calls: number; stop_reason?: string; terminal_reason?: string;
  prompt_usage?: PromptUsageTelemetry;
  /** Latest ACP session usage: tokens currently in context and cumulative session cost. */
  session_usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
}

/** Structured fallback when an in-process/stale caller reaches the host-policy handler. */
export interface DispatchPolicyTelemetry {
  host: import("./host.js").ClankerHost;
  requested_lane: LaneName;
  actual_lane: null;
  blocked_reason: string;
}

/** Safe projection of ACP PromptResponse.usage; protocol extension metadata is deliberately excluded. */
export interface PromptUsageTelemetry {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

/**
 * One `doNotTouch` pattern that a finished run violated, with the concrete
 * file paths that matched it. Surfaced on the terminal wait payload as
 * `contract_violations` and written into `result.md`; never flips the run's
 * status — the violation is reported, not re-adjudicated.
 */
export interface ContractViolation {
  pattern: string;
  files: string[];
}

/** Result payload attached once a run reaches a terminal state. */
export interface RunFinal {
  final_message: string;
  touched_files: string[];
  plan_final: PlanState;
  /** Present when the run terminated abnormally. */
  error?: string;
  /** Worktree path retained because it held changes, if any. */
  worktree_retained?: string;
}
