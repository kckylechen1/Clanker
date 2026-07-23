/**
 * Shared constants and env-derived configuration for the Clanker MCP server.
 *
 * Thresholds are provisional (per doctrine: no flat magic numbers baked as
 * final) and overridable by env so the leader can calibrate from telemetry.
 */
import os from "node:os";
import path from "node:path";

/** Default silence threshold before a running Clanker is flagged as suspected-stall. */
export const DEFAULT_STALL_THRESHOLD_MS = envInt("CLANKER_STALL_THRESHOLD_MS", 300_000);

/** Handshake (initialize + session/new) timeout before a Clanker spawn is failed. */
export const HANDSHAKE_TIMEOUT_MS = envInt("CLANKER_HANDSHAKE_TIMEOUT_MS", 30_000);

/** Grace after SIGTERM before LaneConnection escalates to SIGKILL. */
export const PROCESS_TERM_GRACE_MS = envInt("CLANKER_PROCESS_TERM_GRACE_MS", 2_000);

/** Grace for cooperative ACP cancellation before the backend is killed. */
export const CANCEL_GRACE_MS = envInt("CLANKER_CANCEL_GRACE_MS", 5_000);

/**
 * Hard per-turn ceiling. suspected_stall is only a warning; this timeout is the
 * guaranteed path to a terminal state — on hit the turn is forced to `error` and
 * the subprocess is killed, so clanker_dispatch can never hang forever.
 */
export const TURN_TIMEOUT_MS = envInt("CLANKER_TURN_TIMEOUT_MS", 2_700_000);

/** Default long-poll window for clanker_wait. */
export const DEFAULT_WAIT_MS = envInt("CLANKER_WAIT_DEFAULT_MS", 30_000);

/**
 * Hard cap on clanker_wait timeout. Kept below the typical MCP client request
 * timeout so a wait always returns before the transport gives up.
 */
export const MAX_WAIT_MS = envInt("CLANKER_WAIT_MAX_MS", 55_000);

/** Rough character budget for a clanker_wait digest (~500 tokens). */
export const DIGEST_CHAR_BUDGET = envInt("CLANKER_DIGEST_CHAR_BUDGET", 2_000);

/** Character budget for a returned final_message before truncation. */
export const FINAL_MESSAGE_CHAR_BUDGET = envInt(
  "CLANKER_FINAL_MESSAGE_CHAR_BUDGET",
  20_000,
);

/**
 * Backoff before the single automatic retry of a capacity-transient backend
 * failure (see failure-classifier.ts isCapacityTransient). Applies only to a
 * fresh dispatch's first turn — CLANKER-INFRA-FAILURE never retries here.
 */
export const CAPACITY_RETRY_BACKOFF_MS = envInt("CLANKER_CAPACITY_RETRY_BACKOFF_MS", 30_000);

/** Experimental: project ACP plan progress as MCP notifications/progress. */
export const PROGRESS_EXPERIMENTAL = process.env.CLANKER_PROGRESS_EXPERIMENTAL === "1";

/** Root under which run artifacts (events.jsonl, chunks.log) are written. */
export const RUNS_ROOT =
  process.env.CLANKER_RUNS_ROOT ??
  path.join(os.homedir(), ".cache", "clanker", "runs");

/** Root under which server-managed git worktrees are created. */
export const WORKTREES_ROOT =
  process.env.CLANKER_WORKTREES_ROOT ??
  path.join(os.homedir(), ".cache", "clanker", "worktrees");

/**
 * Base git repository from which worktrees are cut. Defaults to the directory
 * Claude Code launched the server from. Cut always happens from origin/main.
 */
export const BASE_REPO = process.env.CLANKER_MCP_BASE_REPO ?? process.cwd();

export const SERVER_NAME = "clanker-mcp-server";
export const SERVER_VERSION = "0.3.0";

/**
 * Single source of truth for opencode model shortnames (mirrors the /oc-dispatch
 * habit). Resolved server-side by the opencode lane so commands can pass a
 * shortname or a full `provider/model` id interchangeably.
 */
export const OC_MODEL_ALIASES: Readonly<Record<string, string>> = {
  glm: "zhipuai-coding-plan/glm-5.2",
  ds: "deepseek/deepseek-v4-pro",
  kimi: "kimi-for-coding/k3",
  free: "opencode/deepseek-v4-flash-free",
  composer: "xai/grok-composer-2.5-fast",
  grok45: "xai/grok-4.5",
};

/** Expand an opencode model shortname to its full id; pass through unknown/full ids. */
export function resolveOcModel(model: string | undefined): string | undefined {
  if (!model) return model;
  return OC_MODEL_ALIASES[model] ?? model;
}

const GLM_PROVIDER_PREFIX = `${OC_MODEL_ALIASES.glm.split("/", 1)[0]}/`;

/** True when a shortname or full model id resolves to the supervised GLM provider. */
export function isGlmModel(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;
  return resolveOcModel(normalized)?.toLowerCase().startsWith(GLM_PROVIDER_PREFIX) ?? false;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
