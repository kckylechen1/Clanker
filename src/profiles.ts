/**
 * Dispatch-profile registry — the single source of truth for *what a dispatch
 * is allowed to be*.
 *
 * Before this file, capability lived in optional parameters of one generic
 * `clanker_start` (`lane` / `read_only` / `sandbox` / `model`), so any seat
 * holding that tool could ask for any lane, any write permission, any sandbox.
 * 0.2.x had the opposite property and stated it in the seat prompts: "its only
 * start tool has no `read_only` argument and the server always forces
 * readOnly: true. You cannot start a write worker." A parameter that does not
 * exist in the schema is a capability a seat cannot lie about.
 *
 * A profile welds one whole capability combination behind one name. `tools.ts`
 * generates one narrow `clanker_start_<id>` per profile whose input schema
 * exposes only that profile's FREE parameters; every welded dimension is
 * absent from the schema, not merely overwritten by the handler. Adding a lane
 * or a mode is a row here, not another hand-written tool.
 *
 * Runtime enforcement still lives in LaneManager (host gate, gemini read-only,
 * write isolation, cross-repo worktree cut, writeCapableSandbox). This registry
 * narrows the entrance; it does not restate or replace those gates.
 */
import { TURN_TIMEOUT_MS } from "./constants.js";
import type { CodexSandboxMode, LaneName } from "./types.js";
import { LANE_NAMES } from "./types.js";

/** Whether a managed worktree is forbidden (strict read) or mandatory (write). */
export type ProfileIsolation = "forbidden" | "required";

/** `sonnet` marks the supervised-GLM shape: the seat holding it is a Sonnet supervisor with correction/cancel rights. */
export type ProfileSupervision = "none" | "sonnet";

export type ProfileRoleClass = "scout" | "reviewer" | "implementer";

/**
 * Where the model id comes from.
 *  - `welded`         — fixed by the profile; callers cannot name a model.
 *  - `lane-default`   — omitted on purpose; the lane's own configured default runs.
 *  - `caller-required`— the lane fails closed without an explicit model
 *                       (backends.ts opencode guard), and no single model is
 *                       correct for the profile, so the caller must name one.
 */
export type ProfileModelPolicy =
  | { readonly kind: "welded"; readonly id: string }
  | { readonly kind: "lane-default" }
  | { readonly kind: "caller-required" };

export interface DispatchProfile {
  /** Profile id — this string IS the public interface (`clanker_start_<id>`). */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Welded backend lane. */
  readonly lane: LaneName;
  readonly model: ProfileModelPolicy;
  /** Welded Clanker-level write gate. */
  readonly readOnly: boolean;
  /** Welded codex-native sandbox strictness; only set on the codex lane (other lanes warn on it). */
  readonly sandbox?: CodexSandboxMode;
  readonly isolation: ProfileIsolation;
  /** Vault-sourced env vars this profile needs; non-empty routes the spawn through `tachi vault exec`. */
  readonly secrets: readonly string[];
  /** Per-profile hard turn ceiling (overridable by CLANKER_TURN_TIMEOUT_MS_<ID>). */
  readonly turnTimeoutMs: number;
  readonly supervision: ProfileSupervision;
  readonly roleClass: ProfileRoleClass;
  /** OpenCode agent profile selected inside the opencode lane. */
  readonly ocProfile?: "worker" | "kimi-crew";
  /** `dormant` profiles stay registered but are known to be unusable right now (reason in `dormantReason`). */
  readonly status: "active" | "dormant";
  readonly dormantReason?: string;
}

/**
 * Gemini's ACP sidecar hard-caps a single `agy` print at 10m and classifies
 * timeout-vs-crash there (#13, gemini-acp.ts). A 45m manager ceiling on a lane
 * whose turn physically cannot exceed ~10m is dead weight; 11m keeps the
 * manager ceiling just *above* the sidecar's so the sidecar's classification
 * still fires first instead of being preempted.
 */
const GEMINI_TURN_TIMEOUT_MS = 660_000;

