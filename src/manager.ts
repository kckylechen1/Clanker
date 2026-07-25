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
  DEFAULT_WAIT_MS,
  HANDSHAKE_TIMEOUT_MS,
  isGlmModel,
  MAX_WAIT_MS,
  RUNS_ROOT,
  TURN_TIMEOUT_MS,
} from "./constants.js";
import { buildSpawnSpec } from "./backends.js";
import {
  classifyTurnFailure,
  INFRA_FAILURE_ADVISORY,
  INFRA_FAILURE_TAG,
  isCapacityTransient,
} from "./failure-classifier.js";
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
  changedFiles,
  createWorktree,
  deriveWorktreePath,
  isGitWorkTree,
  removeIfClean,
  resolveTargetRepo,
} from "./worktree.js";

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
  lane: LaneName;
  state: "working" | "idle" | "stalled" | "closed";
  idle_ms: number;
  turns_count: number;
  plan_summary: string;
  suspected_stall: boolean;
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
    if (!LANE_NAMES.includes(params.lane)) {
      throw new Error(`unknown lane '${params.lane}'; expected one of ${LANE_NAMES.join(", ")}`);
    }
    const profile = params.profile ?? "worker";
    if (profile !== "worker" && profile !== "kimi-crew") throw new Error(`unsupported profile '${profile}'`);
    if (params.lane === "gemini" && profile !== "worker") throw new Error("Clanker: Gemini rejects profile");
    if (profile === "kimi-crew") {
      params = { ...params, lane: "opencode", model: "kimi", readOnly: false, profile };
    }
    const blockedReason = hostLaneBlockedReason(this.host, params.lane);
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
    const runDir = path.join(RUNS_ROOT, id);
    fs.mkdirSync(runDir, { recursive: true });

    let cwd = params.cwd ?? this.baseRepo;
    let worktreePath: string | undefined;
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

    const opts: LaneRequestOptions = {
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
    const spec = this.resolveSpec(params.lane, opts, runDir);
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
      requestOpts: opts,
      initialPrompt: params.prompt,
      turnTimeoutMs: minted.turnTimeoutMs,
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
      if (!run.cancellationRequested) run.requestCancellation();
      await this.computeTouched(run);
      await this.close(run.id);
      run.cancelTurn();
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
        if (!run.cancellationRequested) run.requestCancellation();
        await this.computeTouched(run);
        await this.close(run.id);
        run.cancelTurn();
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
      if (!run.cancellationRequested) run.requestCancellation();
      try {
        await conn.closeAndWait();
      } catch (err) {
        console.error(
          `[clanker] subprocess shutdown failed for '${run.id}': ${errMessage(err)}`,
        );
      }
      await this.computeTouched(run);
      await this.close(run.id);
      run.cancelTurn();
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
          throw new Error(
            `turn exceeded CLANKER_TURN_TIMEOUT_MS (${turnTimeoutMs}ms) with no completion; killing the Clanker`,
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
            throw new Error(
              `lane process exited mid-turn (code=${code} signal=${signal})${stderr.trim() ? `; stderr: ${stderr.trim().slice(-400)}` : ""}`,
            );
          }
          throw new Error(
            `ACP connection closed mid-turn: ${outcome.kind === "closed" ? errMessage(outcome.err) : "process exited"}`,
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
    await this.close(run.id);
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
    if (!run) throw new Error(`run '${id}' not found`);
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
    if (!run) throw new Error(`run '${id}' not found`);
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

  list(): LaneListEntry[] {
    const out: LaneListEntry[] = [];
    for (const run of this.runs.values()) {
      if (run.sessionClosed) continue;
      out.push({
        id: run.id,
        lane: run.lane,
        state: run.sessionState(this.stallThresholdMs),
        idle_ms: run.idleMs(),
        turns_count: run.turnsCount,
        plan_summary: run.planSummary(),
        suspected_stall: run.suspectedStall(this.stallThresholdMs),
      });
    }
    return out;
  }

  // ---- cancel / close -----------------------------------------------------

  async cancel(id: string): Promise<{ id: string; status: RunStatus }> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run '${id}' not found`);
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

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolve symlinks in a path that may not exist yet: realpath the deepest
 * ancestor that DOES exist, then re-append the not-yet-created tail. A bare
 * `path.resolve` leaves symlinks unresolved, so a WORKTREES_ROOT that is a
 * symlink pointing inside the target repo would pass a literal-string overlap
 * check while git still lands the worktree inside the checkout (#12 hardening).
 */
function realpathBestEffort(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // reached the root; nothing resolved
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Enforce the target-aware isolation invariant (#12): the worktree a write
 * dispatch runs in must be a distinct path from the target repo's primary
 * checkout — never equal to it, inside it, or containing it. Under normal
 * config (WORKTREES_ROOT under ~/.cache) this always holds; the guard exists to
 * reject a misconfiguration that would route writes back onto the checkout the
 * isolation is meant to protect. Both sides are realpath-resolved first so a
 * symlinked WORKTREES_ROOT cannot slip a worktree inside the repo undetected.
 * Exported for a direct unit test.
 */
export function assertWorktreeOutsideRepo(worktreePath: string, targetRepo: string): void {
  const wt = realpathBestEffort(worktreePath);
  const repo = realpathBestEffort(targetRepo);
  if (wt === repo || wt.startsWith(repo + path.sep) || repo.startsWith(wt + path.sep)) {
    throw new Error(
      `isolated worktree '${wt}' overlaps the target repo's primary checkout '${repo}'; ` +
        `refusing to run a write dispatch on a non-isolated path (set CLANKER_WORKTREES_ROOT ` +
        `outside the repo)`,
    );
  }
}

/** Append the human-readable infra-failure advisory to an error message when classified. */
function annotatedError(message: string, failureClass: string | undefined): string {
  if (failureClass === INFRA_FAILURE_TAG) {
    return `${message}\n\n[${INFRA_FAILURE_TAG}] ${INFRA_FAILURE_ADVISORY}`;
  }
  return message;
}

/** A cancelable timeout whose promise resolves after `ms`. */
function createTimeout(ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function clampWait(ms?: number): number {
  if (ms === undefined) return DEFAULT_WAIT_MS;
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_WAIT_MS;
  return Math.min(ms, MAX_WAIT_MS);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
