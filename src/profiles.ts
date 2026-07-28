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
import { isGlmModel, TURN_TIMEOUT_MS } from "./constants.js";
import type { CodexSandboxMode, LaneName } from "./types.js";
import { LANE_NAMES } from "./types.js";

/**
 * Managed-worktree policy.
 *  - `required`  — write-capable; the manager refuses to start without one.
 *  - `optional`  — read-only, but the caller MAY ask for one. 0.2.5's read-only
 *                  schema kept `worktree` optional (26e9c9f src/tools.ts:21-29,
 *                  :129) and the manager really cut the tree (:223-227). It is a
 *                  live workflow, not a leftover: backends.ts documents the
 *                  review seat that must run `cargo test`/`go test`, which needs
 *                  a tree it can write build caches into.
 *  - `forbidden` — the lane itself rejects a worktree (today only gemini).
 */
export type ProfileIsolation = "forbidden" | "optional" | "required";

/**
 * codex-native sandbox strictness policy.
 *  - `welded`  — fixed by the profile; not a parameter.
 *  - `caller`  — caller-selectable across all three tiers, defaulting to
 *                `defaultMode`. 0.2.5's write schema omitted only `read_only`
 *                and kept the full three-way sandbox choice (26e9c9f
 *                src/tools.ts:40-49, :131-138); welding it deleted two of the
 *                three shapes.
 *  - absent    — the lane has no native sandbox tier (it would only warn).
 */
export type ProfileSandboxPolicy =
  | { readonly kind: "welded"; readonly mode: CodexSandboxMode }
  | { readonly kind: "caller"; readonly defaultMode: CodexSandboxMode };

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
 *  - `caller-optional`— the caller MAY name any model the lane serves, and the
 *                       lane's pinned default runs when they do not. Distinct
 *                       from `lane-default`, which forbids the argument
 *                       entirely: the cursor lane serves ~200 models across
 *                       four vendors on one subscription, so choosing among
 *                       them is the point of the lane, while still having one
 *                       reproducible default (`defaultId`, documentation of
 *                       what backends.ts pins — never a second source for it).
 */
export type ProfileModelPolicy =
  | { readonly kind: "welded"; readonly id: string }
  | { readonly kind: "lane-default" }
  | { readonly kind: "caller-required" }
  | { readonly kind: "caller-optional"; readonly defaultId: string };

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
  /** codex-native sandbox strictness; only set on the codex lane (other lanes only warn on it). */
  readonly sandbox?: ProfileSandboxPolicy;
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

/**
 * Cursor's read ceiling. The sidecar caps a read-only `cursor-agent` print at
 * 10m and classifies timeout-vs-crash there, so the manager ceiling sits just
 * above it — same ordering as gemini's 10m/11m pair, for the same reason: the
 * sidecar's classification must fire first instead of being preempted by a
 * generic manager kill. (The write profile keeps the standard 45m ceiling and
 * the sidecar's write-mode default is 40m, preserving the same ordering.)
 */
const CURSOR_REVIEW_TURN_TIMEOUT_MS = 900_000;

/**
 * Routing judgment, carried on both cursor rows because a seat description is
 * where a dispatcher actually reads it: Composer 2.5 is a BOUNDED
 * single-layer-scaffolding worker (composer-2.5 lane card, #1368). Provenance
 * and identity-critical cores must still be screened by a different vendor —
 * this lane is not a general-purpose implementer, and selling it as one is how
 * a cheap fast model ends up owning a load-bearing decision.
 */
const CURSOR_ROUTING_NOTE =
  "Routing: the default Composer 2.5 is a bounded single-layer-scaffolding tier (composer-2.5 lane card, " +
  "#1368) — provenance and identity-critical cores still require a cross-vendor screen, so do not route " +
  "those here. Model is a free parameter: the same Cursor subscription also serves cursor-grok-4.5-high " +
  "(alias `grok`) and gpt-5.3-codex-high (alias `codex53`).";

