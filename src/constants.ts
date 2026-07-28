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
 * the subprocess is killed, so a job cannot hang forever.
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

/**
 * Age after which a run's cold forensic streams are reclaimed (see
 * `retention.ts`). `0` disables the sweep entirely. Only `events.jsonl` and
 * `chunks.log` are ever affected; `telemetry.json` and `result.md` are kept for
 * the life of the run directory.
 */
export const RUN_STREAM_TTL_MS = envInt("CLANKER_RUN_STREAM_TTL_DAYS", 3) * 86_400_000;

/** Root under which server-managed git worktrees are created. */
export const WORKTREES_ROOT =
  process.env.CLANKER_WORKTREES_ROOT ??
  path.join(os.homedir(), ".cache", "clanker", "worktrees");

/**
 * Host git repository the MCP server was launched from. Defaults to the
 * directory Claude Code started it in. This is only the FALLBACK cut point for
 * a worktree dispatch that carries no cwd — a dispatch with a cwd is cut from
 * the repo that cwd belongs to instead (#12, see manager.ts / worktree.ts). The
 * base ref is resolved per target repo (that repo's own HEAD → origin/HEAD →
 * origin/main → origin/master, see worktree.ts resolveBaseRef / #33), not
 * hardcoded to origin/main.
 */
export const BASE_REPO = process.env.CLANKER_MCP_BASE_REPO ?? process.cwd();

export const SERVER_NAME = "clanker-mcp-server";
export const SERVER_VERSION = "0.3.8";

/**
 * Load-bearing default: without an explicit override, the codex lane must
 * still pin a known model/effort — never leave `codexConfig.model` /
 * `model_reasoning_effort` unset and let codex-acp fall back to whatever
 * `~/.codex/config.toml` happens to say. That file is not Clanker's to own;
 * an out-of-band edit to it (e.g. 2026-07-26 01:04, source unknown) silently
 * swapped every dispatch onto `gpt-5.3-codex-spark` with zero signal to the
 * dispatcher — telemetry only reported it after the fact via observed_model.
 * Dispatch has to be reproducible: a lane card's model profile is meaningless
 * if the model it names can drift underneath it. Same shape as the gemini
 * lane's `|| "gemini-3.6-flash-high"` default in backends.ts.
 */
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_EFFORT = "xhigh";

/**
 * Workspace-discipline prefix prepended server-side to the prompt of every
 * WRITE-class dispatch (manager.ts, exactly one place, after the final
 * readOnly is computed — so read-only dispatches, and gemini which is forced
 * read-only, never see it). Until this existed, the discipline below lived
 * only in the dispatcher's prose request to the worker: a lane that dropped
 * or paraphrased it faced no structural consequence. The server now owns the
 * injection, so the words the worker is held to are the words it was handed.
 * Kept byte-stable: tests compare the lane-visible prompt against it verbatim.
 */
export const WRITE_DISCIPLINE_PREFIX = `Workspace discipline, enforced by the dispatching contract — these override any
convenience you would otherwise prefer:

- Stage precise paths. Never \`git add -A\`: a single sweep once pulled three
  sibling worktrees and another session's untracked WIP into one 62,000-line
  commit. After committing, read the change summary and confirm nothing rode in.
- Run side-effecting steps one command at a time and read each output. Never
  chain them with \`&&\`: when the first link fails the rest are skipped silently,
  and that is how "verified" gets reported for work that never ran.
- Commit inside your worktree. Do not push, do not open a pull request — opening
  a PR is the adjudicator's act, not yours.
- Never weaken a frozen assertion. If an acceptance check cannot pass, STOP and
  report back; do not edit the test, add a skip, or relax the assertion to reach
  green.
- Deliver evidence, not claims: paste the verbatim command output. If you could
  not obtain something, say so plainly — "I could not get this" is a valid
  delivery; composing a plausible result is the worst failure mode there is.`;

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
