/**
 * LaneManager — owns lane sessions across their whole lifecycle: dispatch
 * validation, plan/status projection, long-poll (clanker_wait), cancel
 * (including orphan adoption), worktree cleanup, and the idle-TTL reaper.
 *
 * What happens INSIDE a turn — spawn + handshake, the prompt loop, the
 * capacity retry, the correction turn, the terminal transition — lives in
 * turn-driver.ts. The manager holds one TurnDriver and hands it exactly the
 * capabilities named in `TurnHost` (see `turnHost()` below): the session
 * tables it does not own stay private here, so `connections`, `closing`,
 * `runs` and `warningsById` keep a single lifecycle owner.
 *
 * The spawn recipe is resolved through an injectable `resolveSpec` so tests can
 * point every lane at a scripted fake ACP agent while production uses the real
 * lane registry.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LaneConnection } from "./acp-client.js";
import {
  BASE_REPO,
  CANCEL_GRACE_MS,
  CAPACITY_RETRY_BACKOFF_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  HANDSHAKE_TIMEOUT_MS,
  isGlmModel,
  LANES_WITH_PINNED_WRITE_MODEL,
  modelSwapWarning,
  RUNS_ROOT,
  TURN_TIMEOUT_MS,
  WRITE_DISCIPLINE_PREFIX,
} from "./constants.js";
import { buildSpawnSpec } from "./backends.js";
import { archiveAdoptedRun, killAdoptedWorker, probeOwner } from "./adopt.js";
import {
  foreignControlRefusal,
  foreignRunStatus,
  isValidRunId,
  readForeignRun,
  scanForeignRuns,
  type ForeignRun,
} from "./foreign.js";
import { parseIssueRef, type GhRunner, type IssueRef } from "./issue-comment.js";
import { resolveProfileDispatch, type ProfileDispatchInput } from "./profiles.js";
import { LaneRun } from "./run.js";
import type {
  LaneName,
  LaneRequestOptions,
  LaneStatusView,
  RunFinal,
  RunStatus,
  SpawnSpec,
} from "./types.js";
import { LANE_NAMES } from "./types.js";
import { hostLaneBlockedReason, type ClankerHost } from "./host.js";
import { TurnDriver, type TurnHost } from "./turn-driver.js";
import {
  assertWorktreeOutsideRepo,
  changedFiles,
  changedFilesSince,
  createWorktree,
  deriveWorktreePath,
  headSha,
  isGitWorkTree,
  matchDoNotTouch,
  realpathBestEffort,
  removeIfClean,
  resolveBaseCommit,
  resolveTargetRepo,
} from "./worktree.js";
import { annotatedError, clampWait, dedupe, envInt, errMessage } from "./util.js";

/**
 * Re-exported so `assertWorktreeOutsideRepo`'s existing direct unit test
 * (test/manager.test.ts) keeps working unchanged after the #37 A4 move into
 * worktree.ts — the isolation guard's real home, next to the rest of the
 * worktree lifecycle logic it enforces.
 */
export { assertWorktreeOutsideRepo } from "./worktree.js";

/**
 * Caller-supplied dispatch parameters. `secrets` is deliberately omitted from
 * LaneRequestOptions here: it is minted from a registry row, not received, so
 * declaring it would be a type-level invitation to forge it.
 */
export interface DispatchParams extends Omit<LaneRequestOptions, "secrets"> {
  lane: LaneName;
  prompt: string;
  cwd?: string;
  worktree?: string;
  /**
   * Optional ref (branch, tag, or SHA) to cut the worktree from. Verified
   * server-side against the target repo BEFORE any worktree is created; a ref
   * that does not resolve rejects the dispatch — no fallback to the default
   * base. Meaningless without `worktree` and rejected then, because silently
   * ignoring a caller's cut point is worse than refusing it.
   */
  base?: string;
  /**
   * Paths the worker must not touch, validated server-side at terminal time
   * against the worktree's real diff (committed and uncommitted). Hits are
   * reported as `contract_violations`; the run's status is never flipped.
   * Requires a worktree (the validation diffs it against its cut base), so it
   * is refused without one rather than silently never checked.
   */
  doNotTouch?: string[];
  /**
   * Ticket this dispatch is being run for (#27) — `"41"` or `"owner/repo#41"`.
   * Validated in `validateDispatchParams` (pure, before any disk side effect)
   * so an unusable reference is refused while the caller is still there to
   * hear it, rather than discovered at terminal time when the run has already
   * been paid for and its verdict has nowhere to go.
   */
  issue?: string;
}

/**
 * Capabilities that a caller must NOT be able to claim, minted only from a
 * registry row and carried to the private dispatch path as a separate
 * argument — never as a field of the caller-supplied params object.
 *
 * This is 0.2.5's shape restored (26e9c9f src/manager.ts:162-179): there,
 * `supervisedGlm` was a positional parameter of the private
 * dispatchStartInternal and the public `dispatchStart()` always passed
 * `false`, so no caller could hand in supervision. Making it a field of
 * DispatchParams instead — as the first #19 revision did — let any in-process
 * caller self-report `supervision: "sonnet"` and walk straight through the GLM
 * gate (reproduced by cold review on 4a8a718).
 */
interface MintedCapabilities {
  supervision: "none" | "sonnet";
  /** Per-profile hard turn ceiling; undefined falls back to the global TURN_TIMEOUT_MS. */
  turnTimeoutMs?: number;
  /** Vault-sourced env vars the profile declares. */
  secrets?: readonly string[];
  /** Profile id, for diagnostics. */
  profileId?: string;
}

/** Nothing a caller supplies can mint a capability. */
const NO_CAPABILITIES: MintedCapabilities = { supervision: "none" };

/** Result of the pure pre-flight validation below. */
interface ValidatedDispatch {
  /** Normalized params (kimi-crew's lane/model/readOnly override already applied). */
  params: DispatchParams;
  profile: "worker" | "kimi-crew";
  readOnly: boolean;
  requiresIsolation: boolean;
  /** Parsed `issue` (#27), present only when the caller named a ticket. */
  issueRef?: IssueRef;
}

/**
 * Pure pre-flight validation for `dispatchStartInternal` (#37 A5) — no I/O, no
 * runDir, no worktree, nothing that touches disk. Every one of these checks
 * MUST run and pass before any disk side effect (mkdirSync(runDir),
 * createWorktree): a caller whose request violates a fail-closed rule here
 * must never leave a stray run directory or worktree behind it. See the C1
 * reordering in `dispatchStartInternal` for the lane-specific gates
 * (resolveSpec/backends.ts) that only run AFTER this — those need the run
 * directory to already exist (e.g. opencode's per-run config file) and are
 * deliberately NOT folded in here.
 */
