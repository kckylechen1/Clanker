/**
 * LaneManager — owns lane sessions across their whole lifecycle: spawn +
 * handshake, per-turn prompt loops, plan/status projection, long-poll (clanker_wait),
 * cancel, persistent-session reuse (clanker_prompt), worktree cleanup, and the
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
  CAPACITY_RETRY_BACKOFF_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  DEFAULT_WAIT_MS,
  HANDSHAKE_TIMEOUT_MS,
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
import { changedFiles, createWorktree, isGitWorkTree, removeIfClean } from "./worktree.js";

export interface DispatchParams extends LaneRequestOptions {
  lane: LaneName;
  prompt: string;
  cwd?: string;
  worktree?: string;
  /**
   * Persistent seat (see LaneRun.seat doc). Exempts this run from the
   * idle-TTL reaper's terminal close(); clanker_prompt on a dead-process
   * seat respawns + session/resumes instead of failing.
   */
  seat?: boolean;
}

export interface WaitResult {
  id: string;
  lane: LaneName;
  status: RunStatus;
  digest: string;
  plan_summary: string;
  last_event_age_ms: number;
  suspected_stall: boolean;
  warnings?: string[];
  // present when status is terminal
  final_message?: string;
  touched_files?: string[];
  plan_final?: RunFinal["plan_final"];
  worktree_retained?: string;
  error?: string;
  /** Present alongside `error` when classifyTurnFailure tagged it (e.g. CLANKER-INFRA-FAILURE). */
  failure_class?: string;
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
}

const DEFAULT_SESSION_TTL_MS = envInt("CLANKER_SESSION_TTL_MS", 600_000);

export class LaneManager {
  private readonly runs = new Map<string, LaneRun>();
  private readonly connections = new Map<string, LaneConnection>();
  private readonly resolveSpec: SpecResolver;
  private readonly stallThresholdMs: number;
  private readonly sessionTtlMs: number;
  private readonly turnTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly baseRepo: string;
  private readonly capacityRetryBackoffMs: number;
  private readonly warningsById = new Map<string, string[]>();
  /** CP6: at most one active clanker_wait per id (single-consumer contract). */
  private readonly activeWaits = new Set<string>();
  private reaperTimer: NodeJS.Timeout | null = null;
  private counter = 0;