export const DISPATCH_PROFILES: readonly DispatchProfile[] = [
  {
    id: "codex-review",
    title: "Codex cold review (read-only, in place)",
    description:
      "Read-only Codex review. lane, read_only=true and sandbox=read-only are welded server-side: " +
      "the sandbox is welded because a Codex dispatch with read_only=true but a write-capable native " +
      "sandbox can still write the workspace, so leaving sandbox callable would be a way around the " +
      "read-only gate. Runs in place; no worktree.",
    lane: "codex",
    model: { kind: "lane-default" },
    readOnly: true,
    sandbox: "read-only",
    isolation: "forbidden",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "reviewer",
    status: "active",
  },
  {
    id: "codex-write",
    title: "Codex implementation (isolated worktree)",
    description:
      "Write-capable Codex worker. read_only=false and sandbox=workspace-write are welded and a " +
      "managed worktree branch is mandatory, so writes are boxed to the worktree. Model omitted on " +
      "purpose: Codex runs its configured default.",
    lane: "codex",
    model: { kind: "lane-default" },
    readOnly: false,
    sandbox: "workspace-write",
    isolation: "required",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "implementer",
    status: "active",
  },
  {
    id: "oc-review",
    title: "OpenCode cold review (read-only, in place)",
    description:
      "Read-only OpenCode review on the fixed clanker-worker permission profile. read_only=true is " +
      "welded; no worktree. An explicit model is required: omitting it lets OpenCode's own interactive " +
      "config pick the provider (possibly GLM) outside the vault-exec credential wrap.",
    lane: "opencode",
    model: { kind: "caller-required" },
    readOnly: true,
    isolation: "forbidden",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "reviewer",
    ocProfile: "worker",
    status: "active",
  },
  {
    id: "oc-write",
    title: "OpenCode implementation (isolated worktree)",
    description:
      "Write-capable OpenCode worker on the fixed clanker-worker permission profile. read_only=false is " +
      "welded and a managed worktree branch is mandatory. An explicit non-GLM model is required; GLM " +
      "writes are rejected here and belong to the supervised oc-glm-write profile.",
    lane: "opencode",
    model: { kind: "caller-required" },
    readOnly: false,
    isolation: "required",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "implementer",
    ocProfile: "worker",
    status: "active",
  },
  {
    id: "oc-glm-write",
    title: "Supervised GLM implementation (isolated worktree)",
    description:
      "The only supervised GLM write shape. lane=opencode, model=glm and read_only=false are welded, a " +
      "managed worktree branch is mandatory, ZHIPUAI_API_KEY is materialized from the OS keychain " +
      "through `tachi vault exec` at spawn time, and the profile requires a Sonnet supervisor seat that " +
      "can correct or cancel the worker.",
    lane: "opencode",
    model: { kind: "welded", id: "glm" },
    readOnly: false,
    isolation: "required",
    secrets: ["ZHIPUAI_API_KEY"],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "sonnet",
    roleClass: "implementer",
    ocProfile: "worker",
    status: "active",
  },
  {
    id: "oc-kimi-crew",
    title: "Kimi Crew (OpenCode-owned multi-agent profile)",
    description:
      "Runs the installed OpenCode `kimi-crew` profile, which owns its own child agents, prompts and " +
      "permissions. lane=opencode, model=kimi and read_only=false are welded and a managed worktree " +
      "branch is mandatory. Not a GLM lane and not externally supervised.",
    lane: "opencode",
    model: { kind: "welded", id: "kimi" },
    readOnly: false,
    isolation: "required",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "implementer",
    ocProfile: "kimi-crew",
    status: "active",
  },
  {
    id: "gemini-recon",
    title: "Gemini reconnaissance (read-only, in place)",
    description:
      "Read-only Gemini survey. The lane is reconnaissance-only server-side and rejects both write mode " +
      "and worktrees; the model defaults to the sidecar's configured Gemini model.",
    lane: "gemini",
    model: { kind: "lane-default" },
    readOnly: true,
    isolation: "forbidden",
    secrets: [],
    turnTimeoutMs: GEMINI_TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "scout",
    status: "active",
  },
  {
    id: "grok-review",
    title: "Grok cold review (read-only, in place)",
    description:
      "Read-only Grok review with Clanker's own native containment flags. read_only=true is welded; no " +
      "worktree. Currently dormant: the account returns HTTP 402 (out of credit).",
    lane: "grok",
    model: { kind: "caller-required" },
    readOnly: true,
    isolation: "forbidden",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "reviewer",
    status: "dormant",
    dormantReason: "grok account is out of credit (HTTP 402)",
  },
  {
    id: "grok-write",
    title: "Grok implementation (isolated worktree)",
    description:
      "Write-capable Grok worker with a native workspace sandbox. read_only=false is welded and a " +
      "managed worktree branch is mandatory; an explicit model is required. Currently dormant: the " +
      "account returns HTTP 402 (out of credit).",
    lane: "grok",
    model: { kind: "caller-required" },
    readOnly: false,
    isolation: "required",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "implementer",
    status: "dormant",
    dormantReason: "grok account is out of credit (HTTP 402)",
  },
];

export const PROFILE_IDS = DISPATCH_PROFILES.map((p) => p.id) as [string, ...string[]];

const BY_ID = new Map(DISPATCH_PROFILES.map((p) => [p.id, p]));

