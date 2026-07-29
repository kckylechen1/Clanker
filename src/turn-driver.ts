/**
 * TurnDriver — the per-turn engine lifted out of LaneManager: spawn/handshake,
 * the prompt loop, the capacity retry, the correction turn (live-session and
 * backend-resume shapes) and each turn's terminal transition.
 *
 * It is a pure EXTRACTION: every method here ran as a LaneManager method
 * before, and the split is drawn along state ownership, not along file size.
 *
 *   OWNED HERE — `turnDrives`, `pendingConnects`. Both are turn-scoped: nothing
 *   outside a drive ever creates an entry, and both are read from outside only
 *   to observe a turn in flight (cancel/reap/shutdown), which is what the
 *   public accessors at the bottom of this class are for.
 *
 *   OWNED BY THE MANAGER — `runs`, `connections`, `closing`, `warningsById`.
 *   A connection outlives the turn that opened it (the supervised correction
 *   window), `closing`/`runs` are whole-session lifecycle, and warnings are
 *   dispatch-scoped. The engine reaches them only through `TurnHost` below, so
 *   the manager keeps the tables private and stays the one place their
 *   lifecycle is decided.
 */
import { LaneConnection } from "./acp-client.js";
import { WRITE_DISCIPLINE_PREFIX } from "./constants.js";
import { classifyBackendFailure, classifyTurnFailure, isCapacityTransient } from "./failure-classifier.js";
import { grokFailureDetail } from "./grok-diagnostics.js";
import { laneCanResume, planResumeTurn } from "./resume.js";
import type { LaneRun } from "./run.js";
import type { LaneName, LaneRequestOptions, RunStatus, SpawnSpec } from "./types.js";
import { changedFiles, isGitWorkTree } from "./worktree.js";
import { createTimeout, dedupe, errMessage, stderrSuffix } from "./util.js";

/** Outcome of one prompt-turn attempt; callers decide terminal-fail vs retry. */
type TurnOutcome = { ok: true } | { ok: false; message: string };

/**
 * The narrow window the turn engine gets onto its manager — deliberately NOT
 * the manager itself, so that what the engine can reach is enumerable by
 * reading this interface instead of by grepping a 1,700-line class.
 *
 * The scalar members are configuration the manager fixes in its constructor
 * and never mutates; `shuttingDown` is a live getter because the whole point of
 * every read is to observe a flag that flips underneath a running turn.
 */
export interface TurnHost {
  /** Global per-turn ceiling (CLANKER_TURN_TIMEOUT_MS). */
  readonly turnTimeoutMs: number;
  /** Explicit constructor override; wins over a profile's declared ceiling. */
  readonly turnTimeoutOverrideMs: number | undefined;
  readonly handshakeTimeoutMs: number;
  readonly processTerminateGraceMs: number | undefined;
  readonly capacityRetryBackoffMs: number;
  /** Only quoted in the "session is gone" refusal, so a caller learns the window it missed. */
  readonly sessionTtlMs: number;
  /** Live read: shutdown flips this under an in-flight turn. */
  readonly shuttingDown: boolean;
  /** The injectable spawn-recipe resolver, called with the manager as receiver. */
  resolveSpec(lane: LaneName, opts: LaneRequestOptions, runDir: string): SpawnSpec;
  getRun(id: string): LaneRun | undefined;
  /** Never returns; tells the caller WHICH kind of absent this id is (#32). */
  throwUnknownRun(id: string): never;
  /** Is a close() already in flight for this id? */
  isClosing(id: string): boolean;
  getConnection(id: string): LaneConnection | undefined;
  setConnection(id: string, conn: LaneConnection): void;
  /** Identity-conditional delete: only drops the entry if it is still `expected`. */
  dropConnection(id: string, expected: LaneConnection): void;
  close(id: string): Promise<void>;
  computeTouched(run: LaneRun): Promise<void>;
  computeContractViolations(run: LaneRun): Promise<void>;
  getWarnings(id: string): string[] | undefined;
  setWarnings(id: string, warnings: string[]): void;
}

export class TurnDriver {
  private readonly turnDrives = new Map<string, Promise<void>>();
  private readonly pendingConnects = new Map<string, AbortController>();