function validateDispatchParams(
  params: DispatchParams,
  minted: MintedCapabilities,
  host: ClankerHost,
): ValidatedDispatch {
  if (!LANE_NAMES.includes(params.lane)) {
    throw new Error(`unknown lane '${params.lane}'; expected one of ${LANE_NAMES.join(", ")}`);
  }
  // #27: parsed here, in the pure pre-flight, for the same reason every other
  // check is here — a refusal must cost the caller nothing but the refusal. It
  // is also the ONLY place the format is judged, so both dispatch entrances
  // (dispatchStart and dispatchProfile) are held to one rule.
  const issueRef = params.issue?.trim() ? parseIssueRef(params.issue) : undefined;
  const profile = params.profile ?? "worker";
  if (profile !== "worker" && profile !== "kimi-crew") throw new Error(`unsupported profile '${profile}'`);
  if (params.lane === "gemini" && profile !== "worker") throw new Error("Clanker: Gemini rejects profile");
  if (profile === "kimi-crew") {
    params = { ...params, lane: "opencode", model: "kimi", readOnly: false, profile };
  }
  const blockedReason = hostLaneBlockedReason(host, params.lane);
  if (blockedReason) throw new Error(blockedReason);
  if (params.lane === "codex" && params.model?.trim().toLowerCase() === "codex") {
    throw new Error("model='codex' is a lane name, not a Codex model id; omit model to use the configured default");
  }
  // Reject an explicit write-capable gemini request BEFORE normalizing, or
  // the normalization silently downgrades it to read-only and the rejection
  // below becomes dead code — a refusal that never fires reads to the caller
  // as "accepted", which is exactly the failure mode a loud gate exists to
  // prevent. (Found by cold review on 4a8a718.)
  if (params.lane === "gemini" && params.readOnly === false) {
    throw new Error("Clanker: Gemini is reconnaissance-only and cannot run write-capable dispatches");
  }
  const readOnly = params.lane === "gemini" ? true : (params.readOnly ?? false);
  if (params.lane === "gemini" && params.worktree) throw new Error("Clanker: Gemini rejects worktree");
  // A write must never let the LANE'S OWN interactive configuration pick the
  // model. Where Clanker pins the default itself the requirement is satisfied
  // without the caller naming one — see LANES_WITH_PINNED_WRITE_MODEL, which
  // replaced a growing `lane !== "codex"` blacklist.
  if (!readOnly && !LANES_WITH_PINNED_WRITE_MODEL.has(params.lane) && !params.model?.trim()) {
    throw new Error(`an explicit model is required for write lane '${params.lane}'`);
  }
  // GLM writes are supervised-only. 0.2.5 expressed this as "GLM writes
  // require clanker_dispatch_glm_write_start and Sonnet supervision" and
  // unlocked it with an internal `supervisedGlm` flag no caller could set;
  // `supervision === "sonnet"` (welded by the oc-glm-write registry row, not
  // reachable from any tool schema) is that same key. The kimi-crew escape
  // stays because 0.3.x callers were told to use it, but it is NOT the GLM
  // path: kimi-crew welds model=kimi and runs a different model entirely.
  if (!readOnly && isGlmModel(params.model) && profile !== "kimi-crew" && minted.supervision !== "sonnet") {
    throw new Error(
      "direct GLM write is prohibited; use profile='kimi-crew' for the OpenCode crew, " +
        "or the supervised 'oc-glm-write' dispatch profile for a GLM write under Sonnet supervision",
    );
  }
  const writeCapableSandbox =
    params.lane === "codex" &&
    params.sandbox !== undefined &&
    params.sandbox !== "read-only";
  const requiresIsolation = !readOnly || writeCapableSandbox;

  // CP2: every write-capable dispatch is forced into an isolated worktree,
  // including Codex review seats whose native sandbox permits workspace writes.
  if (requiresIsolation && !params.worktree) {
    throw new Error(
      "write-capable dispatch must run in an isolated worktree: pass `worktree` (a branch name). Strict reads may run in-place.",
    );
  }
  return { params, profile, readOnly, requiresIsolation, issueRef };
}

/**
 * The dispatch-guard telemetry stub (#35 / C1) — written the instant the run
 * directory exists, before any lane-specific fail-closed gate or worktree
 * creation gets a chance to reject the dispatch. `run.persistTelemetry()`
 * (run.ts) fully overwrites this file (tmp+rename, no merge) once a LaneRun
 * exists and starts its first turn, so key-name compatibility with
 * RunTelemetry only has to hold for the window between this write and that
 * one — which is exactly the window a dispatch that dies before a LaneRun
 * ever exists never leaves.
 */
interface TelemetryStub {
  host: ClankerHost;
  lane: LaneName;
  /**
   * The DISPATCH PROFILE id (`oc-write`, `codex-review`) — the registry row
   * that minted this run, and the same value `RunTelemetry.profile_id` and the
   * #27 issue comment's byline carry. Absent means exactly what it means
   * everywhere else: no registry profile minted this dispatch, so the run's
   * identity is its lane (plus `oc_profile` below).
   *
   * It used to hold `params.profile` — the OpenCode AGENT profile, whose only
   * values are `worker`/`kimi-crew` — so one field name carried two namespaces
   * depending on which write you read, and a `codex-review` run's stub claimed
   * to be a `worker`. The registry id is available here (the profile entrance
   * resolves it before dispatchStartInternal is entered and hands it over as a
   * minted capability), so the stub writes the real thing rather than deferring:
   * a dispatch that dies in the startup window leaves this file and nothing
   * else, and "which seat shape was this" is the first question asked of it.
   */
  profile_id?: string;
  /**
   * The OpenCode AGENT profile this dispatch would have run under — the
   * permission/agent shape named in `profiles.ts` as `ocProfile` and handed to
   * the backend as `LaneRequestOptions.profile`. A request parameter, not an
   * identity, so it is stub-only (like `cwd`): once a LaneRun exists its
   * durable home is the ledger row's `agent_type` (ledger.ts), and duplicating
   * it into RunTelemetry would make two sources for one fact. It is written
   * here because a dispatch rejected before the LaneRun exists never reaches
   * that ledger row — and for a `profile: "kimi-crew"` dispatchStart, which
   * mints no registry id, this is the only thing beyond the lane that says
   * what was asked for.
   */
  oc_profile: string;
  cwd: string;
  /**
   * The server process that minted this dispatch (#32). Written here — in the
   * stub, before a LaneRun or a worker exists — because "whose session is this"
   * is a question a dispatch that died at a fail-closed gate still has to
   * answer; RunTelemetry.server_pid carries the same value afterwards.
   */
  server_pid: number;
  created_at: string;
  requested_model?: string;
  /** Present only once the dispatch has been rejected before spawning. */
  terminal_at?: string;
  terminal_reason?: string;
  error?: string;
}

/** Write (or overwrite) `<runDir>/telemetry.json` atomically via tmp+rename — same pattern as LaneRun.persistTelemetry(). */
function writeTelemetryStub(runDir: string, stub: TelemetryStub): void {
  const target = path.join(runDir, "telemetry.json");
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(stub, null, 2));
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    console.error(`[clanker] telemetry stub write failed for run dir '${runDir}': ${errMessage(error)}`);
  }
}

/** How often a degraded (foreign, disk-polled) wait re-reads the record. */
const FOREIGN_POLL_MS = 250;

export interface WaitResult {
  id: string;
  /**
   * Widened past `LaneName` for the degraded foreign path only (#32): a run
   * reconstructed from another process's telemetry reports whatever lane that
   * file names, or `"unknown"` when it names none — a foreign record is not
   * something this build can typecheck into an enum.
   */
  lane: LaneName | string;
  status: RunStatus;
  digest: string;
  plan_summary: string;
  last_event_age_ms: number;
  suspected_stall: boolean;
  /** Absolute run directory — handed to the caller so a seat never has to construct or guess a path. */
  run_dir: string;
  warnings?: string[];
  // present when status is terminal
  /**
   * Absolute path of the terminal-judgment artifact (`result.md`), present ONLY
   * when that file exists and is non-empty. Its absence on a terminal run is
   * the machine-checkable signal a relay seat needs in order to say "I did not
   * get a verdict" instead of composing one (see plugin/agents/*.md,
   * `CLANKER-NO-RESULT:`); a seat holding only start+wait tools cannot stat a
   * file itself, so the server answers that question for it.
   */
  result_path?: string;
  /** Size of `result.md` in bytes; omitted whenever `result_path` is. */
  result_bytes?: number;
  final_message?: string;
  touched_files?: string[];
  /**
   * doNotTouch breaches found at terminal time (pattern + concrete matched
   * paths). Present only when the dispatch declared doNotTouch AND at least
   * one pattern was hit; a clean run under a declared contract gets no field,
   * and a dispatch without doNotTouch behaves exactly as before.
   */
  contract_violations?: import("./types.js").ContractViolation[];
  plan_final?: RunFinal["plan_final"];
  worktree_retained?: string;
  error?: string;
  /** Present alongside `error` when classifyTurnFailure tagged it (e.g. CLANKER-INFRA-FAILURE). */
  failure_class?: string;
  telemetry?: import("./types.js").RunTelemetry;
  /**
   * Present ONLY when this result was reconstructed from files rather than
   * observed (#32): the run belongs to a server process that is gone, so its
   * event stream died with it. A caller must never read the absence of digest
   * / final_message here as "the run was silent" — `degraded_note` spells out
   * which fields cannot exist on this path.
   */
  degraded?: "disk-poll";
  degraded_note?: string;
  /** Degraded path only: the model that actually ran, straight off telemetry.json. */
  observed_model?: string | null;
  /**
   * Degraded path only: the #27 comment account, straight off telemetry.json.
   *
   * Lifted to the top level exactly as `observed_model` is, and for the same
   * reason — a foreign record cannot be typechecked into a whole `RunTelemetry`,
   * so the degraded reader gets the individual facts that survive on disk. A
   * local wait carries these two inside `telemetry` instead.
   */
  issue_comment_error?: string;
  issue_comment_pending?: boolean;
}