export function getProfile(id: string): DispatchProfile {
  const profile = BY_ID.get(id);
  if (!profile) throw new Error(`unknown profile '${id}'; expected one of ${PROFILE_IDS.join(", ")}`);
  return profile;
}

/**
 * lane × write-mode combinations that intentionally have no profile, with the
 * server-side reason. Anything NOT listed here must have a profile, or the
 * registry silently dropped a live dispatch shape during a migration.
 */
export const UNREACHABLE_COMBINATIONS: readonly { lane: LaneName; readOnly: boolean; reason: string }[] = [
  {
    lane: "gemini",
    readOnly: false,
    reason: "the gemini lane is reconnaissance-only; LaneManager and buildSpawnSpec both reject write-capable gemini dispatches",
  },
];

/** Every lane × write-mode combination that is reachable and therefore needs a profile. */
export function requiredCombinations(): { lane: LaneName; readOnly: boolean }[] {
  const combos: { lane: LaneName; readOnly: boolean }[] = [];
  for (const lane of LANE_NAMES) {
    for (const readOnly of [true, false]) {
      if (UNREACHABLE_COMBINATIONS.some((c) => c.lane === lane && c.readOnly === readOnly)) continue;
      combos.push({ lane, readOnly });
    }
  }
  return combos;
}

/** Free (caller-supplied) parameter names for a profile — exactly what its generated tool exposes. */
export function freeParams(profile: DispatchProfile): string[] {
  const params = ["prompt", "cwd"];
  if (profile.isolation === "required") params.push("worktree");
  if (profile.model.kind === "caller-required") params.push("model");
  params.push("effort");
  return params;
}

const ENV_PREFIX = "CLANKER_TURN_TIMEOUT_MS_";

/** Per-profile turn ceiling, with a `CLANKER_TURN_TIMEOUT_MS_<ID>` operator override. */
export function profileTurnTimeoutMs(
  profile: DispatchProfile,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ENV_PREFIX + profile.id.replace(/-/g, "_").toUpperCase()];
  if (raw === undefined) return profile.turnTimeoutMs;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : profile.turnTimeoutMs;
}

export interface ProfileDispatchInput {
  profile: string;
  prompt: string;
  cwd?: string;
  worktree?: string;
  model?: string;
  effort?: string;
}

/** What a resolved profile hands to LaneManager.dispatchStart. */
export interface ResolvedProfileDispatch {
  lane: LaneName;
  prompt: string;
  cwd?: string;
  worktree?: string;
  model?: string;
  effort?: string;
  readOnly: boolean;
  sandbox?: CodexSandboxMode;
  profile?: "worker" | "kimi-crew";
  secrets: readonly string[];
  supervision: ProfileSupervision;
  turnTimeoutMs: number;
  profileId: string;
}

/**
 * Turn a profile id + free parameters into a concrete dispatch. Every welded
 * dimension is taken from the registry; a caller-supplied value for a welded
 * dimension is a loud error rather than a silent override, because the whole
 * point of the narrow tools is that those values cannot be supplied at all.
 */
export function resolveProfileDispatch(
  input: ProfileDispatchInput,
  env: Record<string, string | undefined> = process.env,
): ResolvedProfileDispatch {
  const profile = getProfile(input.profile);

  if (profile.isolation === "forbidden" && input.worktree !== undefined) {
    throw new Error(`profile '${profile.id}' runs in place and does not take a worktree`);
  }
  if (profile.isolation === "required" && !input.worktree?.trim()) {
    throw new Error(`profile '${profile.id}' is write-capable and requires a managed worktree branch name`);
  }

  let model: string | undefined;
  switch (profile.model.kind) {
    case "welded":
      if (input.model !== undefined && input.model.trim() !== profile.model.id) {
        throw new Error(`profile '${profile.id}' welds model='${profile.model.id}'; it cannot be overridden`);
      }
      model = profile.model.id;
      break;
    case "lane-default":
      if (input.model !== undefined) {
        throw new Error(`profile '${profile.id}' uses the lane's configured default model; it takes no model argument`);
      }
      model = undefined;
      break;
    case "caller-required":
      if (!input.model?.trim()) {
        throw new Error(`profile '${profile.id}' requires an explicit model id`);
      }
      model = input.model.trim();
      break;
  }

  return {
    lane: profile.lane,
    prompt: input.prompt,
    cwd: input.cwd,
    worktree: input.worktree,
    model,
    effort: input.effort,
    readOnly: profile.readOnly,
    sandbox: profile.sandbox,
    profile: profile.ocProfile,
    secrets: profile.secrets,
    supervision: profile.supervision,
    turnTimeoutMs: profileTurnTimeoutMs(profile, env),
    profileId: profile.id,
  };
}
