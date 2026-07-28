/**
 * LaneManager — owns lane sessions across their whole lifecycle: spawn +
 * handshake, per-turn prompt loops, plan/status projection, long-poll (clanker_wait),
 * cancel, worktree cleanup, and the
 * idle-TTL reaper.
 *
 * The spawn recipe is resolved through an injectable `resolveSpec` so tests can
 * point every lane at a scripted fake ACP agent while production uses the real
 * lane registry.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LaneConnection } from "./acp-client.js";
import {
  BASE_REPO,
  CANCEL_GRACE_MS,
  CAPACITY_RETRY_BACKOFF_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  HANDSHAKE_TIMEOUT_MS,
  isGlmModel,
  RUNS_ROOT,
  TURN_TIMEOUT_MS,
} from "./constants.js";
import { buildSpawnSpec } from "./backends.js";
import { foreignControlRefusal, readForeignRun, scanForeignRuns } from "./foreign.js";
import { classifyTurnFailure, INFRA_FAILURE_TAG, isCapacityTransient } from "./failure-classifier.js";
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
import {
  assertWorktreeOutsideRepo,
  changedFiles,
  createWorktree,
  deriveWorktreePath,
  isGitWorkTree,
  removeIfClean,
  resolveTargetRepo,
} from "./worktree.js";
import { annotatedError, clampWait, createTimeout, dedupe, envInt, errMessage, stderrSuffix } from "./util.js";

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
  if (!readOnly && params.lane !== "codex" && !params.model?.trim()) {
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
  return { params, profile, readOnly, requiresIsolation };
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
  profileId: string;
  cwd: string;
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

export interface WaitResult {
  id: string;
  lane: LaneName;
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
  plan_final?: RunFinal["plan_final"];
  worktree_retained?: string;
  error?: string;
  /** Present alongside `error` when classifyTurnFailure tagged it (e.g. CLANKER-INFRA-FAILURE). */
  failure_class?: string;
  telemetry?: import("./types.js").RunTelemetry;
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