export const DISPATCH_PROFILES: readonly DispatchProfile[] = [
  {
    id: "codex-review",
    title: "Codex cold review (read-only, in place)",
    description:
      "Read-only Codex review. lane, read_only=true and sandbox=read-only are welded server-side: " +
      "the sandbox is welded because a Codex dispatch with read_only=true but a write-capable native " +
      "sandbox can still write the workspace, so leaving sandbox callable would be a way around the " +
      "read-only gate. Runs in place by default; an optional worktree branch runs the review inside an " +
      "isolated tree instead.",
    lane: "codex",
    model: { kind: "lane-default" },
    readOnly: true,
    sandbox: { kind: "welded", mode: "read-only" },
    isolation: "optional",
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
      "Write-capable Codex worker. read_only=false is welded and a managed worktree branch is " +
      "mandatory, so writes are boxed to the worktree. Sandbox strictness stays caller-selectable " +
      "across all three Codex tiers and defaults to workspace-write. Model omitted on purpose: Codex " +
      "runs its configured default.",
    lane: "codex",
    model: { kind: "lane-default" },
    readOnly: false,
    sandbox: { kind: "caller", defaultMode: "workspace-write" },
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
      "welded; an optional worktree branch runs the review inside an isolated tree. An explicit model " +
      "is required: omitting it lets OpenCode's own interactive config pick the provider (possibly GLM) " +
      "outside the vault-exec credential wrap.",
    lane: "opencode",
    model: { kind: "caller-required" },
    readOnly: true,
    isolation: "optional",
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
      "and worktrees (the only profile whose isolation is forbidden rather than optional — it is the " +
      "lane's own rule, not a registry preference); the model defaults to the sidecar's configured " +
      "Gemini model.",
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
    id: "gemini-research",
    title: "Gemini online research (read-only, in place)",
    description:
      "Read-only Gemini web research entry — the online-research counterpart to gemini-recon's quick " +
      "survey. Every conclusion must carry its source URL and anything unsourced is reported as " +
      "unverified. Same lane rules as gemini-recon: reconnaissance-only server-side, write mode and " +
      "worktrees rejected; the model defaults to the sidecar's configured Gemini model.",
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
    id: "cursor-review",
    title: "Cursor cold review (read-only, in place)",
    description:
      "Read-only Cursor review through the cursor-agent headless stream. read_only=true is welded and the " +
      "lane runs cursor's own read-only execution mode plus its sandbox on top of it; an optional worktree " +
      "branch runs the review inside an isolated tree instead of the working checkout. " +
      CURSOR_ROUTING_NOTE,
    lane: "cursor",
    model: { kind: "caller-optional", defaultId: "composer-2.5" },
    readOnly: true,
    isolation: "optional",
    secrets: [],
    turnTimeoutMs: CURSOR_REVIEW_TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "reviewer",
    status: "active",
  },
  {
    id: "cursor-write",
    title: "Cursor implementation (isolated worktree)",
    description:
      "Write-capable Cursor worker. read_only=false is welded and a managed worktree branch is mandatory, " +
      "so writes are boxed to the worktree rather than to cursor's own `--worktree`, which Clanker does not " +
      "use. " + CURSOR_ROUTING_NOTE,
    lane: "cursor",
    model: { kind: "caller-optional", defaultId: "composer-2.5" },
    readOnly: false,
    isolation: "required",
    secrets: [],
    turnTimeoutMs: TURN_TIMEOUT_MS,
    supervision: "none",
    roleClass: "implementer",
    status: "active",
  },
  {
    id: "grok-review",
    title: "Grok cold review (read-only, in place)",
    description:
      "Read-only Grok review with Clanker's own native containment flags. read_only=true is welded; an " +
      "optional worktree branch runs the review inside an isolated tree. Model may be omitted — the " +
      "grok lane has its own configured default. Currently dormant: the account returns HTTP 402 (out " +
      "of credit).",
    lane: "grok",
    model: { kind: "lane-default" },
    readOnly: true,
    isolation: "optional",
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
 * server-side reason.
 *
 * This list is DOCUMENTATION, not evidence. The coverage test must not subtract
 * it from the combination space and then assert that the remainder has no
 * profile — that only proves the list agrees with itself. Every combination
 * without a profile has to be proven unreachable by actually calling the
 * manager/backend and being refused (see test/profiles.test.ts #19-3).
 */
export const UNREACHABLE_COMBINATIONS: readonly { lane: LaneName; readOnly: boolean; reason: string }[] = [
  {
    lane: "gemini",
    readOnly: false,
    reason: "the gemini lane is reconnaissance-only; LaneManager and buildSpawnSpec both reject write-capable gemini dispatches",
  },
];

/**
 * The whole lane × write-mode space, with nothing subtracted. Callers decide
 * what a missing profile means — and must prove it against the real server.
 */
export function allCombinations(): { lane: LaneName; readOnly: boolean }[] {
  const combos: { lane: LaneName; readOnly: boolean }[] = [];
  for (const lane of LANE_NAMES) {
    for (const readOnly of [true, false]) combos.push({ lane, readOnly });
  }
  return combos;
}

/** True when the caller may name a model at all — the two policies that expose the parameter. */
export function modelIsCallerSupplied(profile: DispatchProfile): boolean {
  return profile.model.kind === "caller-required" || profile.model.kind === "caller-optional";
}

/** Free (caller-supplied) parameter names for a profile — exactly what its generated tool exposes. */
export function freeParams(profile: DispatchProfile): string[] {
  const params = ["prompt", "cwd"];
  if (profile.isolation !== "forbidden") params.push("worktree", "base", "doNotTouch");
  if (modelIsCallerSupplied(profile)) params.push("model");
  if (profile.sandbox?.kind === "caller") params.push("sandbox");
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

/**
 * The ONLY thing a caller supplies: a profile id plus that profile's free
 * parameters. There is deliberately no `lane`, `read_only`, `supervision` or
 * `secrets` here — those are minted from the registry row, never received.
 */
export interface ProfileDispatchInput {
  profile: string;
  prompt: string;
  cwd?: string;
  worktree?: string;
  /**
   * Optional ref (branch, tag, or SHA) to cut the worktree from. Verified
   * server-side against the target repo before any worktree is created
   * (manager.ts / worktree.ts resolveBaseCommit); a ref that does not resolve
   * rejects the dispatch outright — there is no fallback to the default base.
   */
  base?: string;
  /**
   * Paths the worker must not touch (exact file, or directory prefix).
   * Validated server-side at terminal time against the worktree's real diff
   * (committed and uncommitted); hits are reported as contract_violations.
   */
  doNotTouch?: string[];
  model?: string;
  sandbox?: CodexSandboxMode;
  effort?: string;
}

/** What a resolved profile hands to LaneManager's private dispatch path. */
export interface ResolvedProfileDispatch {
  lane: LaneName;
  prompt: string;
  cwd?: string;
  worktree?: string;
  base?: string;
  doNotTouch?: string[];
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
  // `base` only means something where a worktree can exist; on a
  // forbidden-isolation profile it is as unreachable as `worktree` itself, so
  // an in-process caller supplying one gets the same loud refusal rather than
  // a silently ignored parameter.
  if (profile.isolation === "forbidden" && input.base !== undefined) {
    throw new Error(`profile '${profile.id}' cuts no worktree and therefore takes no base`);
  }
  if (profile.isolation === "forbidden" && input.doNotTouch !== undefined) {
    throw new Error(`profile '${profile.id}' cuts no worktree and therefore takes no doNotTouch`);
  }
  if (profile.isolation === "required" && !input.worktree?.trim()) {
    throw new Error(`profile '${profile.id}' is write-capable and requires a managed worktree branch name`);
  }

  // Sandbox: welded profiles take no argument at all; caller-selectable ones
  // keep 0.2.5's full three-way choice and fall back to the declared default.
  let sandbox: CodexSandboxMode | undefined;
  if (profile.sandbox === undefined) {
    if (input.sandbox !== undefined) {
      throw new Error(`profile '${profile.id}' runs on a lane with no native sandbox tier; it takes no sandbox argument`);
    }
  } else if (profile.sandbox.kind === "welded") {
    if (input.sandbox !== undefined && input.sandbox !== profile.sandbox.mode) {
      throw new Error(`profile '${profile.id}' welds sandbox='${profile.sandbox.mode}'; it cannot be overridden`);
    }
    sandbox = profile.sandbox.mode;
  } else {
    sandbox = input.sandbox ?? profile.sandbox.defaultMode;
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
    case "caller-optional":
      // Undefined, deliberately, when the caller named nothing: the default
      // belongs to backends.ts (and is mirrored into resolved_model by run.ts).
      // Substituting `defaultId` here would make the registry a SECOND source
      // for the pinned default, and the two would drift the first time one
      // moved — the failure mode #13 documents for the gemini print-timeout.
      model = input.model?.trim() || undefined;
      break;
    case "caller-required":
      if (!input.model?.trim()) {
        throw new Error(`profile '${profile.id}' requires an explicit model id`);
      }
      model = input.model.trim();
      // 0.2.5's writer relay rejected the GLM alias and its full id before the
      // manager ever saw them (tools.ts clanker_dispatch_write_start), so the
      // caller got a routing answer rather than a policy error. The manager's
      // own gate stays authoritative underneath.
      if (!profile.readOnly && profile.supervision !== "sonnet" && isGlmModel(model)) {
        throw new Error(
          `profile '${profile.id}' cannot run a GLM write; GLM writes are supervised and belong to profile 'oc-glm-write'`,
        );
      }
      break;
  }

  return {
    lane: profile.lane,
    prompt: input.prompt,
    cwd: input.cwd,
    worktree: input.worktree,
    base: input.base,
    doNotTouch: input.doNotTouch,
    model,
    effort: input.effort,
    readOnly: profile.readOnly,
    sandbox,
    profile: profile.ocProfile,
    secrets: profile.secrets,
    supervision: profile.supervision,
    turnTimeoutMs: profileTurnTimeoutMs(profile, env),
    profileId: profile.id,
  };
}