/**
 * `clanker_cancel`'s payload. The first four fields are the ordinary local
 * cancel; everything under `adopted` describes a cancel this process performed
 * on ANOTHER server's orphaned run (#32) and exists so the caller can tell what
 * actually happened to the worker — a refusal, a kill, or a record closed
 * without any signal because the pid could no longer be proven to be the
 * worker. "Cancelled" with `killed: false` is a real and honest outcome.
 */
export interface CancelResult {
  id: string;
  status: RunStatus;
  worktree_retained?: string;
  run_dir?: string;
  /** Present (and always true) only when this process took over a dead server's run. */
  adopted?: true;
  /** The server that started the run, now proven gone. */
  owner_pid?: number | null;
  /** The worker this process considered signalling; null when the run never spawned one. */
  worker_pid?: number | null;
  /** Did this cancel actually deliver a signal to the worker's process group? */
  killed?: boolean;
  /** Did the pid still verify as this run's worker (start-time match)? No verification, no signal. */
  identity_verified?: boolean;
  /**
   * Did this adoption close the record on disk? `false` means it deliberately
   * wrote nothing — the run was already terminal, so the owner's own account of
   * it stands (adopt.ts archiveAdoptedRun) — and `archive_reason` says which.
   */
  archived?: boolean;
  /** Why nothing was written to the foreign run directory, when `archived` is false. */
  archive_reason?: string;
  /** The verdict file, if the run left one or archival wrote a stub. */
  result_path?: string;
  /** Human-readable account of the four adoption steps, including anything that failed. */
  note?: string;
}

export interface LaneListEntry {
  id: string;
  lane: LaneName | string;
  state: "working" | "idle" | "stalled" | "closed";
  idle_ms: number;
  turns_count: number;
  plan_summary: string;
  suspected_stall: boolean;
  /**
   * Which process owns this run (#32). `foreign` entries are reconstructed
   * from `telemetry.json` on disk because another session's server holds the
   * live object — they are visible, never controllable, and they are on the
   * list precisely so an orphan scan stops mistaking "another process owns it"
   * for "it never started".
   */
  owner: "this-process" | "foreign";
  /** foreign only: where to read the record this entry was reconstructed from. */
  run_dir?: string;
  /** foreign only: the verdict file, when the run already wrote one. */
  result_path?: string;
  /** foreign only: the model that actually ran, straight off the durable record. */
  observed_model?: string | null;
}

export type SpecResolver = (lane: LaneName, opts: LaneRequestOptions, runDir: string) => SpawnSpec;

export interface LaneManagerOptions {
  host?: ClankerHost;
  resolveSpec?: SpecResolver;
  stallThresholdMs?: number;
  sessionTtlMs?: number;
  /** Hard per-turn ceiling before the turn is forced to terminal error. */
  turnTimeoutMs?: number;
  /** Handshake timeout passed to LaneConnection.connect. */
  handshakeTimeoutMs?: number;
  baseRepo?: string;
  /** Root under which run directories live; also the root the foreign-run scan reads (#32). */
  runsRoot?: string;
  /** Disable the background reaper (tests drive reaping manually). */
  disableReaper?: boolean;
  /** Backoff before the single automatic retry of a capacity-transient first-turn failure. */
  capacityRetryBackoffMs?: number;
  cancelGraceMs?: number;
  /** SIGTERM grace before SIGKILL escalation (primarily a test override). */
  processTerminateGraceMs?: number;
  /**
   * Executor for the #27 issue comment's `gh` call, injected the same way
   * `resolveSpec` injects the lane spawn: the suite proves what argv the server
   * would run — and that it runs none at all without an `issue` — without a
   * `gh` on PATH and without writing on a real ticket. Undefined in production,
   * where `execFileGhRunner` runs.
   */
  ghRunner?: GhRunner;
}

const DEFAULT_SESSION_TTL_MS = envInt("CLANKER_SESSION_TTL_MS", 600_000);

export class LaneManager {
  readonly host: ClankerHost;
  private readonly runs = new Map<string, LaneRun>();
  private readonly connections = new Map<string, LaneConnection>();
  private readonly resolveSpec: SpecResolver;
  private readonly stallThresholdMs: number;
  private readonly sessionTtlMs: number;
  private readonly turnTimeoutMs: number;
  /**
   * Explicit constructor override. Set only by an operator/test; when set it
   * wins over a profile's declared ceiling, so an 80ms test ceiling is not
   * silently replaced by a profile's 45 minutes.
   */
  private readonly turnTimeoutOverrideMs?: number;
  private readonly handshakeTimeoutMs: number;
  private readonly baseRepo: string;
  private readonly runsRoot: string;
  private readonly capacityRetryBackoffMs: number;
  private readonly cancelGraceMs: number;
  private readonly processTerminateGraceMs?: number;
  /** Injected `gh` executor for #27 issue comments; undefined runs the real one. */
  private readonly ghRunner?: GhRunner;
  private readonly warningsById = new Map<string, string[]>();
  private readonly closing = new Map<string, Promise<void>>();
  /** The turn engine (turn-driver.ts); every per-turn method below forwards to it. */
  private readonly turnDriver: TurnDriver;
  private shuttingDown = false;
  /** CP6: at most one active clanker_wait per id (single-consumer contract). */
  private readonly activeWaits = new Set<string>();
  private reaperTimer: NodeJS.Timeout | null = null;
  private counter = 0;

  constructor(opts: LaneManagerOptions = {}) {
    this.host = opts.host ?? "standalone";
    this.resolveSpec = opts.resolveSpec ?? buildSpawnSpec;
    this.stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.turnTimeoutOverrideMs = opts.turnTimeoutMs;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.baseRepo = opts.baseRepo ?? BASE_REPO;
    this.runsRoot = opts.runsRoot ?? RUNS_ROOT;
    this.capacityRetryBackoffMs = opts.capacityRetryBackoffMs ?? CAPACITY_RETRY_BACKOFF_MS;
    this.cancelGraceMs = opts.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.processTerminateGraceMs = opts.processTerminateGraceMs;
    this.ghRunner = opts.ghRunner;
    this.turnDriver = new TurnDriver(this.turnHost());
    if (!opts.disableReaper) {
      const period = Math.max(5_000, Math.floor(this.sessionTtlMs / 10));
      this.reaperTimer = setInterval(() => void this.reap(), period);
      this.reaperTimer.unref?.();
    }
  }

  /**
   * The manager's side of the TurnDriver split: the exact set of manager
   * capabilities the turn engine is allowed to reach, and nothing else.
   *
   * Every function member delegates through an arrow so the receiver stays the
   * MANAGER — `resolveSpec` in particular is caller-injected and must keep
   * being invoked exactly as `this.resolveSpec(...)` was. The scalars are read
   * once here because each is `readonly` and assigned in the constructor above;
   * `shuttingDown` is the one mutable flag, so it is a getter and stays live.
   */
  private turnHost(): TurnHost {
    const manager = this;
    return {
      turnTimeoutMs: this.turnTimeoutMs,
      turnTimeoutOverrideMs: this.turnTimeoutOverrideMs,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      processTerminateGraceMs: this.processTerminateGraceMs,
      capacityRetryBackoffMs: this.capacityRetryBackoffMs,
      sessionTtlMs: this.sessionTtlMs,
      get shuttingDown(): boolean {
        return manager.shuttingDown;
      },
      resolveSpec: (lane, opts, runDir) => this.resolveSpec(lane, opts, runDir),
      getRun: (id) => this.runs.get(id),
      throwUnknownRun: (id): never => this.throwUnknownRun(id),
      isClosing: (id) => this.closing.has(id),
      getConnection: (id) => this.connections.get(id),
      setConnection: (id, conn) => {
        this.connections.set(id, conn);
      },
      dropConnection: (id, expected) => {
        if (this.connections.get(id) === expected) this.connections.delete(id);
      },
      close: (id) => this.close(id),
      computeTouched: (run) => this.computeTouched(run),
      computeContractViolations: (run) => this.computeContractViolations(run),
      getWarnings: (id) => this.warningsById.get(id),
      setWarnings: (id, warnings) => {
        this.warningsById.set(id, warnings);
      },
    };
  }