/** Outcome of one prompt-turn attempt; callers decide terminal-fail vs retry. */
type TurnOutcome = { ok: true } | { ok: false; message: string };

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
  private readonly warningsById = new Map<string, string[]>();
  private readonly pendingConnects = new Map<string, AbortController>();
  private readonly turnDrives = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, Promise<void>>();
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
    if (!opts.disableReaper) {
      const period = Math.max(5_000, Math.floor(this.sessionTtlMs / 10));
      this.reaperTimer = setInterval(() => void this.reap(), period);
      this.reaperTimer.unref?.();
    }
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
        model: resolved.model,
        effort: resolved.effort,
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
    const { profile, readOnly } = validated;

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
    let targetRepo = path.resolve(this.baseRepo);
    if (params.worktree && params.cwd) {
      targetRepo = await resolveTargetRepo(params.cwd);
    }

    const id = `${params.lane}-${(++this.counter).toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    const runDir = path.join(this.runsRoot, id);
    fs.mkdirSync(runDir, { recursive: true });

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
      profileId: profile,
      cwd: params.cwd ?? this.baseRepo,
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
    let worktreePath: string | undefined;
    let spec: SpawnSpec;
    try {
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
        assertWorktreeOutsideRepo(deriveWorktreePath(params.worktree), targetRepo);
        worktreePath = await createWorktree(params.worktree, targetRepo);
        cwd = worktreePath;
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
    this.warningsById.set(id, spec.warnings);

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
      requestOpts,
      initialPrompt: params.prompt,
      turnTimeoutMs: minted.turnTimeoutMs,
      supervised: minted.supervision === "sonnet",
    });
    this.runs.set(id, run);

    const drive = this.driveNewSession(run, spec, params.prompt);
    this.trackDrive(id, drive);
    return { id, warnings: spec.warnings };
  }

  private trackDrive(id: string, drive: Promise<void>): void {
    this.turnDrives.set(id, drive);
    void drive.then(
      () => { if (this.turnDrives.get(id) === drive) this.turnDrives.delete(id); },
      () => { if (this.turnDrives.get(id) === drive) this.turnDrives.delete(id); },
    );
  }

  private async driveNewSession(run: LaneRun, spec: SpawnSpec, prompt: string): Promise<void> {
    await this.attemptInitialTurn(run, spec, prompt, 1);
  }

  /**
   * Run another turn on a session that is still open — the supervised
   * correction ("严父") flow.
   *
   * This is turn-by-turn supervision, NOT mid-flight steering: ACP has no way
   * to redirect a prompt already in progress, so a correction is a new turn
   * issued after the previous one came back. The window is bounded by the
   * idle-TTL reaper, which closes a finished session after `sessionTtlMs` —
   * miss it and the only honest answer is that the session is gone, not a
   * silently respawned worker with no memory of what it was corrected about.
   *
   * The capability is checked against the REGISTRY ROW that minted the run
   * (`run.supervised`), not against which tool the caller holds. Holding
   * `clanker_prompt` is necessary but not sufficient: an unsupervised profile
   * refuses the correction server-side, so the narrow-tool property survives a
   * seat file that drifts.
   */
  async promptExisting(id: string, prompt: string, correction = false): Promise<{ id: string; status: RunStatus }> {
    const run = this.runs.get(id);
    if (!run) this.throwUnknownRun(id);
    if (!run.supervised) {
      throw new Error(
        `run '${id}' was not started from a supervised profile, so it takes no correction turn ` +
          `(only the supervised shape accepts one — see profiles.ts supervision)`,
      );
    }
    // #37 A2: neither of these is covered by the checks below. `shuttingDown`
    // can go true between a caller reading a run's status and issuing the
    // correction; `this.closing` covers the narrower window where the reaper
    // (or an operator) already started close(id) — closeAndWait() is a real
    // async subprocess teardown, so at this point sessionClosed is still
    // false and `conn` is still in `this.connections`, and without this gate
    // a correction would be sent down a connection that a SIGTERM is racing
    // to kill, with the worktree possibly removed out from under it moments
    // later. Both are true answers, not retry prompts — same register as the
    // "session is gone" sentence below.
    if (this.shuttingDown) {
      throw new Error(`Clanker manager is shutting down; refusing a correction turn for '${id}'`);
    }
    if (this.closing.has(id)) {
      throw new Error(
        `session for '${id}' is closing right now — the correction window has already passed. ` +
          `The worker cannot be corrected mid-teardown; report the blocker instead of retrying.`,
      );
    }
    if (run.turnStatus === "running" || this.turnDrives.has(id)) {
      throw new Error(`a turn is already running for '${id}'; wait for it to reach a terminal state first`);
    }
    if (run.sessionClosed) throw new Error(`session for '${id}' is already closed`);
    const conn = this.connections.get(id);
    if (!conn) {
      throw new Error(
        `session for '${id}' is gone — a finished session is closed by the idle-TTL reaper after ` +
          `${this.sessionTtlMs}ms (CLANKER_SESSION_TTL_MS). The worker cannot be corrected; report the ` +
          `blocker instead of starting a fresh dispatch on your own.`,
      );
    }
    const drive = this.driveContinuation(run, conn, prompt, correction);
    this.trackDrive(id, drive);
    return { id, status: run.turnStatus };
  }

  private async driveContinuation(run: LaneRun, conn: LaneConnection, prompt: string, correction: boolean): Promise<void> {
    const outcome = await this.runTurn(run, conn, prompt, correction);
    if (run.cancellationRequested) {
      await this.close(run.id);
      run.cancelTurn();
      return;
    }
    if (run.isTerminalTurn()) return;
    if (outcome.ok) return;
    // No capacity-retry here, unlike a fresh dispatch's first turn: the retry
    // path respawns the subprocess, which would destroy the very session this
    // continuation exists to reuse — and the worker would come back with no
    // memory of the work it is being corrected about.
    await this.computeTouched(run);
    await this.close(run.id);
    run.failTurn(
      outcome.message,
      classifyTurnFailure({ message: outcome.message, turnsCount: run.turnsCount, toolCalls: run.toolCalls() }),
    );
  }

  /**
   * Shared teardown for the three "cancellation/shutdown raced setup" spots in
   * `attemptInitialTurn` below (#37 A3) — before connect, after connect throws,
   * and after connect succeeds. Only the third has a live `conn` to close;
   * the first two race in before one exists. Behavior is byte-for-byte what
   * all three call sites did inline before this extraction.
   */
  private async abortDuringSetup(run: LaneRun, conn?: LaneConnection): Promise<void> {
    if (!run.cancellationRequested) run.requestCancellation();
    if (conn) {
      try {
        await conn.closeAndWait();
      } catch (err) {
        console.error(`[clanker] subprocess shutdown failed for '${run.id}': ${errMessage(err)}`);
      }
    }
    await this.computeTouched(run);
    await this.close(run.id);
    run.cancelTurn();
  }

  /**
   * Drive the first turn of a fresh dispatch, with one automatic retry when
   * the failure looks like a transient backend-capacity condition (see
   * failure-classifier.ts isCapacityTransient). CLANKER-INFRA-FAILURE never
   * retries here — retrying an identical request against a backend that just
   * rejected its shape wastes a turn and hides the real signal (2026-07-13
   * incident: exactly that class was hand-retried 3 times before anyone
   * noticed). Retry scope is intentionally limited to the job's first turn.
   */
  private async attemptInitialTurn(run: LaneRun, spec: SpawnSpec, prompt: string, attempt: number): Promise<void> {
    if (run.cancellationRequested || this.shuttingDown) {
      await this.abortDuringSetup(run);
      return;
    }
    let conn: LaneConnection;
    const controller = new AbortController();
    this.pendingConnects.set(run.id, controller);
    try {
      conn = await LaneConnection.connect({
        spec,
        cwd: run.cwd,
        readOnly: run.readOnly,
        onFileWritten: (p) => run.recordFileWritten(p),
        handshakeTimeoutMs: this.handshakeTimeoutMs,
        terminateGraceMs: this.processTerminateGraceMs,
        signal: controller.signal,
      });
    } catch (e) {
      if (run.cancellationRequested || this.shuttingDown) {
        await this.abortDuringSetup(run);
        return;
      }
      const message = errMessage(e);
      if (attempt === 1 && isCapacityTransient(message)) {
        await this.retryAfterBackoff(run, message, attempt + 1);
        return this.attemptInitialTurn(run, spec, prompt, attempt + 1);
      }
      await this.computeTouched(run);
      await this.close(run.id);
      run.failTurn(message);
      return;
    } finally {
      if (this.pendingConnects.get(run.id) === controller) this.pendingConnects.delete(run.id);
    }
    if (run.cancellationRequested || this.shuttingDown) {
      await this.abortDuringSetup(run, conn);
      return;
    }
    this.connections.set(run.id, conn);
    run.sessionId = conn.sessionId;
    run.observeConfigOptions(conn.session.newSessionResponse.configOptions);

    const outcome = await this.runTurn(run, conn, prompt);
    if (run.cancellationRequested) {
      await this.close(run.id);
      run.cancelTurn();
      return;
    }
    if (run.isTerminalTurn()) return;
    if (outcome.ok) return;

    const failureClass = classifyTurnFailure({
      message: outcome.message,
      turnsCount: run.turnsCount,
      toolCalls: run.toolCalls(),
    });
    if (attempt === 1 && failureClass !== INFRA_FAILURE_TAG && isCapacityTransient(outcome.message)) {
      // Kill the half-dead process/connection (NOT run.close() — that would
      // also reap the worktree, which the retry needs to reuse) so the retry
      // spawns a clean process against the backend.
      await this.killConnection(run.id);
      await this.retryAfterBackoff(run, outcome.message, attempt + 1);
      return this.attemptInitialTurn(run, spec, prompt, attempt + 1);
    }
    await this.computeTouched(run);
    await this.close(run.id);
    run.failTurn(outcome.message, failureClass);
  }

  private async retryAfterBackoff(run: LaneRun, message: string, nextAttempt: number): Promise<void> {
    run.recordTransientRetry(message, this.capacityRetryBackoffMs, nextAttempt);
    const deadline = Date.now() + this.capacityRetryBackoffMs;
    while (!run.cancellationRequested && !this.shuttingDown) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await run.waitForSignal(remaining);
    }
  }

  /**
   * Drive one prompt turn to completion, projecting events into run state.
   * Returns the outcome instead of failing the run itself — callers decide
   * terminal-fail vs (for a fresh dispatch's first turn only) retry.
   *
   * CP1: every wait races three outcomes — the next ACP update, subprocess exit,
   * and a hard per-turn timeout — so a turn always reaches a terminal state.
   * suspected_stall stays a warning; this loop is the guaranteed terminal path.
   */
  private async runTurn(run: LaneRun, conn: LaneConnection, prompt: string, correction = false): Promise<TurnOutcome> {
    run.beginTurn(prompt, correction);
    const promptPromise = conn.session.prompt(prompt);
    promptPromise.catch(() => {
      /* rejection surfaced via the race / awaited below */
    });
    // Precedence: explicit constructor override (operator/test) > the profile's
    // declared ceiling > the global default. Without the override tier a test's
    // 80ms ceiling would be overwritten by a profile's 45 minutes.
    const turnTimeoutMs = this.turnTimeoutOverrideMs ?? run.turnTimeoutMs ?? this.turnTimeoutMs;
    const turnTimer = createTimeout(turnTimeoutMs);
    try {
      for (;;) {
        const nextP = conn.session.nextUpdate();
        const outcome = await Promise.race([
          // The onRejected handler both handles a losing update's late rejection
          // and turns a closed stream into a `closed` outcome (no unhandled reject).
          nextP.then(
            (m) => ({ kind: "msg" as const, m }),
            (err: unknown) => ({ kind: "closed" as const, err }),
          ),
          conn.exited.then((info) => ({ kind: "exit" as const, info })),
          turnTimer.promise.then(() => ({ kind: "timeout" as const })),
        ]);
        if (outcome.kind === "timeout") {
          // #37 B1: the stderr tail is readable evidence (conn.stderr()) even
          // when the process hasn't exited — a turn stuck on a backend that
          // logged a warning before hanging used to lose that evidence
          // entirely; only the exit-with-info branch below ever carried it.
          throw new Error(
            `turn exceeded CLANKER_TURN_TIMEOUT_MS (${turnTimeoutMs}ms) with no completion; killing the Clanker` +
              stderrSuffix(conn.stderr()),
          );
        }
        if (outcome.kind === "exit" || outcome.kind === "closed") {
          // Prefer the concrete exit info (code/signal/stderr); the ACP stream
          // often closes a beat before the exit event, so wait briefly for it.
          const info =
            outcome.kind === "exit"
              ? outcome.info
              : await Promise.race([conn.exited, createTimeout(500).promise.then(() => null)]);
          if (info) {
            const { code, signal, stderr } = info;
            throw new Error(`lane process exited mid-turn (code=${code} signal=${signal})${stderrSuffix(stderr)}`);
          }
          // #37 B1: no exit info arrived within the 500ms grace above — the
          // stream closed but the process's own exit event is still pending.
          // The stderr tail was previously dropped on this specific branch
          // even though acp-client.ts had been accumulating it the whole
          // time; conn.stderr() reads the same live buffer the exit-info
          // branch above reads from `info.stderr`.
          throw new Error(
            `ACP connection closed mid-turn: ${outcome.kind === "closed" ? errMessage(outcome.err) : "process exited"}` +
              stderrSuffix(conn.stderr()),
          );
        }
        if (outcome.m.kind === "stop") {
          const response = await promptPromise;
          run.recordStop(response);
          await this.finalizeTurn(run, response.stopReason);
          return { ok: true };
        }
        run.onUpdate(outcome.m.update);
      }
    } catch (e) {
      return { ok: false, message: errMessage(e) };
    } finally {
      turnTimer.cancel();
    }
  }

  /** Kill a run's live connection/process without touching worktree state (used by the capacity-retry respawn path; run.close() is the terminal, worktree-reaping teardown). */
  private async killConnection(runId: string): Promise<void> {
    const conn = this.connections.get(runId);
    if (conn) {
      try {
        await conn.closeAndWait();
      } catch (err) {
        console.error(
          `[clanker] subprocess shutdown failed for '${runId}': ${errMessage(err)}`,
        );
      } finally {
        if (this.connections.get(runId) === conn) this.connections.delete(runId);
      }
    }
  }

  private async finalizeTurn(run: LaneRun, stopReason: string): Promise<void> {
    if (run.isTerminalTurn()) return;
    // Compute git-detected changes for this turn's cwd (union with ACP signals).
    // Gemini has no ACP write surface and its workspace is mechanically
    // read-only; a post-turn `git status` there would only report changes that
    // already existed before reconnaissance and falsely attribute them to the
    // scout. Its truthful touched set therefore comes solely from ACP write
    // signals (none are exposed by the Gemini sidecar).
    let gitTouched: string[] = [];
    try {
      if (run.lane !== "gemini" && await isGitWorkTree(run.cwd)) gitTouched = await changedFiles(run.cwd);
    } catch {
      /* non-fatal: fall back to ACP-derived signals only */
    }
    const touched = dedupe([...gitTouched, ...run.toolTouchedFiles()]);
    run.setFinalTouched(touched);
    // A supervised run keeps its session open past this terminal turn — that
    // window IS the correction flow (promptExisting). Closing here would make
    // the strict-parent shape structurally impossible: the supervisor would be
    // handed a finished turn to judge and no session left to act on, which is
    // exactly the state the seat contract used to promise its way around.
    //
    // Only the SUCCESS path defers. An errored turn still closes on its own
    // paths above: a session whose backend just failed is not one to keep
    // holding a worktree open for. The deferred close (and the worktree
    // reaping inside it) then falls to the idle-TTL reaper, which already
    // closes any non-running run past sessionTtlMs — so the window is bounded
    // by an existing mechanism rather than a new one, and `worktree_retained`
    // becomes meaningful only once that close really happens.
    if (!run.supervised || stopReason === "cancelled") await this.close(run.id);
    if (stopReason === "cancelled") {
      run.cancelTurn();
    } else {
      run.completeTurn();
    }
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
    if (!run) this.throwUnknownRun(id);
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

  private buildWaitResult(run: LaneRun): WaitResult {
    const status = run.turnStatus;
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
    const warnings = this.warningsById.get(run.id);
    if (warnings && warnings.length) result.warnings = warnings;
    if (run.isTerminalTurn()) {
      const resultBytes = run.resultBytes();
      if (resultBytes > 0) {
        result.result_path = run.resultPath();
        result.result_bytes = resultBytes;
      }
      result.final_message = run.finalMessage();
      result.touched_files = run.finalTouched();
      result.plan_final = run.planState();
      if (run.error) result.error = annotatedError(run.error, run.failureClass);
      if (run.failureClass) result.failure_class = run.failureClass;
      if (run.worktreeRetained) result.worktree_retained = run.worktreeRetained;
      result.telemetry = run.telemetry();
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
   * Never returns.
   */
  private throwUnknownRun(id: string): never {
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

  async cancel(id: string): Promise<{ id: string; status: RunStatus }> {
    const run = this.runs.get(id);
    if (!run) this.throwUnknownRun(id);
    if (run.turnStatus !== "running") return { id, status: run.turnStatus };
    run.requestCancellation();
    const pending = this.pendingConnects.get(id);
    if (pending) {
      pending.abort();
      await this.turnDrives.get(id);
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
        run.cancelTurn();
      }
    }
    if (run.turnStatus === "running") {
      await this.computeTouched(run);
      await this.close(id);
      run.cancelTurn();
    }
    return { id, status: run.turnStatus };
  }

  private async computeTouched(run: LaneRun): Promise<void> {
    let gitTouched: string[] = [];
    try { if (run.lane !== "gemini" && await isGitWorkTree(run.cwd)) gitTouched = await changedFiles(run.cwd); } catch {}
    run.setFinalTouched(dedupe([...gitTouched, ...run.toolTouchedFiles()]));
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
      if (!processStopped) {
        run.worktreeRetained = run.worktreePath;
      } else {
        try {
          const removed = await removeIfClean(run.worktreePath, run.targetRepo ?? this.baseRepo);
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
      if (this.turnDrives.has(run.id)) continue;
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
    for (const controller of this.pendingConnects.values()) controller.abort();
    await Promise.all([...this.connections.keys()].map((id) => this.killConnection(id)));
    await Promise.allSettled([...this.turnDrives.values()]);
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