  constructor(private readonly host: TurnHost) {}

  async driveNewSession(run: LaneRun, spec: SpawnSpec, prompt: string): Promise<void> {
    await this.attemptInitialTurn(run, spec, prompt, 1);
  }

  private async driveContinuation(run: LaneRun, conn: LaneConnection, prompt: string, correction: boolean): Promise<void> {
    const outcome = await this.runTurn(run, conn, prompt, correction);
    if (run.cancellationRequested) {
      await this.host.close(run.id);
      run.cancelTurn();
      return;
    }
    if (run.isTerminalTurn()) return;
    if (outcome.ok) return;
    // No capacity-retry here, unlike a fresh dispatch's first turn: the retry
    // path respawns the subprocess, which would destroy the very session this
    // continuation exists to reuse — and the worker would come back with no
    // memory of the work it is being corrected about.
    await this.host.computeTouched(run);
    await this.host.close(run.id);
    run.failTurn(
      outcome.message,
      classifyTurnFailure({ message: outcome.message, turnsCount: run.turnsCount, toolCalls: run.toolCalls() }) ??
        classifyBackendFailure(outcome.message),
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
    await this.host.computeTouched(run);
    await this.host.close(run.id);
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
   *
   * Also drives a backend-resume correction turn (#43), which is a fresh spawn
   * of the lane in every respect that matters here — hence `correction`, the
   * one thing that differs: it reaches `runTurn` so the turn is counted as a
   * correction rather than as another dispatch's first turn.
   */
  private async attemptInitialTurn(
    run: LaneRun,
    spec: SpawnSpec,
    prompt: string,
    attempt: number,
    correction = false,
  ): Promise<void> {
    if (run.cancellationRequested || this.host.shuttingDown) {
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
        handshakeTimeoutMs: this.host.handshakeTimeoutMs,
        terminateGraceMs: this.host.processTerminateGraceMs,
        signal: controller.signal,
        // #32: persist the worker's identity at spawn time, not after the
        // handshake — the durable record has to name a process that may still
        // be alive when this server is not.
        onSpawn: ({ pid, startedAt }) => run.noteWorkerSpawned(pid, startedAt),
      });
    } catch (e) {
      if (run.cancellationRequested || this.host.shuttingDown) {
        await this.abortDuringSetup(run);
        return;
      }
      const message = errMessage(e);
      if (attempt === 1 && isCapacityTransient(message)) {
        await this.retryAfterBackoff(run, message, attempt + 1);
        return this.attemptInitialTurn(run, spec, prompt, attempt + 1, correction);
      }
      await this.host.computeTouched(run);
      await this.host.close(run.id);
      // A connect failure is a real classifiable failure and used to be the one
      // terminal path that carried NO failure_class at all. It is also the only
      // path CLANKER-ENV-DRIFT (#37) can ever arrive on — a spawn that dies with
      // ENOENT never gets far enough to run a turn — so leaving it unclassified
      // would have made that tag unreachable code. classifyTurnFailure is not
      // consulted here on purpose: its CLANKER-INFRA-FAILURE describes a backend
      // that rejected the request SHAPE, which presupposes a backend that was
      // reached; nothing here ever got that far.
      run.failTurn(message, classifyBackendFailure(message));
      return;
    } finally {
      if (this.pendingConnects.get(run.id) === controller) this.pendingConnects.delete(run.id);
    }
    if (run.cancellationRequested || this.host.shuttingDown) {
      await this.abortDuringSetup(run, conn);
      return;
    }
    this.host.setConnection(run.id, conn);
    run.sessionId = conn.sessionId;
    run.observeConfigOptions(conn.session.newSessionResponse.configOptions);

    const outcome = await this.runTurn(run, conn, prompt, correction);
    if (run.cancellationRequested) {
      await this.host.close(run.id);
      run.cancelTurn();
      return;
    }
    if (run.isTerminalTurn()) return;
    if (outcome.ok) return;

    // classifyBackendFailure (CLANKER-BACKEND-BILLING / -AUTH) is equally
    // permanent as CLANKER-INFRA-FAILURE — an empty account balance or a
    // rejected credential does not self-heal on retry — so any assigned
    // failureClass (not just INFRA_FAILURE_TAG) blocks the capacity retry
    // below.
    const failureClass =
      classifyTurnFailure({
        message: outcome.message,
        turnsCount: run.turnsCount,
        toolCalls: run.toolCalls(),
      }) ?? classifyBackendFailure(outcome.message);
    if (attempt === 1 && failureClass === undefined && isCapacityTransient(outcome.message)) {
      // Kill the half-dead process/connection (NOT run.close() — that would
      // also reap the worktree, which the retry needs to reuse) so the retry
      // spawns a clean process against the backend.
      await this.killConnection(run.id);
      await this.retryAfterBackoff(run, outcome.message, attempt + 1);
      return this.attemptInitialTurn(run, spec, prompt, attempt + 1, correction);
    }
    await this.host.computeTouched(run);
    await this.host.close(run.id);
    run.failTurn(outcome.message, failureClass);
  }

  private async retryAfterBackoff(run: LaneRun, message: string, nextAttempt: number): Promise<void> {
    run.recordTransientRetry(message, this.host.capacityRetryBackoffMs, nextAttempt);
    const deadline = Date.now() + this.host.capacityRetryBackoffMs;
    while (!run.cancellationRequested && !this.host.shuttingDown) {
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
    const turnTimeoutMs = this.host.turnTimeoutOverrideMs ?? run.turnTimeoutMs ?? this.host.turnTimeoutMs;
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
          // Issue #9: Grok's ACP bridge swallows the real backend error
          // (e.g. HTTP 402 balance-exhausted) into a bare -32603 "Internal
          // error" that never reaches stderr — the real status_code/message
          // only lives in Grok's own unified.jsonl log. When this is the
          // grok lane, tail that log for the failing turn's window and
          // splice the result in before the (often empty, for exactly this
          // reason) stderr tail — it carries more signal.
          const grokDetail =
            run.lane === "grok" && run.turnStartedAtMs !== undefined
              ? grokFailureDetail(run.turnStartedAtMs)
              : null;
          const grokDetailSuffix = grokDetail ? `\n${grokDetail}` : "";
          // Prefer the concrete exit info (code/signal/stderr); the ACP stream
          // often closes a beat before the exit event, so wait briefly for it.
          const info =
            outcome.kind === "exit"
              ? outcome.info
              : await Promise.race([conn.exited, createTimeout(500).promise.then(() => null)]);
          if (info) {
            const { code, signal, stderr } = info;
            throw new Error(
              `lane process exited mid-turn (code=${code} signal=${signal})${grokDetailSuffix}${stderrSuffix(stderr)}`,
            );
          }
          // #37 B1: no exit info arrived within the 500ms grace above — the
          // stream closed but the process's own exit event is still pending.
          // The stderr tail was previously dropped on this specific branch
          // even though acp-client.ts had been accumulating it the whole
          // time; conn.stderr() reads the same live buffer the exit-info
          // branch above reads from `info.stderr`.
          throw new Error(
            `ACP connection closed mid-turn: ${outcome.kind === "closed" ? errMessage(outcome.err) : "process exited"}` +
              `${grokDetailSuffix}${stderrSuffix(conn.stderr())}`,
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
  async killConnection(runId: string): Promise<void> {
    const conn = this.host.getConnection(runId);
    if (conn) {
      try {
        await conn.closeAndWait();
      } catch (err) {
        console.error(
          `[clanker] subprocess shutdown failed for '${runId}': ${errMessage(err)}`,
        );
      } finally {
        this.host.dropConnection(runId, conn);
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
    if (!run.supervised || stopReason === "cancelled") {
      await this.host.close(run.id);
    } else if (run.worktreePath) {
      // A supervised success defers close() — see above — but doNotTouch
      // validation must NOT wait for it: this terminal transition is exactly
      // the one the supervising seat reads off `clanker_wait`/result.md to
      // decide whether to issue a correction turn. Without this call the first
      // (and possibly only, if the worker is never corrected) terminal state
      // reported zero violations regardless of what was actually touched.
      // computeContractViolations recomputes (never accumulates) on every
      // call, so this is safe to call again from closeRun() once the session
      // truly closes (after a correction round reaches its own terminal
      // state, or the idle-TTL reaper finally closes it).
      await this.host.computeContractViolations(run);
    }
    if (stopReason === "cancelled") {
      run.cancelTurn();
    } else {
      run.completeTurn();
    }
  }

  /**
   * Track an in-flight drive so cancel/reap/shutdown can see it, and untrack it
   * however it settles. Public because a fresh dispatch's drive is started by
   * the manager (`driveNewSession`) and must be tracked the same way.
   */
  trackDrive(id: string, drive: Promise<void>): void {
    this.turnDrives.set(id, drive);
    void drive.then(
      () => { if (this.turnDrives.get(id) === drive) this.turnDrives.delete(id); },
      () => { if (this.turnDrives.get(id) === drive) this.turnDrives.delete(id); },
    );
  }

  /**
   * Run another turn on a job that already came back — the correction ("严父")
   * flow, in whichever of its two shapes this run's lane supports.
   *
   * Both shapes are turn-by-turn supervision, NOT mid-flight steering: ACP has
   * no way to redirect a prompt already in progress, so a correction is a new
   * turn issued after the previous one came back.
   *
   *  1. LIVE SESSION (the original, supervised-only). The ACP session outlived
   *     its terminal turn and the worker still holds its context in memory, so
   *     the correction is one more prompt on that session. The window is
   *     bounded by the idle-TTL reaper, which closes a finished session after
   *     `sessionTtlMs` — miss it and the only honest answer is that the session
   *     is gone, not a silently respawned worker with no memory of what it was
   *     corrected about. The capability is checked against the REGISTRY ROW
   *     that minted the run (`run.supervised`), not against which tool the
   *     caller holds: holding `clanker_prompt` is necessary but not sufficient,
   *     so the narrow-tool property survives a seat file that drifts.
   *  2. BACKEND RESUME (#43, lanes in LANES_WITH_RESUME). The context lives on
   *     the lane's own side, keyed by the session ref it reported, so the
   *     correction is a fresh spawn carrying that ref — and may run a different
   *     `model` than the turn before it. Supervision does not gate this shape,
   *     because the property supervision protects is not the one at stake: a
   *     GLM write's danger is an unsupervised WRITE, which is already gated at
   *     dispatch and is not widened here (the respawn inherits the run's own
   *     readOnly and worktree, see resume.ts). What it does need is a ref and a
   *     directory that still exists; without either it refuses.
   *
   * The lane's shape is decided by the capability table, never by which one
   * happens to be reachable: a resume-capable lane always takes path 2, because
   * path 1 on a lane whose worker is a one-shot CLI would prompt a process that
   * has no memory of the previous turn at all.
   */
  async promptExisting(
    id: string,
    prompt: string,
    correction = false,
    model?: string,
  ): Promise<{ id: string; status: RunStatus }> {
    const run = this.host.getRun(id);
    if (!run) this.host.throwUnknownRun(id);
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
    if (this.host.shuttingDown) {
      throw new Error(`Clanker manager is shutting down; refusing a correction turn for '${id}'`);
    }
    if (this.host.isClosing(id)) {
      throw new Error(
        `session for '${id}' is closing right now — the correction window has already passed. ` +
          `The worker cannot be corrected mid-teardown; report the blocker instead of retrying.`,
      );
    }
    if (run.turnStatus === "running" || this.turnDrives.has(id)) {
      throw new Error(`a turn is already running for '${id}'; wait for it to reach a terminal state first`);
    }
    // Server-owned workspace-discipline prefix on every write-class turn, not
    // just the first one (a08f7a1 only covered the initial dispatch): a
    // correction turn is the same worker under the same write contract, so the
    // words it is held to must be the words it is handed on EVERY turn, not
    // just turn 1.
    const turnPrompt = run.readOnly ? prompt : `${WRITE_DISCIPLINE_PREFIX}\n\n${prompt}`;
    if (laneCanResume(run.lane)) return this.startResumeTurn(run, turnPrompt, correction, model);
    if (model !== undefined) {
      throw new Error(
        `run '${id}' is on lane '${run.lane}', whose correction turn continues a LIVE session — the model ` +
          `was fixed when that session was spawned and cannot be swapped mid-session. Only a lane that ` +
          `resumes from a backend session ref can hand the next turn to another model.`,
      );
    }
    if (!run.supervised) {
      throw new Error(
        `run '${id}' was not started from a supervised profile, so it takes no correction turn ` +
          `(only the supervised shape accepts one — see profiles.ts supervision)`,
      );
    }
    if (run.sessionClosed) throw new Error(`session for '${id}' is already closed`);
    const conn = this.host.getConnection(id);
    if (!conn) {
      throw new Error(
        `session for '${id}' is gone — a finished session is closed by the idle-TTL reaper after ` +
          `${this.host.sessionTtlMs}ms (CLANKER_SESSION_TTL_MS). The worker cannot be corrected; report the ` +
          `blocker instead of starting a fresh dispatch on your own.`,
      );
    }
    const drive = this.driveContinuation(run, conn, turnPrompt, correction);
    this.trackDrive(id, drive);
    return { id, status: run.turnStatus };
  }

  /**
   * The backend-resume correction turn (#43): plan it, build the respawn, and
   * drive it as this run's next turn.
   *
   * The plan is computed and the spec resolved BEFORE anything on the run is
   * touched, so a refusal (no ref, worktree already reclaimed, a lane gate
   * inside resolveSpec) leaves the run exactly as terminal as it was — the
   * caller gets an error and not a job that says "running" forever.
   *
   * The drive itself is `attemptInitialTurn`, unchanged: a resume turn IS a
   * fresh spawn of the lane, so connect/handshake/first-turn/capacity-retry are
   * the same code path a dispatch takes. Only the accounting differs, which is
   * the `correction` flag it now forwards to runTurn.
   */
  private startResumeTurn(
    run: LaneRun,
    turnPrompt: string,
    correction: boolean,
    model: string | undefined,
  ): { id: string; status: RunStatus } {
    const plan = planResumeTurn(run, model);
    const spec = this.host.resolveSpec(run.lane, plan.requestOpts, run.runDir);
    if (spec.warnings.length > 0) {
      this.host.setWarnings(run.id, dedupe([...(this.host.getWarnings(run.id) ?? []), ...spec.warnings]));
    }
    if (plan.model) run.adoptResumeModel(plan.model);
    run.reopenForResume();
    this.trackDrive(run.id, this.attemptInitialTurn(run, spec, turnPrompt, 1, correction));
    return { id: run.id, status: run.turnStatus };
  }

  // ---- observation windows for the manager --------------------------------

  /** The drive in flight for `id`, if any — awaited by cancel's abort path. */
  driveFor(id: string): Promise<void> | undefined {
    return this.turnDrives.get(id);
  }

  /** Is a turn being driven for `id`? The reaper skips those (#37 A2). */
  hasDrive(id: string): boolean {
    return this.turnDrives.has(id);
  }

  /** Wait for every tracked drive to settle, however it settles (shutdown). */
  // `Promise<void>`, not the allSettled array: shutdown discards the value and
  // always has. Widening the type would let a future caller depend on a result
  // this method never meant to publish (round-2 review codex-2b437) — the point
  // is "every drive has settled", not what they settled to.
  settleAllDrives(): Promise<void> {
    // NOT `async`: shutdown awaits this, and an async wrapper would push the
    // final close loop a microtask past where it ran pre-split — smallest when
    // there are no drives at all, which is exactly the common shutdown
    // (cold review codex-1c87b). Hands back the very promise the old inline
    // `await Promise.allSettled([...])` produced, rejections swallowed the same
    // way.
    // The cast, not `.then(() => undefined)`: a `.then` costs the very
    // microtask the round-1 fix removed (measured — 2 ticks becomes 3), and
    // the timing IS the equivalence this refactor is judged on. The type says
    // void because the value is not part of the contract; the returned promise
    // is the untouched allSettled, exactly what the pre-split call site awaited.
    return Promise.allSettled([...this.turnDrives.values()]) as unknown as Promise<void>;
  }

  /** The in-flight handshake for `id`, if this run is still connecting (cancel). */
  pendingConnect(id: string): AbortController | undefined {
    return this.pendingConnects.get(id);
  }

  /** Abort every in-flight handshake (shutdown). */
  abortPendingConnects(): void {
    for (const controller of this.pendingConnects.values()) controller.abort();
  }
}