  // ---- dispatch -----------------------------------------------------------

  /**
   * Start a lane turn without blocking. Setup errors (unknown lane, worktree
   * creation) throw here; runtime errors surface through clanker_wait.
   *
   * This entrance mints NO capability: it always enters with
   * `supervision: "none"`, exactly as 0.2.5's public dispatchStart always
   * passed `supervisedGlm=false`. Extra properties on `params` are inert —
   * the private path reads capabilities only from its second argument, so
   * `dispatchStart({... , supervision: "sonnet"} as any)` cannot unlock
   * anything.
   */
  async dispatchStart(params: DispatchParams): Promise<{ id: string; warnings: string[] }> {
    return this.dispatchStartInternal(params, NO_CAPABILITIES);
  }

  /**
   * The dedicated entrance for a registry profile — the only way a supervised
   * capability is ever minted. The caller names a profile and supplies that
   * profile's free parameters; lane, write mode, sandbox, secrets and
   * supervision come from the registry row, which the caller cannot reach.
   */
  async dispatchProfile(input: ProfileDispatchInput): Promise<{ id: string; warnings: string[] }> {
    const resolved = resolveProfileDispatch(input);
    return this.dispatchStartInternal(
      {
        lane: resolved.lane,
        prompt: resolved.prompt,
        cwd: resolved.cwd,
        worktree: resolved.worktree,
        base: resolved.base,
        doNotTouch: resolved.doNotTouch,
        model: resolved.model,
        effort: resolved.effort,
        issue: resolved.issue,
        readOnly: resolved.readOnly,
        sandbox: resolved.sandbox,
        profile: resolved.profile,
      },
      {
        supervision: resolved.supervision,
        turnTimeoutMs: resolved.turnTimeoutMs,
        secrets: resolved.secrets,
        profileId: resolved.profileId,
      },
    );
  }

