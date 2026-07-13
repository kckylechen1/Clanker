/** Shared TypeScript types for the Clanker MCP server. */

export const LANE_NAMES = ["codex", "opencode", "grok"] as const;

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

/** Per-lane request options that influence the spawn recipe. */
export interface LaneRequestOptions {
  model?: string;
  effort?: string;
  readOnly?: boolean;
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
  worktree?: string;
  /** Present when status is "error" — same text clanker_wait would surface (advisory-annotated for infra failures). */
  error?: string;
  /** Present alongside `error` when classifyTurnFailure tagged it (e.g. CLANKER-INFRA-FAILURE). */
  failure_class?: string;
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
