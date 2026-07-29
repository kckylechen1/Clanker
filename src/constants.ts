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
export const SERVER_VERSION = "0.4.7";

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

/**
 * Cursor-lane model shortnames. A SEPARATE namespace from OC_MODEL_ALIASES on
 * purpose: `composer` means `xai/grok-composer-2.5-fast` when opencode serves
 * it and `composer-2.5` when Cursor does — same word, different provider, and
 * merging the two maps would make one of them silently wrong.
 *
 * Every target is a real id from `cursor-agent`'s own model list (read off the
 * CLI's refusal message for an unknown model, 2026-07-28).
 */
export const CURSOR_MODEL_ALIASES: Readonly<Record<string, string>> = {
  composer: "composer-2.5",
  grok: "cursor-grok-4.5-high",
  codex53: "gpt-5.3-codex-high",
};

/**
 * The cursor lane's pinned default.
 *
 * Load-bearing exactly like DEFAULT_CODEX_MODEL above: cursor-agent's own
 * default is not stable — two back-to-back probes with no `--model` reported
 * `Cursor Grok 4.5` and `Cursor Grok 4.5 High Fast` — so an unpinned dispatch
 * cannot say what it ran on. cursor-acp.ts carries the same literal for
 * standalone runs; keep the two in sync (#13's shadowing hazard).
 */
export const DEFAULT_CURSOR_MODEL = "composer-2.5";

/** Expand a cursor model shortname to its full id; pass through unknown/full ids. */
export function resolveCursorModel(model: string | undefined): string | undefined {
  if (!model) return model;
  return CURSOR_MODEL_ALIASES[model.trim()] ?? model.trim();
}

/**
 * Model-family tokens for comparing `resolved_model` against `observed_model`.
 *
 * Three normalizations, each answering a shape that really occurs in the
 * telemetry corpus under ~/.cache/clanker/runs (589 records, read 2026-07-29 —
 * the counts below are from that scan, not from intuition):
 *
 *  1. DROP THE PROVIDER PREFIX. `kimi-for-coding/k3` and `k3` are the same
 *     model reached through different routing; `openai/x` vs `opencode/x`
 *     likewise. Treating a prefix difference as a swap is the one failure this
 *     comparison is explicitly not allowed to have — a false alarm on routing
 *     makes the real alarm unbelievable, and an unbelieved alarm is no alarm.
 *  2. LOWERCASE, and fold spaces/underscores onto `-`. The cursor lane reports
 *     the VENDOR'S DISPLAY NAME rather than the id it was handed (`Composer
 *     2.5` for `composer-2.5`) — see cursor-acp.ts, which reports it in the
 *     vendor's own spelling on purpose. 58 of the 589 records are exactly this
 *     pair and none of them is a swap.
 *  3. COMPARE AS A TOKEN PREFIX, not as strings. Cursor's display name can
 *     drop a trailing qualifier (`cursor-grok-4.5-high` reported as `Cursor
 *     Grok 4.5`, run cursor-1b5da), and cursor-acp.ts's own contract note says
 *     a reader "should compare model FAMILY, not string equality".
 *
 * The residual risk of (3) is real and accepted: `x-mini` would be read as the
 * same family as `x`. It buys silence on a recurring, structural false alarm
 * and costs a hypothetical one; no record in the corpus is silenced by it that
 * should have fired. Every genuine swap in the corpus survives all three steps
 * — `gpt-5.6-sol` vs `gpt-5.6-terra-fast` diverges at token 3, and everything
 * that fell back to `opencode/big-pickle` diverges at token 1.
 */
function modelFamilyTokens(id: string): string[] {
  const withoutProvider = id.slice(id.lastIndexOf("/") + 1);
  return withoutProvider.toLowerCase().replace(/[\s_]+/g, "-").split("-").filter((t) => t.length > 0);
}

/** True when `a` and `b` name the same model family under `modelFamilyTokens`'s rules. */
export function sameModelFamily(a: string, b: string): boolean {
  const [ta, tb] = [modelFamilyTokens(a), modelFamilyTokens(b)];
  if (ta.length === 0 || tb.length === 0) return false;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return shorter.every((token, i) => token === longer[i]);
}

/**
 * The #54 alarm: the backend ran a different model than the one Clanker asked
 * it for, and said so only by quietly filing a different `observed_model`.
 *
 * Why this is a warning and not a footnote: the run whose verdict gets filed
 * under the wrong model poisons the model's own profile card, so a defect
 * belonging to model A is recorded against model B. That has already cost this
 * machine four dispatches' worth of profile data once (opencode substituting
 * its bundled model when `kimi-for-coding` auth failed), and #54 is the second
 * occurrence on the same lane.
 *
 * Compares `resolved_model` — what Clanker DECIDED to run, after alias
 * expansion — and never `requested_model`. Comparing the request would fire on
 * all 26 corpus records where the caller passed a shortname (`kimi` observed as
 * `kimi-for-coding/k3`), i.e. it would call every correct alias expansion a
 * swap. Returns null when either side is unknown: an unreported `observed_model`
 * is missing evidence, not evidence of a swap.
 */
export function modelSwapWarning(
  resolvedModel: string | null | undefined,
  observedModel: string | null | undefined,
): string | null {
  const resolved = resolvedModel?.trim();
  const observed = observedModel?.trim();
  if (!resolved || !observed) return null;
  if (sameModelFamily(resolved, observed)) return null;
  // Names both sides in full, because the reader's next action is an
  // ATTRIBUTION decision — which model this verdict gets recorded against —
  // and "model mismatch" alone does not tell them which of the two won.
  return (
    `model swap: this run was dispatched to '${resolved}' (resolved_model) but the backend reports it ` +
    `actually ran '${observed}' (observed_model). Attribute this run's output — and any judgement about ` +
    `model quality drawn from it — to '${observed}', NOT to '${resolved}'.`
  );
}

/**
 * Lanes whose backend pins a load-bearing default model, so a write dispatch
 * may omit one.
 *
 * The rule this encodes: a write must never let the HARNESS's own interactive
 * configuration choose the model (that is how an opencode write could land on
 * an unintended provider). Where Clanker itself pins the default — codex via
 * DEFAULT_CODEX_MODEL, cursor via DEFAULT_CURSOR_MODEL — the caller omitting a
 * model still yields a known, reproducible model, so the requirement would only
 * be ceremony. Membership is a claim about backends.ts and must be checked
 * there before a lane is added.
 */
export const LANES_WITH_PINNED_WRITE_MODEL: ReadonlySet<string> = new Set(["codex", "cursor"]);

/**
 * Lanes whose BACKEND can be told to continue its own conversation, so a
 * correction turn is a fresh spawn carrying that conversation's id rather than
 * a second prompt on a live ACP session (#43; see lane-session.ts and
 * resume.ts).
 *
 * A capability TABLE rather than a lane check inside promptExisting: the two
 * correction shapes are a property of the lane's backend, and the day a second
 * lane grows `--resume` the change has to be one entry here plus that lane's
 * own sidecar — not another branch in the manager, where nobody looking for
 * "which lanes can resume" would think to look.
 *
 * Membership is a claim about the lane's CLI and must be measured before a lane
 * is added. cursor's was: `cursor-agent -p --resume <session_id> --model <other
 * model>` continued the conversation across a model change (2026-07-28) — which
 * is what makes the resume path a per-turn model hand-off and not just a retry.
 */
export const LANES_WITH_RESUME: ReadonlySet<string> = new Set(["cursor"]);

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