  constructor(opts: LaneManagerOptions = {}) {
    this.resolveSpec = opts.resolveSpec ?? buildSpawnSpec;
    this.stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.baseRepo = opts.baseRepo ?? BASE_REPO;
    this.capacityRetryBackoffMs = opts.capacityRetryBackoffMs ?? CAPACITY_RETRY_BACKOFF_MS;
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
   */
  async dispatchStart(params: DispatchParams): Promise<{ id: string; warnings: string[] }> {
    if (!LANE_NAMES.includes(params.lane)) {
      throw new Error(`unknown lane '${params.lane}'; expected one of ${LANE_NAMES.join(", ")}`);
    }
    const readOnly = params.readOnly ?? false;

    // CP2: write dispatches are forced into an isolated worktree, never the
    // primary checkout. No env escape hatch.
    if (!readOnly && !params.worktree) {
      throw new Error(
        "write dispatch (read_only=false) must run in an isolated worktree: pass `worktree` (a branch name). Reads may run in-place.",
      );
    }
    if (!readOnly && params.cwd) {
      const resolved = path.resolve(params.cwd);
      const base = path.resolve(this.baseRepo);
      if (resolved === base || resolved.startsWith(base + path.sep)) {
        throw new Error(
          `write dispatch cwd '${resolved}' is inside the primary checkout '${base}'; writes must be isolated to a worktree`,
        );
      }
    }

    const id = `${params.lane}-${(++this.counter).toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    const runDir = path.join(RUNS_ROOT, id);
    fs.mkdirSync(runDir, { recursive: true });

    let cwd = params.cwd ?? this.baseRepo;
    let worktreePath: string | undefined;
    if (params.worktree) {
      worktreePath = await createWorktree(params.worktree, this.baseRepo);
      cwd = worktreePath;
    }

    const opts: LaneRequestOptions = {
      model: params.model,
      effort: params.effort,
      readOnly,
      sandbox: params.sandbox,
      agent: params.agent,
    };
    const spec = this.resolveSpec(params.lane, opts, runDir);
    this.warningsById.set(id, spec.warnings);

    const run = new LaneRun({
      id,
      lane: params.lane,
      cwd,
      runDir,
      readOnly,
      worktreeBranch: params.worktree,
      worktreePath,
      seat: params.seat,
      requestOpts: opts,
    });
    this.runs.set(id, run);

    void this.driveNewSession(run, spec, params.prompt);
    return { id, warnings: spec.warnings };
  }

  /**
   * Start a new turn on an existing, still-open session.
   *
   * A seat run can lose its live connection without being sessionClosed —
   * the idle-TTL reaper only kills a seat's subprocess (see reap()), keeping
   * the run around specifically so this path can respawn + session/resume
   * instead of failing. Non-seat runs are unaffected: their connection is
   * only ever missing after a full close() (which also flips sessionClosed),
   * so they still hit the "not found or already reaped" branch above.
   */
  async promptExisting(id: string, prompt: string): Promise<{ id: string }> {
    const run = this.runs.get(id);
    if (!run || run.sessionClosed) {
      throw new Error(`session '${id}' not found or already reaped; start a new dispatch`);
    }
    if (run.turnStatus === "running") {
      throw new Error(`session '${id}' already has a turn in progress`);
    }
    let conn = this.connections.get(id);
    if (!conn) {
      if (!run.seat || !run.sessionId) {
        throw new Error(`session '${id}' has no live connection`);
      }
      conn = await this.resumeConnection(run);
    }
    void this.runTurn(run, conn, prompt).then((outcome) => this.settleTurn(run, outcome));
    return { id };
  }

  /**
   * Respawn a seat's subprocess and reconnect to its known ACP session via
   * session/resume (see acp-client.ts resumeSession). Throws if the backend
   * doesn't support session/resume or the spawn/handshake otherwise fails —
   * that failure surfaces straight to the promptExisting caller, since a
   * failed resume attempt is a real, reportable error, not a silent fallback.
   */
  private async resumeConnection(run: LaneRun): Promise<LaneConnection> {
    const spec = this.resolveSpec(run.lane, run.requestOpts, run.runDir);
    const conn = await LaneConnection.connect({
      spec,
      cwd: run.cwd,
      readOnly: run.readOnly,
      onFileWritten: (p) => run.recordFileWritten(p),
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      resumeSessionId: run.sessionId,
    });
    this.connections.set(run.id, conn);
    run.sessionId = conn.sessionId;
    this.writeSeatFile(run);
    return conn;
  }

  /**
   * Persist seat metadata to <runDir>/seat.json. Never deleted by close() —
   * the file is the durable record a caller can use to know what to resume,
   * even past a terminal close (clanker_close / a genuine turn failure).
   * No-op for non-seat runs.
   */
  private writeSeatFile(run: LaneRun): void {
    if (!run.seat) return;
    const payload = {
      id: run.id,
      lane: run.lane,
      cwd: run.cwd,
      worktree: run.worktreePath,
      sessionId: run.sessionId,
      model: run.requestOpts.model,
      agent: run.requestOpts.agent,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(path.join(run.runDir, "seat.json"), JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error(`[clanker] failed to write seat.json for '${run.id}': ${errMessage(err)}`);
    }
  }

  /** Resolve a runTurn() outcome into terminal failTurn+close, when it failed. Never retries (only the fresh-dispatch path in attemptInitialTurn does). */
  private async settleTurn(run: LaneRun, outcome: TurnOutcome): Promise<void> {
    if (outcome.ok) return;
    const failureClass = classifyTurnFailure({
      message: outcome.message,
      turnsCount: run.turnsCount,
      toolCalls: run.toolCalls(),
    });
    run.failTurn(outcome.message, failureClass);
    await this.close(run.id);
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
   * noticed). Retry scope is intentionally limited to a fresh dispatch's
   * first turn — clanker_prompt (session continuation) never retries.
   */
  private async attemptInitialTurn(run: LaneRun, spec: SpawnSpec, prompt: string, attempt: number): Promise<void> {
    let conn: LaneConnection;
    try {
      conn = await LaneConnection.connect({
        spec,
        cwd: run.cwd,
        readOnly: run.readOnly,
        onFileWritten: (p) => run.recordFileWritten(p),
        handshakeTimeoutMs: this.handshakeTimeoutMs,
      });
    } catch (e) {
      const message = errMessage(e);
      if (attempt === 1 && isCapacityTransient(message)) {
        await this.retryAfterBackoff(run, message, attempt + 1);
        return this.attemptInitialTurn(run, spec, prompt, attempt + 1);
      }
      run.failTurn(message);
      return;
    }
    this.connections.set(run.id, conn);
    run.sessionId = conn.sessionId;
    this.writeSeatFile(run);

    const outcome = await this.runTurn(run, conn, prompt);
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
      this.killConnection(run.id);
      await this.retryAfterBackoff(run, outcome.message, attempt + 1);
      return this.attemptInitialTurn(run, spec, prompt, attempt + 1);
    }
    run.failTurn(outcome.message, failureClass);
    await this.close(run.id);
  }

  private async retryAfterBackoff(run: LaneRun, message: string, nextAttempt: number): Promise<void> {
    run.recordTransientRetry(message, this.capacityRetryBackoffMs, nextAttempt);
    await delay(this.capacityRetryBackoffMs);
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
  private async runTurn(run: LaneRun, conn: LaneConnection, prompt: string): Promise<TurnOutcome> {
    run.beginTurn(prompt);
    const promptPromise = conn.session.prompt(prompt);
    promptPromise.catch(() => {
      /* rejection surfaced via the race / awaited below */
    });
    const turnTimer = createTimeout(this.turnTimeoutMs);
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
            `turn exceeded CLANKER_TURN_TIMEOUT_MS (${this.turnTimeoutMs}ms) with no completion; killing the Clanker`,
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
          await this.finalizeTurn(run, outcome.m.stopReason);
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
  private killConnection(runId: string): void {
    const conn = this.connections.get(runId);
    if (conn) {
      conn.close();
      this.connections.delete(runId);
    }
  }

  private async finalizeTurn(run: LaneRun, stopReason: string): Promise<void> {
    // Compute git-detected changes for this turn's cwd (union with ACP signals).
    let gitTouched: string[] = [];
    try {
      if (await isGitWorkTree(run.cwd)) gitTouched = await changedFiles(run.cwd);
    } catch {
      /* non-fatal: fall back to ACP-derived signals only */
    }
    const touched = dedupe([...gitTouched, ...run.toolTouchedFiles()]);
    run.setFinalTouched(touched);
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

  /** Blocking convenience: start + loop wait until the first turn is terminal. */
  async dispatchBlocking(
    params: DispatchParams,
    onProgress?: (r: WaitResult) => void,
  ): Promise<WaitResult> {
    const { id } = await this.dispatchStart(params);
    for (;;) {
      const r = await this.wait(id, MAX_WAIT_MS);
      onProgress?.(r);
      if (r.status !== "running") return r;
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
    };
    const warnings = this.warningsById.get(run.id);
    if (warnings && warnings.length) result.warnings = warnings;
    if (run.isTerminalTurn()) {
      result.final_message = run.finalMessage();
      result.touched_files = run.finalTouched();
      result.plan_final = run.planState();
      if (run.error) result.error = annotatedError(run.error, run.failureClass);
      if (run.failureClass) result.failure_class = run.failureClass;
      if (run.worktreeRetained) result.worktree_retained = run.worktreeRetained;
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
      ...(run.worktreePath ? { worktree: run.worktreePath } : {}),
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
    const conn = this.connections.get(id);
    if (conn) await conn.cancel();
    return { id, status: run.turnStatus };
  }

  /** Close a session: dispose ACP session, kill subprocess, clean worktree. */
  async close(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.sessionClosed) return;
    const conn = this.connections.get(id);
    conn?.close();
    this.connections.delete(id);
    if (run.worktreePath && run.worktreeBranch) {
      try {
        const removed = await removeIfClean(run.worktreePath, this.baseRepo);
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
    run.markClosed();
  }

  /**
   * Reap idle sessions past TTL. Exposed for tests.
   *
   * Seat runs get a soft reap: only the subprocess is killed (process death),
   * never the session/worktree (session death) — `sessionClosed` stays false
   * so clanker_prompt can respawn + session/resume later (promptExisting).
   * Non-seat runs are unaffected: full close() as before.
   */
  async reap(): Promise<string[]> {
    const reaped: string[] = [];
    for (const run of [...this.runs.values()]) {
      if (run.sessionClosed) continue;
      if (run.turnStatus !== "running" && run.idleMs() > this.sessionTtlMs) {
        if (run.seat) {
          // Only soft-reap once: after the first pass connections.has(id) is
          // false, so subsequent reaper ticks skip a dead seat silently
          // instead of re-reporting it every tick.
          if (this.connections.has(run.id)) {
            this.killConnection(run.id);
            reaped.push(run.id);
          }
          continue;
        }
        await this.close(run.id);
        reaped.push(run.id);
      }
    }
    return reaped;
  }

  /** Tear down everything (server shutdown). */
  async shutdown(): Promise<void> {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = null;
    for (const id of [...this.connections.keys()]) {
      await this.close(id);
    }
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

/** Un-cancelable backoff delay, used by the capacity-transient retry path. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
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