  private async dispatchStartInternal(
    params: DispatchParams,
    minted: MintedCapabilities,
  ): Promise<{ id: string; warnings: string[] }> {
    if (this.shuttingDown) throw new Error("Clanker manager is shutting down; refusing a new dispatch");
    const validated = validateDispatchParams(params, minted, this.host);
    params = validated.params;
    const { profile, readOnly, issueRef } = validated;
    // Server-owned workspace-discipline prefix on every write-class dispatch
    // (a08f7a1): the words the worker is held to are the words it was handed,
    // so the ledger's initialPrompt and the first turn both use lanePrompt.
    const lanePrompt = readOnly ? params.prompt : `${WRITE_DISCIPLINE_PREFIX}\n\n${params.prompt}`;

    // Server-side `base` verification names a caller-supplied cut point; a
    // `base`/`doNotTouch` without a worktree names something nothing will ever
    // consume, so both are refused rather than silently ignored. These two
    // checks are pure (no I/O) and stay ahead of the run directory / telemetry
    // stub below — same rule as `validateDispatchParams` above.
    if (params.base !== undefined && !params.worktree) {
      throw new Error(
        `dispatch base '${params.base}' was supplied without a worktree; a base only names the commit a ` +
          `worktree is cut from, so pass 'worktree' as well or omit 'base'`,
      );
    }
    if (params.doNotTouch !== undefined && !params.worktree) {
      throw new Error(
        `doNotTouch was supplied without a worktree; the validation diffs a worktree against the commit it ` +
          `was cut from, so pass 'worktree' as well or omit 'doNotTouch'`,
      );
    }

    const id = `${params.lane}-${(++this.counter).toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    // Resolved at the ONE place a run directory is minted, so every surface
    // that later reports it agrees. Round-3 review (codex-ee7b9): the symlink
    // fix made the FOREIGN read emit a realpath while the owning process kept
    // emitting the lexical join, so one physical directory had two names
    // depending on who was asked — and `run_dir` is documented as the absolute
    // path a seat hands over precisely so nobody has to construct or reconcile
    // one. A relative CLANKER_RUNS_ROOT made it worse: the local form was not
    // even absolute. Fixing it here rather than at each reporting site is the
    // difference between a contract and four coincidences.
    fs.mkdirSync(path.resolve(this.runsRoot, id), { recursive: true });
    const runDir = realpathBestEffort(path.resolve(this.runsRoot, id));

    // #35: write a telemetry stub the instant the run directory exists — BEFORE
    // resolveSpec's own fail-closed gates (missing model, gemini rules, sandbox
    // validation) or createWorktree get a chance to reject the dispatch. Without
    // this, a dispatch that died in that window left either an empty run
    // directory (no signal a scan could use at all) or, prior to the reordering
    // below, a real orphaned worktree with nothing tracking it (issue #35 /
    // C1 — see the try/catch below for the corresponding terminal write).
    const stub: TelemetryStub = {
      host: this.host,
      lane: params.lane,
      // Two fields because there are two facts (see TelemetryStub): the
      // registry row that minted the dispatch, and the OpenCode agent profile
      // it asked the backend for. Spread rather than `profile_id: minted.profileId`
      // so "no registry profile" is an absent key on disk and never a written
      // `undefined`/placeholder — absence is the same signal LaneRun.profileId
      // and the issue comment already use.
      ...(minted.profileId !== undefined ? { profile_id: minted.profileId } : {}),
      oc_profile: profile,
      cwd: params.cwd ?? this.baseRepo,
      server_pid: process.pid,
      created_at: new Date().toISOString(),
      requested_model: params.model,
    };
    writeTelemetryStub(runDir, stub);

    const requestOpts: LaneRequestOptions = {
      model: params.model,
      effort: params.effort,
      readOnly,
      sandbox: params.sandbox,
      profile,
      secrets: minted.secrets,
      // Only the profile entrance mints a profileId; direct dispatchStart
      // callers get no role routing and the sidecar falls back to recon copy.
      geminiRole: params.lane === "gemini" ? minted.profileId : undefined,
    };

    let cwd = params.cwd ?? this.baseRepo;
    // #12: the worktree must be cut from the repo the dispatch *targets*
    // (resolved from params.cwd via `git rev-parse --show-toplevel`), NOT the
    // host checkout the MCP server was launched from. Cutting from the host is
    // what silently polluted an unrelated primary checkout: the worker was told
    // its cwd was a worktree of the wrong repo, couldn't find the target repo's
    // files there, and fell back to absolute paths into the target's primary
    // checkout. Whenever a worktree dispatch carries a cwd — read-only or write;
    // the wrong-repo cut is identical either way — resolve its repo and fail
    // LOUDLY if that cwd is not inside a git work tree (resolveTargetRepo). Only
    // when no cwd is given do we fall back to the host baseRepo (the legitimate
    // "cut from my own repo" default). This condition MUST stay aligned with the
    // `if (params.worktree)` creation guard below, or a path that creates a
    // worktree without resolving targetRepo silently cuts from the host again.
    //
    // Resolved INSIDE the try block below (with resolveBaseCommit), not before
    // the telemetry stub write: both are I/O-bound rejection points, and a
    // rejection here must leave the same readable terminal stub every other
    // fail-closed gate in this try block leaves — not a silent gap before any
    // run directory exists (the bug this reordering fixes).
    let targetRepo = path.resolve(this.baseRepo);
    let baseSha: string | undefined;
    let worktreePath: string | undefined;
    let worktreeBaseSha: string | undefined;
    /**
     * Dispatch-time advisories the SPEC knows nothing about (the dispatcher's
     * checkout state, #33 A3). Kept separate from `spec.warnings` so a resolver
     * that hands back a shared/cached spec object cannot accumulate one run's
     * advisories onto the next run's dispatch.
     */
    const dispatchWarnings: string[] = [];
    let spec: SpawnSpec;
    try {
      if (params.worktree && params.cwd) {
        targetRepo = await resolveTargetRepo(params.cwd);
      }
      // Server-side `base` verification: a caller-named cut point is resolved
      // against the target repo BEFORE any worktree is created. A base that
      // does not resolve to a commit rejects the whole dispatch — quoting the
      // caller's original string verbatim — with NO fallback to the repo's
      // default base.
      if (params.base !== undefined) {
        baseSha = await resolveBaseCommit(targetRepo, params.base);
      }
      // Fail-closed lane-specific gates (opencode requires an explicit model,
      // gemini's own rules, sandbox validation) live inside resolveSpec — run
      // it BEFORE createWorktree so a rejection here never leaves a real
      // worktree behind with nothing tracking it (#35 / C1).
      spec = this.resolveSpec(params.lane, requestOpts, runDir);
      if (params.worktree) {
        // CP2 (target-aware isolation invariant): the isolated worktree must never
        // BE — or contain, or sit inside — the target repo's primary checkout.
        // deriveWorktreePath keeps it under WORKTREES_ROOT; this guard rejects a
        // misconfiguration (WORKTREES_ROOT set inside the repo) that would put
        // writes back on the very checkout the isolation exists to protect.
        //
        // `id` is passed to BOTH calls on purpose: the guard must inspect the
        // very path createWorktree will create (#3 keys that path on the run
        // id), or the isolation check and the creation drift apart.
        assertWorktreeOutsideRepo(deriveWorktreePath(params.worktree, id), targetRepo);
        worktreePath = await createWorktree(params.worktree, id, targetRepo, baseSha);
        cwd = worktreePath;
        // The diff base for doNotTouch terminal validation: the exact commit the
        // tree was cut from, captured NOW (before the worker's first commit can
        // move HEAD) whether or not the caller named a base. Best-effort (330c9b1):
        // when the tree cannot be read, the terminal validation later simply finds
        // nothing to diff — capture must never crash the dispatch itself.
        if (baseSha !== undefined) {
          worktreeBaseSha = baseSha;
        } else {
          try {
            worktreeBaseSha = await headSha(worktreePath);
          } catch {
            worktreeBaseSha = undefined;
          }
        }
        // #33 A3: a worktree is cut from a COMMIT, so anything the dispatcher
        // has not committed in its own checkout is simply not in the worker's
        // tree. Now that the default cut point follows the dispatch cwd (A1),
        // that gap sits exactly where a dispatcher's current work is — say it
        // out loud at dispatch time instead of letting the worker discover it
        // as a file that mysteriously does not exist. TELLING, NOT GATING: a
        // dirty checkout is a normal state to dispatch from, and refusing here
        // would only push dispatchers into off-books worktrees (the very
        // behaviour #33 recorded a worker resorting to).
        try {
          const dirty = await changedFiles(targetRepo);
          if (dirty.length > 0) {
            const cutFrom = params.base !== undefined ? `base '${params.base}'` : "HEAD";
            dispatchWarnings.push(
              `worktree cut from ${cutFrom} ${(worktreeBaseSha ?? "(unknown)").slice(0, 7)}; ` +
                `${dirty.length} uncommitted change(s) in ${targetRepo} are NOT included`,
            );
          }
        } catch (err) {
          // A check that could not run must not read as "nothing to report".
          dispatchWarnings.push(
            `could not inspect ${targetRepo} for uncommitted changes (${errMessage(err)}); ` +
              `any uncommitted work there is NOT in the worktree`,
          );
        }
      }
    } catch (e) {
      // Leave a readable failure record instead of a silent gap: foreign.ts's
      // scan treats a stub with `terminal_at` as already-terminal, so this
      // rejected dispatch never shows up on the orphan board either.
      writeTelemetryStub(runDir, {
        ...stub,
        terminal_at: new Date().toISOString(),
        terminal_reason: "rejected",
        error: errMessage(e),
      });
      throw e;
    }
    const warnings = [...spec.warnings, ...dispatchWarnings];
    this.warningsById.set(id, warnings);

    const run = new LaneRun({
      id,
      lane: params.lane,
      host: this.host,
      cwd,
      runDir,
      readOnly,
      worktreeBranch: params.worktree,
      worktreePath,
      targetRepo: worktreePath ? targetRepo : undefined,
      baseSha,
      worktreeBaseSha,
      doNotTouch: params.doNotTouch,
      requestOpts,
      initialPrompt: lanePrompt,
      turnTimeoutMs: minted.turnTimeoutMs,
      supervised: minted.supervision === "sonnet",
      issueRef,
      ghRunner: this.ghRunner,
      // The DISPATCH PROFILE id (`codex-review`), not the OpenCode agent
      // profile in `requestOpts.profile` — the issue comment names which seat
      // shape produced the verdict, and "worker" answers nothing. Only the
      // profile entrance mints one, so a direct dispatchStart run simply names
      // its lane.
      profileId: minted.profileId,
    });
    this.runs.set(id, run);

    const drive = this.turnDriver.driveNewSession(run, spec, lanePrompt);
    this.turnDriver.trackDrive(id, drive);
    return { id, warnings };
  }

  // ---- turns --------------------------------------------------------------

  /**
   * Run another turn on a job that already came back — the correction ("严父")
   * flow. This is a public server entrance (`clanker_prompt`, tools.ts), so it
   * keeps its address on the manager; the turn itself — both of its shapes,
   * and every refusal that guards them — lives in turn-driver.ts.
   */
  promptExisting(
    id: string,
    prompt: string,
    correction = false,
    model?: string,
  ): Promise<{ id: string; status: RunStatus }> {
    // NOT `async` (cold review codex-1c87b, verified with an event-loop probe):
    // an async wrapper around an async call resolves its own promise three
    // microtasks after the inner one, so `await promptExisting(); cancel()`
    // could resume a turn later than the pre-refactor shape did — a caller
    // aiming at the still-running window could land past terminal. Returning
    // the driver's promise directly costs one tick instead of three, which is
    // the floor for any delegation; the refactor may not make the engine
    // slower to observe than the code it replaced.
    return this.turnDriver.promptExisting(id, prompt, correction, model);
  }

  // ---- long-poll ----------------------------------------------------------

  /**
   * `quiet` (default true) is the debounce mode: the long-poll only wakes early
   * on a plan/status change, a tool error, a suspected stall, or a terminal
   * state — not on every trivial event (tool_call start, file-location echo,
   * message-chunk fragment). That chatter used to make clanker_wait return
   * near-instantly on every grep/read, forcing callers into tight repolling.
   * Pass `quiet: false` to restore the legacy any-event wake-up.
   */
  async wait(id: string, timeoutMs?: number, quiet = true): Promise<WaitResult> {
    const run = this.runs.get(id);
    // A run this process does not hold has no event stream here. When its owner
    // is dead the files it left are the only truth there is, so the wait
    // degrades to polling them rather than refusing (#32); while the owner
    // lives, the refusal stands.
    if (!run) return await this.waitForeign(id, timeoutMs);
    // CP6: single-consumer contract — a concurrent clanker_wait on the same id would
    // race the shared digest cursor, so reject it outright.
    if (this.activeWaits.has(id)) {
      throw new Error(`clanker_wait already in progress for '${id}' (one waiter per run)`);
    }
    this.activeWaits.add(id);
    try {
      const budget = clampWait(timeoutMs);
      const deadline = Date.now() + budget;
      const shouldWake = () =>
        quiet
          ? run.hasUnreportedSignificant() || run.suspectedStallEdge(this.stallThresholdMs)
          : run.hasUnreported();
      while (!run.isTerminalTurn() && !shouldWake() && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        await run.waitForSignal(Math.min(remaining, 1_000));
      }
      return this.buildWaitResult(run);
    } finally {
      this.activeWaits.delete(id);
    }
  }

  /**
   * `clanker_wait` for an orphan whose server is gone — the degraded half of
   * the adoption protocol (#32 segment 3).
   *
   * A wait normally consumes an event stream this process owns. For a foreign
   * run there is no stream and there never will be one, so this polls the two
   * durable facts the dead owner left behind — `telemetry.terminal_at` and
   * `result.md` — for the caller's own timeout budget, and says so in the
   * payload: `degraded: "disk-poll"`, and an EMPTY digest with an explicit note
   * that there is no digest to be had. Synthesizing plausible-looking progress
   * out of file mtimes would be the same lie in a new costume; the caller must
   * be able to tell "nothing happened" from "I cannot see what happened".
   *
   * No `activeWaits` gate here, deliberately: that gate exists because
   * concurrent waiters race a shared digest CURSOR (CP6), and a read-only poll
   * of two files has no cursor to race.
   */
  private async waitForeign(id: string, timeoutMs?: number): Promise<WaitResult> {
    let foreign = readForeignRun(id, this.runsRoot);
    if (!foreign) this.throwUnknownRun(id);
    const owner = probeOwner(foreign.server_pid);
    if (owner.state !== "dead") throw new Error(foreignControlRefusal(id, foreign, owner));

    const deadline = Date.now() + clampWait(timeoutMs);
    while (!foreign.terminal_at && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(FOREIGN_POLL_MS, Math.max(1, deadline - Date.now()))));
      // A vanished record (retention swept the directory mid-poll) keeps the
      // last reading rather than crashing the wait: the caller still gets a
      // truthful "this is the last thing that was on disk".
      foreign = readForeignRun(id, this.runsRoot) ?? foreign;
    }
    return this.buildForeignWaitResult(foreign, owner.detail);
  }

  private buildForeignWaitResult(foreign: ForeignRun, ownerDetail: string): WaitResult {
    const swap = modelSwapWarning(foreign.resolved_model, foreign.observed_model);
    const result: WaitResult = {
      id: foreign.id,
      lane: foreign.lane ?? "unknown",
      status: foreignRunStatus(foreign),
      // Empty because there is nothing to report, not because the run was
      // quiet — degraded_note carries that distinction to the reader.
      digest: "",
      plan_summary: "(foreign run — plan state died with the owning process)",
      last_event_age_ms: foreign.last_activity_ms,
      suspected_stall: foreign.last_activity_ms >= 0 && foreign.last_activity_ms > this.stallThresholdMs,
      run_dir: foreign.run_dir,
      degraded: "disk-poll",
      degraded_note:
        `${ownerDetail}, so this wait polled ${foreign.run_dir} instead of an event stream. There is NO digest, ` +
        "no plan and no final_message for this run: those live in the process that spawned it and are not on " +
        "disk. status/terminal state, the verdict file, observed_model and the issue-comment account below come " +
        "straight from telemetry.json; nothing here is inferred. The one exception is `warnings`, which is " +
        "COMPUTED here by comparing two of those telemetry fields (resolved_model against observed_model) — " +
        "stated so a reader knows it is this server's reading of the record, not something the dead owner wrote.",
      observed_model: foreign.observed_model,
      // Same derivation as the live path (#54), off the same two telemetry
      // fields — a swap does not become less wrong because the process that
      // committed it has died.
      ...(swap ? { warnings: [swap] } : {}),
      // The #27 account survives its owner because it lives in telemetry.json.
      // `issue_comment_pending` on a run whose owner is dead means the post
      // will never resolve — the honest reading is "go look at the ticket",
      // which is precisely what a dispatcher needs and could not previously
      // see from this path at all.
      ...(foreign.issue_comment_error !== null ? { issue_comment_error: foreign.issue_comment_error } : {}),
      ...(foreign.issue_comment_pending ? { issue_comment_pending: true } : {}),
    };
    if (foreign.result_path) {
      result.result_path = foreign.result_path;
      try { result.result_bytes = fs.statSync(foreign.result_path).size; } catch { /* swept under us */ }
    }
    return result;
  }

  private buildWaitResult(run: LaneRun): WaitResult {
    const status = run.turnStatus;
    const telemetry = run.telemetry();
    const result: WaitResult = {
      id: run.id,
      lane: run.lane,
      status,
      digest: run.drainDigest(),
      plan_summary: run.planSummary(),
      last_event_age_ms: run.lastEventAgeMs(),
      suspected_stall: run.suspectedStall(this.stallThresholdMs),
      run_dir: run.runDir,
    };
    // DERIVED, not stored (#54). The swap is a fact about the telemetry this
    // wait is already reading, so it is recomputed on every wait rather than
    // pushed into `warningsById` the way dispatch-time advisories are: the
    // backend only reports `observed_model` once the session exists, and a
    // resume turn can legitimately move the run onto another model, so a
    // latched warning would either miss the swap or outlive it. Raised as soon
    // as it is knowable — NOT gated on the terminal branch below — because a
    // dispatcher polling a live run can still cancel it.
    const swap = modelSwapWarning(telemetry.resolved_model, telemetry.observed_model);
    const warnings = dedupe([...(this.warningsById.get(run.id) ?? []), ...(swap ? [swap] : [])]);
    if (warnings.length) result.warnings = warnings;
    if (run.isTerminalTurn()) {
      const resultBytes = run.resultBytes();
      if (resultBytes > 0) {
        result.result_path = run.resultPath();
        result.result_bytes = resultBytes;
      }
      result.final_message = run.finalMessage();
      result.touched_files = run.finalTouched();
      if (run.contractViolations && run.contractViolations.length > 0) {
        result.contract_violations = run.contractViolations;
      }
      result.plan_final = run.planState();
      if (run.error) result.error = annotatedError(run.error, run.failureClass);
      if (run.failureClass) result.failure_class = run.failureClass;
      if (run.worktreeRetained) result.worktree_retained = run.worktreeRetained;
      result.telemetry = telemetry;
    }
    return result;
  }

  // ---- cheap queries ------------------------------------------------------

  status(id: string): LaneStatusView {
    const run = this.runs.get(id);
    if (!run) this.throwUnknownRun(id);
    const view: LaneStatusView = {
      id: run.id,
      lane: run.lane,
      status: run.turnStatus,
      plan_summary: run.planSummary(),
      plan: run.planState(),
      tool_calls: run.toolCalls(),
      last_event_age_ms: run.lastEventAgeMs(),
      suspected_stall: run.suspectedStall(this.stallThresholdMs),
      cwd: run.cwd,
      run_dir: run.runDir,
      ...(run.resultBytes() > 0 ? { result_path: run.resultPath() } : {}),
      ...(run.worktreePath ? { worktree: run.worktreePath } : {}),
      telemetry: run.telemetry(),
    };
    if (run.turnStatus === "error" && run.error) {
      view.error = annotatedError(run.error, run.failureClass);
      if (run.failureClass) view.failure_class = run.failureClass;
    }
    return view;
  }

  /**
   * Reject an id this process does not hold — telling the caller WHICH kind of
   * absent it is (#32).
   *
   * `run '<id>' not found` was the same sentence for two opposite situations:
   * an id that never existed, and an id that is running right now in another
   * session's server. The documented recovery for a dropped relay reads the
   * lifecycle tools first and re-dispatches when they come back empty, so the
   * second case rendered as the first is how one contract ends up with two
   * live workers both opening PRs. Disk knows the difference; ask it.
   *
   * A THIRD kind of absent joined those two with the traversal fix
   * (foreign.ts isValidRunId): an id that could never name a run at all. It
   * gets its own sentence, because "no record of it on disk" would be a lie of
   * the same family — it says a lookup happened and came back empty, when in
   * fact nothing was looked up and nothing outside the runs root was touched.
   *
   * Never returns.
   */
  private throwUnknownRun(id: string): never {
    if (!isValidRunId(id)) {
      throw new Error(
        `run id '${String(id).slice(0, 80)}' is MALFORMED — a Clanker run id is '<lane>-<suffix>' ` +
          `(e.g. 'codex-1a2b3c'), and this one is not, so no lookup was performed at all. Nothing was read ` +
          `from ${this.runsRoot}, and nothing outside it was read, written or signalled. This is not the same ` +
          `answer as "no such run": a run that exists cannot have this id.`,
      );
    }
    const foreign = readForeignRun(id, this.runsRoot);
    if (foreign) throw new Error(foreignControlRefusal(id, foreign));
    throw new Error(
      `run '${id}' not found — no such run in this process, and no record of it on disk under ${this.runsRoot}`,
    );
  }

  /**
   * Everything in flight that this process can see — its own runs, plus (#32)
   * the ones another session's server is holding, reconstructed from disk.
   *
   * The foreign half exists because the honest answer to "what is running?"
   * was previously `[]` whenever the asker was in a different session from the
   * dispatcher, and an empty list reads as "nothing started" rather than
   * "I cannot see". That is the reading that produces two workers on one
   * contract.
   */
  list(): LaneListEntry[] {
    const out: LaneListEntry[] = [];
    const mine = new Set<string>();
    for (const run of this.runs.values()) {
      mine.add(run.id);
      // #37 A1: `close(id)` runs its real async teardown (closeAndWait — up to
      // ~4s of subprocess/git shell-out) BEFORE the matching completeTurn() /
      // failTurn() / cancelTurn() flips turnStatus off "running" (see every
      // call site above). `sessionClosed` alone is true partway through that
      // window while the job is still genuinely running — filtering on it by
      // itself hid an in-flight job from list() entirely (it is also in
      // `mine`, so the foreign scan below correctly stays silent about it
      // too): status/wait still answered "running" while list() said nothing
      // was there at all. Only skip once the turn has ALSO reached a terminal
      // state.
      if (run.sessionClosed && run.isTerminalTurn()) continue;
      out.push({
        id: run.id,
        lane: run.lane,
        state: run.sessionState(this.stallThresholdMs),
        idle_ms: run.idleMs(),
        turns_count: run.turnsCount,
        plan_summary: run.planSummary(),
        suspected_stall: run.suspectedStall(this.stallThresholdMs),
        owner: "this-process",
      });
    }
    for (const foreign of scanForeignRuns({ runsRoot: this.runsRoot, exclude: mine })) {
      out.push({
        id: foreign.id,
        lane: foreign.lane ?? "unknown",
        // Never "working": this process has no event stream for a foreign run,
        // so it cannot tell working from wedged. `idle` plus a truthful
        // last-activity age says what is actually known.
        state: "idle",
        idle_ms: foreign.last_activity_ms,
        turns_count: foreign.turns ?? 0,
        // Not synthesized from anything. Plan state lives in the owning
        // process's memory and is not on disk; an invented summary here would
        // be a fabrication on the one board people scan for orphans.
        plan_summary: "(foreign run — plan state lives in the owning process)",
        suspected_stall: foreign.last_activity_ms >= 0 && foreign.last_activity_ms > this.stallThresholdMs,
        owner: "foreign",
        run_dir: foreign.run_dir,
        ...(foreign.result_path ? { result_path: foreign.result_path } : {}),
        observed_model: foreign.observed_model,
      });
    }
    return out;
  }

  // ---- cancel / close -----------------------------------------------------

  async cancel(id: string): Promise<CancelResult> {
    const run = this.runs.get(id);
    // Not in this process's map: either it never existed, or another session's
    // server owns it. The second case used to end here in a flat refusal; it
    // now ends there only while that server is alive (#32, adoption).
    if (!run) return await this.cancelForeign(id);
    // A run whose turn is already terminal has no turn to cancel — but it can
    // still be HOLDING things. The supervised profile deliberately keeps its
    // session (and therefore its worktree) alive past a successful turn so a
    // correction turn stays possible, until the idle-TTL reaper closes it
    // minutes later. In that window `clanker_cancel` used to return without
    // doing anything at all, so a seat that had decided "no correction needed"
    // could not give the tree back and had to wait the TTL out — the one
    // remaining window where a live tree is held by nothing but a timer (#3).
    //
    // Cancel here means RECLAIM THE SESSION AND THE TREE, not "undo the work":
    // the work already finished and its terminal status is the truth of what
    // happened, so that status is reported back unchanged (a done run stays
    // done; it is never rewritten to cancelled). An already-closed run keeps
    // returning immediately — there is nothing left to hand back.
    if (run.turnStatus !== "running") {
      if (!run.sessionClosed) {
        await this.close(id);
        // The close above may have retained the tree (dirty / unmerged /
        // capture-failed). Report that HERE, on cancel's own return — the
        // packaged supervisor delivers fields off the last result it holds,
        // and a seat that already decided "no correction needed" has no
        // reason to issue another wait just to learn what this call already
        // knows (PR #38 cold review: a cancel-then-report seat handed back
        // stale pre-close evidence).
        return {
          id,
          status: run.turnStatus,
          run_dir: run.runDir,
          ...(run.worktreeRetained ? { worktree_retained: run.worktreeRetained } : {}),
        };
      }
      return { id, status: run.turnStatus };
    }
    run.requestCancellation();
    const pending = this.turnDriver.pendingConnect(id);
    if (pending) {
      pending.abort();
      await this.turnDriver.driveFor(id);
      return { id, status: run.turnStatus };
    }
    const conn = this.connections.get(id);
    if (conn) {
      try { await conn.cancel(); } catch { /* escalation below */ }
      const deadline = Date.now() + this.cancelGraceMs;
      while (!run.isTerminalTurn() && Date.now() < deadline) {
        await run.waitForSignal(Math.max(0, deadline - Date.now()));
      }
      if (run.turnStatus === "running") {
        run.markForcedKill();
        await this.computeTouched(run);
        await this.close(id);
        await run.cancelTurn();
      }
    }
    if (run.turnStatus === "running") {
      await this.computeTouched(run);
      await this.close(id);
      await run.cancelTurn();
    }
    return { id, status: run.turnStatus };
  }

  /**
   * Cancel a run held by another server process — the orphan-adoption protocol
   * (#32, design frozen on the issue; mechanics in adopt.ts).
   *
   * The pre-adoption behaviour was honest but powerless: a foreign id was
   * refused, full stop. That is correct while the owning server exists, and
   * exactly wrong once it does not — a dead session leaves a live worker
   * holding a worktree with nobody able to stop it, which is the precise
   * failure the durable pid record was written for.
   *
   * Four steps, in this order, none skippable:
   *
   *  1. OWNER LIVENESS. Only a provably dead owner (ESRCH) unlocks anything.
   *     Alive — or unprovable, e.g. a record with no server_pid — keeps the
   *     old refusal, now with the reason attached.
   *  2. WORKER IDENTITY. A pid is a number, not a process. Signal it only
   *     while its observed start time still matches the recorded one.
   *  3. GROUP KILL with a RE-CHECK between TERM and KILL, because the grace
   *     window is exactly when the pid becomes reusable.
   *  4. ARCHIVE — the step whose absence would make the other three
   *     counterproductive: a killed orphan whose telemetry still reads
   *     `terminal_at: null` haunts the orphan board forever, so the record is
   *     closed even when nothing was signalled at all. It has exactly ONE
   *     exception, and it is not "the kill failed": a record that is ALREADY
   *     terminal is left untouched (`archived: false`), because that record is
   *     the owner's own account of the run and this process has nothing truer
   *     to say about it (adopt.ts archiveAdoptedRun).
   */
  private async cancelForeign(id: string): Promise<CancelResult> {
    const foreign = readForeignRun(id, this.runsRoot);
    if (!foreign) this.throwUnknownRun(id);
    const owner = probeOwner(foreign.server_pid);
    if (owner.state !== "dead") throw new Error(foreignControlRefusal(id, foreign, owner));

    const outcome = await killAdoptedWorker({
      workerPid: foreign.worker_pid,
      workerStartedAt: foreign.worker_started_at,
      lane: foreign.lane,
      graceMs: this.cancelGraceMs,
    });
    const archive = archiveAdoptedRun({
      runDir: foreign.run_dir,
      id,
      adopterPid: process.pid,
      ownerPid: owner.pid,
      workerPid: foreign.worker_pid,
      outcome,
    });
    // Re-read rather than assume: the archive decides what the record now says
    // (it refuses to overwrite a terminal state the owner already wrote), so a
    // run that was already `done` comes back `done`, not rewritten to
    // `cancelled` by the act of cancelling it.
    const after = readForeignRun(id, this.runsRoot) ?? foreign;
    const note = [
      `${owner.detail}, so this process (pid ${process.pid}) adopted the run`,
      outcome.note,
      archive.archived
        ? archive.result_stub_written
          ? "wrote a result.md stub"
          : "left the existing result.md in place"
        : `record NOT archived: ${archive.reason ?? "no reason given"}`,
      ...archive.problems,
    ].join("; ");
    return {
      id,
      status: foreignRunStatus(after),
      adopted: true,
      owner_pid: owner.pid,
      worker_pid: foreign.worker_pid,
      killed: outcome.killed,
      identity_verified: outcome.identity_verified,
      archived: archive.archived,
      ...(archive.archived ? {} : { archive_reason: archive.reason }),
      run_dir: foreign.run_dir,
      ...(after.result_path ? { result_path: after.result_path } : {}),
      note,
    };
  }

  private async computeTouched(run: LaneRun): Promise<void> {
    let gitTouched: string[] = [];
    try { if (run.lane !== "gemini" && await isGitWorkTree(run.cwd)) gitTouched = await changedFiles(run.cwd); } catch {}
    run.setFinalTouched(dedupe([...gitTouched, ...run.toolTouchedFiles()]));
  }

  /**
   * Terminal doNotTouch validation: diff the run's worktree against the commit
   * it was cut from (committed AND uncommitted changes — an uncommitted edit
   * to a forbidden path is the same breach as a committed one) and match the
   * touched paths against the caller's patterns. Stored on the run; the wait
   * payload and result.md read it from there.
   *
   * Called from more than one terminal transition on a supervised run (the
   * success path in `finalizeTurn`, then again from `closeRun` once the
   * session truly closes — possibly after one or more correction rounds), so
   * this ALWAYS recomputes rather than memoizing on "already set": the set of
   * violations is a recompute against current worktree state each time, never
   * an accumulation across calls (a fixed correction's diff must be able to
   * come back clean on the next terminal state, not carry forward a stale
   * finding).
   *
   * Never fails silently: if the diff itself cannot be computed (e.g. the
   * worktree HEAD moved to something the diff can't read), that is itself a
   * fact the supervising seat needs — a validation that could not run must
   * not read the same as "ran and found nothing".
   */
  private async computeContractViolations(run: LaneRun): Promise<void> {
    if (!run.doNotTouch || run.doNotTouch.length === 0) return;
    // Below this line the run DID declare a doNotTouch contract, so a
    // recompute that cannot even run the diff must say so LOUDLY — same
    // reasoning as the try/catch below, just for the two conditions that
    // used to return silently and leave a PRIOR call's violations (or no
    // violations at all) stale on the run. This function recomputes on every
    // terminal transition (see the doc comment above), so a supervised run
    // that reported a real violation on its first terminal state and then
    // loses its worktree/base before the session truly closes must not be
    // read as "the violation went away".
    if (!run.worktreePath) {
      run.contractViolations = [
        { pattern: "(validation-failed)", files: ["no worktree path recorded for this run"] },
      ];
      return;
    }
    if (!run.worktreeBaseSha) {
      run.contractViolations = [
        { pattern: "(validation-failed)", files: ["no worktree base SHA recorded for this run"] },
      ];
      return;
    }
    if (!fs.existsSync(run.worktreePath)) {
      run.contractViolations = [
        { pattern: "(validation-failed)", files: [`worktree path '${run.worktreePath}' no longer exists`] },
      ];
      return;
    }
    try {
      const touched = await changedFilesSince(run.worktreePath, run.worktreeBaseSha);
      run.contractViolations = matchDoNotTouch(run.doNotTouch, touched);
    } catch (err) {
      console.error(
        `[clanker] doNotTouch validation failed for '${run.id}': ${errMessage(err)}`,
      );
      // Fail LOUD into the contract, not just stderr: a validation error is
      // itself the finding a supervising seat must see, not a silent zero.
      run.contractViolations = [{ pattern: "(validation-failed)", files: [errMessage(err)] }];
    }
  }

  /** Close a session: dispose ACP session, kill subprocess, clean worktree. */
  async close(id: string): Promise<void> {
    const existing = this.closing.get(id);
    if (existing) return existing;
    const operation = this.closeRun(id);
    this.closing.set(id, operation);
    try {
      await operation;
    } finally {
      if (this.closing.get(id) === operation) this.closing.delete(id);
    }
  }

  private async closeRun(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.sessionClosed) return;
    const conn = this.connections.get(id);
    let processStopped = true;
    if (conn) {
      try {
        await conn.closeAndWait();
      } catch (err) {
        processStopped = false;
        console.error(
          `[clanker] subprocess shutdown failed for '${id}': ${errMessage(err)}`,
        );
      } finally {
        if (this.connections.get(id) === conn) this.connections.delete(id);
      }
    }
    if (run.worktreePath && run.worktreeBranch) {
      // doNotTouch validation MUST run here, before removeIfClean can delete a
      // clean worktree: closeRun is the last point where the tree is
      // guaranteed to still exist on disk, and the terminal status flip
      // (completeTurn/failTurn/cancelTurn → result.md, wait payload) happens
      // strictly after close() returns. The verdict is stored on the run for
      // those readers.
      await this.computeContractViolations(run);
      if (!processStopped) {
        run.worktreeRetained = run.worktreePath;
      } else {
        try {
          // Pass the cut point this run RECORDED (#33): cleanup must judge
          // "does this tree hold commits that exist nowhere else" against the
          // commit the tree was really cut from, not against a re-resolution of
          // a ref that has been free to move since the tree was created.
          // `run.id` is this run's ownership claim (#3): removeIfClean refuses
          // any tree whose `.clanker-owner` marker names a different run, so
          // closing a dead run can no longer delete a live one's tree even if
          // both were dispatched on the same branch name.
          const removed = await removeIfClean(
            run.worktreePath,
            run.targetRepo ?? this.baseRepo,
            run.worktreeBaseSha,
            run.id,
          );
          if (!removed) run.worktreeRetained = run.worktreePath;
        } catch (err) {
          // Never let cleanup failure vanish silently — this is a stdio MCP
          // server, so diagnostics can only go to stderr (stdout is the wire
          // protocol). Control flow is unchanged: still retain, never rethrow.
          console.error(
            `[clanker] worktree cleanup failed for '${run.worktreePath}': ${errMessage(err)}`,
          );
          run.worktreeRetained = run.worktreePath;
        }
      }
    }
    await run.markClosed();
  }

  /**
   * Reap idle sessions past TTL. Exposed for tests.
   *
   * Completed jobs are closed after the idle TTL.
   */
  async reap(): Promise<string[]> {
    const reaped: string[] = [];
    for (const run of [...this.runs.values()]) {
      if (run.sessionClosed) continue;
      // #37 A2: a run with an in-flight drive (attemptInitialTurn/
      // driveContinuation still running) owns its own close()+terminal
      // transition. Reaping it here would race that drive's own close() call
      // — same target, same dedup map, harmless on its own — but against a
      // drive that has NOT yet reached `run.isTerminalTurn()`, e.g. mid
      // promptExisting continuation, which is exactly the shape A2 exists to
      // protect.
      if (this.turnDriver.hasDrive(run.id)) continue;
      if (run.turnStatus !== "running" && run.idleMs() > this.sessionTtlMs) {
        await this.close(run.id);
        reaped.push(run.id);
      }
    }
    return reaped;
  }

  /** Tear down everything (server shutdown). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = null;
    for (const run of this.runs.values()) {
      if (run.turnStatus === "running") run.requestCancellation();
    }
    this.turnDriver.abortPendingConnects();
    await Promise.all([...this.connections.keys()].map((id) => this.turnDriver.killConnection(id)));
    // The driver hands back the same `Promise.allSettled` this line used to
    // build inline; awaiting it directly keeps the final close loop on the same
    // tick it started on before the split (same review).
    await this.turnDriver.settleAllDrives();
    // A pending handshake may have crossed into an established connection
    // during the first snapshot; the shutdown flag makes that drive close it
    // before settling. This final pass closes every run's durable session and
    // worktree only after all tracked turn state has reached a terminal value.
    for (const id of [...this.runs.keys()]) {
      await this.close(id);
    }
  }
}

// errMessage / annotatedError / createTimeout / dedupe / clampWait / envInt
// live in util.ts (#37 A4) — zero coupling to LaneManager's instance state.
// assertWorktreeOutsideRepo / realpathBestEffort live in worktree.ts, next to
// the rest of the worktree lifecycle logic the guard enforces.
// The turn engine (trackDrive / driveNewSession / promptExisting /
// driveContinuation / abortDuringSetup / attemptInitialTurn / retryAfterBackoff
// / runTurn / killConnection / finalizeTurn) lives in turn-driver.ts, reaching
// back only through TurnHost.
