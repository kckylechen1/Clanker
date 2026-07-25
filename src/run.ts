/**
 * LaneRun — in-memory state for one Clanker job.
 *
 * Ingests ACP `session/update` events (spec §6): `plan` is the primary signal
 * projected into a checkbox-style status; tool_call/tool_call_update are only
 * counted; agent_thought/agent_message chunks are logged to disk and never
 * enter tool responses (except the accumulated final_message). Every raw event
 * is appended to events.jsonl.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  ContentBlock,
  PlanEntry,
  PromptResponse,
  SessionConfigOption,
  SessionUpdate,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import { DIGEST_CHAR_BUDGET, FINAL_MESSAGE_CHAR_BUDGET, resolveOcModel } from "./constants.js";
import { appendLedgerRow } from "./ledger.js";
import type {
  LaneName,
  LaneRequestOptions,
  PlanEntrySnapshot,
  PlanState,
  RunStatus,
  RunTelemetry,
  PromptUsageTelemetry,
  ContractViolation,
} from "./types.js";
import type { ClankerHost } from "./host.js";

export type SessionState = "working" | "idle" | "stalled" | "closed";

/**
 * Name of the terminal-judgment artifact written into every run directory.
 *
 * Before it existed, a run directory held only `events.jsonl` (raw event
 * stream), `chunks.log` (thought/message fragments) and `telemetry.json`:
 * nothing a human or a relay seat could be pointed at and told "read the
 * verdict here". The verdict was reachable only as the `final_message` field of
 * one `clanker_wait` response, i.e. only through a language model that had to
 * carry it in prose — and a model asked to reproduce prose verbatim produces
 * prose instead (2026-07-25: a relay fabricated an entire review, and a second
 * one, after a "verbatim" clause was added, still blended real verdict with
 * invented detail). Turning the deliverable into a FILE PATH is the structural
 * fix: the seat hands over a path, the dispatcher reads the bytes.
 */
export const RESULT_FILE = "result.md";

/** Marker that opens the verbatim final-message section of `result.md`. */
export const RESULT_FINAL_MESSAGE_HEADING = "## final_message";

/**
 * The two per-run forensic streams, named here rather than as literals at the
 * four write sites below, because `retention.ts` deletes exactly the members of
 * this list and nothing else. What a run directory is made of is one decision;
 * a sweep that learned the names separately from the writer is one rename away
 * from either missing a file forever or deleting the verdict.
 */
export const EVENTS_FILE = "events.jsonl";
export const CHUNKS_FILE = "chunks.log";
export const RUN_STREAM_FILES = [EVENTS_FILE, CHUNKS_FILE] as const;

interface DigestEntry {
  seq: number;
  text: string;
  /**
   * True for entries that count as a "significant event" for quiet-mode
   * long-poll (clanker_wait's debounce): plan/status change, tool error, or a
   * turn-boundary transition. False for high-frequency chatter (tool_call
   * start, file-location echoes, message-chunk fragments) — the exact noise
   * that made every grep/read wake a waiting poller early.
   */
  significant: boolean;
}

const EMPTY_PLAN: PlanState = {
  entries: [],
  completed: 0,
  inProgress: 0,
  pending: 0,
  total: 0,
  currentStep: null,
};

export class LaneRun {
  readonly id: string;
  readonly lane: LaneName;
  readonly host: ClankerHost;
  readonly cwd: string;
  readonly worktreeBranch?: string;
  readonly worktreePath?: string;
  /**
   * The repo the worktree was cut from (resolved from the dispatch cwd, #12).
   * Cleanup (`git worktree remove`) must run against THIS repo, not the host
   * baseRepo, or it silently no-ops on the wrong repo and leaks the worktree.
   */
  readonly targetRepo?: string;
  /**
   * Full SHA the worktree was cut from when the dispatcher supplied an
   * explicit `base` (verified server-side in manager.ts before the worktree
   * was created). Undefined when the repo's default base resolution ran;
   * surfaced in telemetry as `base_sha`.
   */
  readonly baseSha?: string;
  /**
   * Full SHA of the commit the worktree was cut from, captured at creation
   * time regardless of whether the caller named a base. This is the diff base
   * for `doNotTouch` terminal validation (worktree.ts changedFilesSince).
   */
  readonly worktreeBaseSha?: string;
  /**
   * Caller-declared paths the worker must not touch, validated server-side at
   * terminal time (manager.ts computeContractViolations) against the real
   * worktree diff. Undefined when the dispatcher declared none — in which
   * case NO validation runs and nothing is reported anywhere.
   */
  readonly doNotTouch?: readonly string[];
  /**
   * Violations found while the worktree still existed (closeRun runs before
   * the terminal status flip, and a clean tree may be removed there — so the
   * result is stored here for buildWaitResult / writeResultFileOnce to read
   * afterwards). Set at most once, only when doNotTouch was declared.
   */
  contractViolations?: ContractViolation[];
  readonly readOnly: boolean;
  readonly runDir: string;
  readonly createdAt = Date.now();
  readonly requestOpts: LaneRequestOptions;
  /**
   * The dispatch's original (first-turn) prompt — retained verbatim so the
   * native ledger writer (ledger.ts) can derive `prompt_head` at close()
   * time, when the LaneManager call site no longer has the prompt in scope.
   * Deliberately never overwritten by a later clanker_prompt continuation:
   * the ledger row describes the dispatch's lifetime, not its latest turn.
   */
  readonly initialPrompt: string;
  /**
   * Hard per-turn ceiling declared by this run's dispatch profile
   * (profiles.ts). Undefined for dispatches that named no profile — the manager
   * then falls back to the global CLANKER_TURN_TIMEOUT_MS.
   */
  readonly turnTimeoutMs?: number;
  /**
   * Whether this run's profile is the supervised shape. Only a supervised run
   * accepts a correction turn (manager.promptExisting): the capability is
   * checked against the registry row that minted the run, not against which
   * tool the caller happens to hold, so a seat cannot talk its way into
   * steering an unsupervised worker.
   */
  readonly supervised: boolean;

  turnStatus: RunStatus = "running";
  turnsCount = 0;
  sessionClosed = false;
  error?: string;
  /** Set alongside `error` when the failure was classified (see failure-classifier.ts). */
  failureClass?: string;
  sessionId?: string;
  worktreeRetained?: string;
  cancellationRequested = false;
  private terminalAt?: number;
  private startedAt?: number;
  /**
   * Wall-clock time the CURRENT turn began (set fresh on every beginTurn
   * call, unlike `startedAt` above which is job-level and set once via
   * `??=`). Exists so grok-diagnostics.ts's log tail (issue #9) can bound
   * its search to the failing turn's own window instead of the whole job's
   * lifetime.
   */
  private turnStartedAt?: number;
  private retries = 0;
  private corrections = 0;
  private forcedKill = false;
  private stopReason?: string;
  private promptUsage?: PromptUsageTelemetry;
  private sessionUsage?: RunTelemetry["session_usage"];
  private observedModel: string | null = null;
  private observedEffort: string | null = null;

  private plan: PlanState = EMPTY_PLAN;
  private finalTouchedFiles: string[] = [];
  private toolCallCount = 0;
  private toolCallTitles = new Map<string, string>();
  private touchedFromTools = new Set<string>();
  private touchedFromWrites = new Set<string>();
  private currentTurnMessage = "";
  private lastFinalMessage = "";
  private lastEventAt = Date.now();
  private idleSince: number | null = null;
  /** Cleared on every real event; see `suspectedStallEdge`. */
  private stallAcknowledged = false;

  private seq = 0;
  reportedSeq = 0;
  private digestLog: DigestEntry[] = [];
  private lastEmittedMsgLen = 0;

  private waiters: Array<() => void> = [];
  private eventsStream: fs.WriteStream | null = null;
  private chunksStream: fs.WriteStream | null = null;

  constructor(init: {
    id: string;
    lane: LaneName;
    host?: ClankerHost;
    cwd: string;
    runDir: string;
    readOnly: boolean;
    worktreeBranch?: string;
    worktreePath?: string;
    targetRepo?: string;
    /** Caller-named, server-verified cut commit (telemetry `base_sha`). */
    baseSha?: string;
    /** Cut commit captured at creation time (doNotTouch diff base). */
    worktreeBaseSha?: string;
    /** Caller-declared forbidden paths for terminal validation. */
    doNotTouch?: readonly string[];
    requestOpts?: LaneRequestOptions;
    initialPrompt?: string;
    /** Per-profile hard turn ceiling (profiles.ts); undefined falls back to the global default. */
    turnTimeoutMs?: number;
    /** True only for the supervised profile shape; gates correction turns. */
    supervised?: boolean;
  }) {
    this.id = init.id;
    this.lane = init.lane;
    this.host = init.host ?? "standalone";
    this.cwd = init.cwd;
    this.runDir = init.runDir;
    this.readOnly = init.readOnly;
    this.worktreeBranch = init.worktreeBranch;
    this.worktreePath = init.worktreePath;
    this.targetRepo = init.targetRepo;
    this.baseSha = init.baseSha;
    this.worktreeBaseSha = init.worktreeBaseSha;
    this.doNotTouch = init.doNotTouch;
    this.requestOpts = init.requestOpts ?? {};
    this.initialPrompt = init.initialPrompt ?? "";
    this.turnTimeoutMs = init.turnTimeoutMs;
    this.supervised = init.supervised ?? false;
  }

  // ---- lifecycle ----------------------------------------------------------

  beginTurn(prompt: string, correction = false): void {
    if (this.isTerminalTurn() && this.sessionClosed) return;
    this.startedAt ??= Date.now();
    this.turnStartedAt = Date.now();
    this.cancellationRequested = false;
    this.terminalAt = undefined;
    this.stopReason = undefined;
    this.promptUsage = undefined;
    this.forcedKill = false;
    this.error = undefined;
    this.failureClass = undefined;
    this.turnsCount += 1;
    if (correction) this.corrections += 1;
    this.turnStatus = "running";
    this.currentTurnMessage = "";
    this.lastEmittedMsgLen = 0;
    this.idleSince = null;
    this.touch("turn_start");
    this.pushDigest(`▶ turn ${this.turnsCount}: ${truncate(prompt, 160)}`, true);
    this.writeEvent({ t: "turn_start", turn: this.turnsCount, prompt });
    this.persistTelemetry();
  }

  /** Wall-clock start of the current turn (see `turnStartedAt` field doc). */
  get turnStartedAtMs(): number | undefined {
    return this.turnStartedAt;
  }

  completeTurn(): void {
    if (this.isTerminalTurn()) return;
    this.flushMessageDigest();
    this.turnStatus = "done";
    this.lastFinalMessage = this.currentTurnMessage.trim();
    this.idleSince = Date.now();
    this.pushDigest(`✓ turn ${this.turnsCount} done (${this.toolCallCount} tools)`, true);
    this.writeEvent({ t: "turn_done", turn: this.turnsCount, stopReason: "end_turn" });
    this.touch("turn_done");
    this.markTerminal("done");
    this.writeResultFileOnce();
    this.writeLedgerRowOnce();
  }

  /**
   * @param failureClass optional classification tag (e.g. CLANKER-INFRA-FAILURE)
   *   from failure-classifier.ts, surfaced verbatim to wait/status callers.
   */
  failTurn(message: string, failureClass?: string): void {
    if (this.isTerminalTurn()) return;
    this.flushMessageDigest();
    this.turnStatus = "error";
    this.error = message;
    this.failureClass = failureClass;
    this.idleSince = Date.now();
    const tag = failureClass ? ` [${failureClass}]` : "";
    this.pushDigest(`✗ error: ${truncate(message, 200)}${tag}`, true);
    this.writeEvent({ t: "turn_error", turn: this.turnsCount, message, failureClass });
    this.touch("turn_error");
    this.markTerminal("error");
    this.writeResultFileOnce();
    this.writeLedgerRowOnce();
  }

  /**
   * Record a non-terminal capacity-transient retry (see failure-classifier.ts
   * isCapacityTransient). Does not touch turnStatus — the turn is still
   * "running" from a caller's perspective while the retry backoff is in
   * flight, so a concurrent clanker_wait keeps long-polling instead of
   * seeing a premature terminal state.
   */
  recordTransientRetry(message: string, backoffMs: number, attempt: number): void {
    this.retries += 1;
    this.pushDigest(
      `↻ transient backend failure, retrying in ${backoffMs}ms (attempt ${attempt}): ${truncate(message, 160)}`,
    );
    this.writeEvent({ t: "transient_retry", backoffMs, attempt, message });
    this.touch("transient_retry");
  }

  cancelTurn(): void {
    if (this.isTerminalTurn()) return;
    this.flushMessageDigest();
    this.turnStatus = "cancelled";
    this.idleSince = Date.now();
    this.pushDigest(`⊘ turn ${this.turnsCount} cancelled`, true);
    this.writeEvent({ t: "turn_cancelled", turn: this.turnsCount });
    this.touch("turn_cancelled");
    this.markTerminal("cancelled");
    this.writeResultFileOnce();
    this.writeLedgerRowOnce();
  }

  async markClosed(): Promise<void> {
    if (this.sessionClosed) return;
    this.writeEvent({ t: "session_closed" });
    await this.closeStreamsAndWait();
    this.sessionClosed = true;
    this.touch("session_closed");
  }

  // ---- event ingestion ----------------------------------------------------

  onUpdate(update: SessionUpdate): void {
    this.writeEvent({ t: "update", update });
    switch (update.sessionUpdate) {
      case "plan":
        this.applyPlan(update.entries);
        break;
      case "plan_update": {
        const entries = (update as { entries?: PlanEntry[] }).entries;
        if (Array.isArray(entries)) this.applyPlan(entries);
        break;
      }
      case "tool_call": {
        this.toolCallCount += 1;
        this.toolCallTitles.set(update.toolCallId, update.title);
        this.collectLocations(update.locations);
        this.pushDigest(`🔧 ${truncate(update.title, 120)}`);
        break;
      }
      case "tool_call_update": {
        this.collectLocations(update.locations);
        if (update.status === "failed") {
          const title = this.toolCallTitles.get(update.toolCallId) ?? update.toolCallId;
          this.pushDigest(`⚠ tool failed: ${truncate(title, 100)}`, true);
        }
        break;
      }
      case "agent_message_chunk": {
        const text = blockText(update.content);
        this.currentTurnMessage += text;
        this.logChunk("message", text);
        this.maybeEmitMessageDigest();
        break;
      }
      case "agent_thought_chunk": {
        // CP4 invariant: the reasoning stream is disk-only. It must NEVER reach
        // the digest (unlike agent_message_chunk, which may) — no pushDigest here.
        this.logChunk("thought", blockText(update.content));
        break;
      }
      case "config_option_update":
        this.observeConfigOptions(update.configOptions);
        break;
      case "usage_update":
        this.sessionUsage = {
          used: update.used, size: update.size,
          ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
        };
        this.persistTelemetry();
        break;
      default:
        // user_message_chunk, available_commands_update, usage_update, etc. — ignored per §6.
        break;
    }
    this.touch("update");
  }

  private applyPlan(entries: PlanEntry[] | undefined): void {
    const snap: PlanEntrySnapshot[] = (entries ?? []).map((e) => ({
      content: e.content,
      status: e.status,
    }));
    const completed = snap.filter((e) => e.status === "completed").length;
    const inProgress = snap.filter((e) => e.status === "in_progress").length;
    const pending = snap.filter((e) => e.status === "pending").length;
    const currentStep = snap.find((e) => e.status === "in_progress")?.content ?? null;
    const next = { entries: snap, completed, inProgress, pending, total: snap.length, currentStep };
    if (JSON.stringify(next) === JSON.stringify(this.plan)) return;
    this.plan = next;
    this.pushDigest(`📋 ${this.planSummary()}`, true);
  }

  private collectLocations(locations: ToolCallLocation[] | null | undefined): void {
    for (const loc of locations ?? []) {
      if (loc.path) {
        this.touchedFromTools.add(loc.path);
        this.pushDigest(`✏ ${truncate(this.relToCwd(loc.path), 120)}`);
      }
    }
  }

  /** Record a file the agent wrote through the client fs capability. */
  recordFileWritten(absPath: string): void {
    this.touchedFromWrites.add(absPath);
    this.pushDigest(`✏ wrote ${truncate(this.relToCwd(absPath), 120)}`);
    this.touch("file_written");
  }

  private maybeEmitMessageDigest(): void {
    const grown = this.currentTurnMessage.length - this.lastEmittedMsgLen;
    if (grown >= 40 || this.currentTurnMessage.endsWith("\n")) {
      this.flushMessageDigest();
    }
  }

  /** Emit any not-yet-reported agent-message text as a digest fragment. */
  private flushMessageDigest(): void {
    const delta = this.currentTurnMessage.slice(this.lastEmittedMsgLen).trim();
    this.lastEmittedMsgLen = this.currentTurnMessage.length;
    if (delta) this.pushDigest(`💬 ${truncate(delta, 200)}`);
  }

  // ---- projections --------------------------------------------------------

  planSummary(): string {
    const p = this.plan;
    if (p.total === 0) return "no plan yet";
    const now = p.currentStep ? ` · now: ${truncate(p.currentStep, 80)}` : "";
    return `${p.completed}/${p.total} done, ${p.inProgress} in progress${now}`;
  }

  planState(): PlanState {
    return this.plan;
  }

  lastEventAgeMs(): number {
    return Date.now() - this.lastEventAt;
  }

  suspectedStall(stallThresholdMs: number): boolean {
    return this.turnStatus === "running" && this.lastEventAgeMs() > stallThresholdMs;
  }

  /**
   * Edge-triggered variant of `suspectedStall` for quiet-mode long-poll: true
   * only the first time it's observed stalled since the last real event —
   * subsequent calls while still silently stalled return false so a caller
   * polling in a loop blocks out its full timeout budget each time instead of
   * spinning (every call re-observing "still stalled" would otherwise make
   * clanker_wait return near-instantly forever, starving the event loop of
   * the real timers — e.g. the hard per-turn timeout — that need to run).
   */
  suspectedStallEdge(stallThresholdMs: number): boolean {
    if (!this.suspectedStall(stallThresholdMs)) return false;
    if (this.stallAcknowledged) return false;
    this.stallAcknowledged = true;
    return true;
  }

  sessionState(stallThresholdMs: number): SessionState {
    if (this.sessionClosed) return "closed";
    if (this.turnStatus === "running") {
      return this.suspectedStall(stallThresholdMs) ? "stalled" : "working";
    }
    return "idle";
  }

  idleMs(): number {
    if (this.idleSince !== null) return Date.now() - this.idleSince;
    return this.lastEventAgeMs();
  }

  isTerminalTurn(): boolean {
    return this.turnStatus !== "running";
  }

  hasUnreported(): boolean {
    return this.seq > this.reportedSeq;
  }

  /**
   * True if any digest entry since the last drain is `significant` (plan/status
   * change, tool error, or turn-boundary transition) — as opposed to the
   * high-frequency chatter (tool_call start, file-location echo, message-chunk
   * fragment) that `hasUnreported()` alone treats as wake-worthy. Used by
   * clanker_wait's quiet mode so a run that's merely grepping/reading doesn't
   * wake every long-poller on each tool call.
   */
  hasUnreportedSignificant(): boolean {
    for (let i = this.digestLog.length - 1; i >= 0; i--) {
      const d = this.digestLog[i];
      if (d.seq <= this.reportedSeq) return false;
      if (d.significant) return true;
    }
    return false;
  }

  finalMessage(): string {
    return truncate(this.lastFinalMessage, FINAL_MESSAGE_CHAR_BUDGET);
  }

  toolTouchedFiles(): string[] {
    return [...this.touchedFromTools, ...this.touchedFromWrites];
  }

  toolCalls(): number {
    return this.toolCallCount;
  }

  requestCancellation(): void {
    this.cancellationRequested = true;
    this.touch("cancellation_requested");
    this.persistTelemetry();
  }
  markForcedKill(): void { this.forcedKill = true; this.persistTelemetry(); }
  recordStop(response: PromptResponse): void {
    if (this.isTerminalTurn()) return;
    this.stopReason = response.stopReason;
    if (response.usage != null) {
      const usage = response.usage;
      this.promptUsage = {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.thoughtTokens !== undefined ? { thoughtTokens: usage.thoughtTokens } : {}),
        ...(usage.cachedReadTokens !== undefined ? { cachedReadTokens: usage.cachedReadTokens } : {}),
        ...(usage.cachedWriteTokens !== undefined ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
      };
    }
    this.persistTelemetry();
  }
  observeConfigOptions(options: SessionConfigOption[] | null | undefined): void {
    for (const option of options ?? []) {
      if (option.category === "model") this.observedModel = String(option.currentValue);
      if (option.category === "thought_level") this.observedEffort = String(option.currentValue);
    }
    this.persistTelemetry();
  }
  telemetry(): RunTelemetry {
    const resolved = this.lane === "opencode"
      ? (resolveOcModel(this.requestOpts.model) ?? null)
      : this.lane === "grok" ? (this.requestOpts.model ?? "grok-4.5") : (this.requestOpts.model ?? null);
    return {
      host: this.host, requested_lane: this.lane, actual_lane: this.lane,
      requested_model: this.requestOpts.model, resolved_model: resolved,
      observed_model: this.observedModel, requested_effort: this.requestOpts.effort,
      observed_effort: this.observedEffort, lane: this.lane, transport: "acp-stdio",
      backend: this.lane, read_only: this.readOnly, sandbox: this.requestOpts.sandbox,
      ...(this.baseSha !== undefined ? { base_sha: this.baseSha } : {}),
      ...(this.turnTimeoutMs !== undefined ? { turn_timeout_ms: this.turnTimeoutMs } : {}),
      created_at: new Date(this.createdAt).toISOString(),
      ...(this.startedAt ? { started_at: new Date(this.startedAt).toISOString() } : {}),
      ...(this.terminalAt ? { terminal_at: new Date(this.terminalAt).toISOString(), duration_ms: this.terminalAt - (this.startedAt ?? this.createdAt) } : {}),
      turns: this.turnsCount, retries: this.retries, corrections: this.corrections,
      continuation_turns: Math.max(0, this.turnsCount - 1),
      cancellation_requested: this.cancellationRequested, forced_kill: this.forcedKill,
      tool_calls: this.toolCallCount, stop_reason: this.stopReason,
      ...(this.terminalAt ? { terminal_reason: this.turnStatus } : {}),
      prompt_usage: this.promptUsage, session_usage: this.sessionUsage,
    };
  }
  private markTerminal(reason: string): void { this.terminalAt = Date.now(); this.stopReason ??= reason; this.persistTelemetry(); }

  /**
   * Native dispatch-ledger row: called exactly once from the tail of
   * completeTurn()/failTurn()/cancelTurn() — the true single choke point a
   * run's lifetime passes through exactly once, guarded by the very same
   * `isTerminalTurn()` check already at the top of all three (per-run state,
   * not a module-level set): whichever of the three fires first flips
   * `turnStatus` off "running", so any other terminal-transition call for
   * this run (including a later one of these same three methods, should that
   * ever happen) short-circuits before doing anything, this row included.
   *
   * Deliberately NOT wired from LaneManager's close()/closeRun(): this
   * refactor's one-shot job controller calls `close()` *before* the
   * corresponding completeTurn()/failTurn()/cancelTurn() at every one of its
   * call sites (worktree/session teardown first, status flip second — see
   * manager.ts), so at closeRun() time `run.turnStatus` is still "running"
   * and `run.error` is still unset. That ordering is exercised concretely by
   * manager-close-diagnostics.test.ts's direct `m.close(id)` calls on a still-
   * running turn: closeRun() runs (and, per its own `sessionClosed` dedup,
   * ends up being the ONLY invocation that ever executes) strictly before the
   * turn's own failTurn() call discovers the mid-turn exit and sets the real
   * error. Reading the terminal fields from here instead — after they're
   * genuinely final — avoids depending on manager.ts's close-vs-status-flip
   * ordering entirely. See ledger.ts for why this write exists at all
   * (MCP-direct dispatches bypass the harness PostToolUse hook).
   */
  /** Absolute path of this run's terminal-judgment artifact (see RESULT_FILE). */
  resultPath(): string {
    return path.join(this.runDir, RESULT_FILE);
  }

  /**
   * Size in bytes of an already-written `result.md`, or 0 when it is missing or
   * empty. Callers use it to answer the only question a relay seat can honestly
   * answer about the verdict: "is there a file to read?" — never "what does it
   * say?".
   */
  resultBytes(): number {
    try {
      return fs.statSync(this.resultPath()).size;
    } catch {
      return 0;
    }
  }

  /**
   * Write `<runDir>/result.md` exactly once, from the same three terminal tails
   * as writeLedgerRowOnce() and guarded by the same per-run `isTerminalTurn()`
   * check at the top of completeTurn()/failTurn()/cancelTurn(): whichever fires
   * first flips `turnStatus` off "running", so every later terminal transition
   * short-circuits before reaching here.
   *
   * The final message is written UNTRUNCATED, unlike `finalMessage()` (capped at
   * FINAL_MESSAGE_CHAR_BUDGET for the wire). That asymmetry is the point: the
   * budget exists to keep a tool response small, and a verdict clipped at 20k
   * characters is exactly the kind of loss the reader must not be handed
   * silently. The file is the lossless artifact; the wire field is the preview.
   *
   * Fail-silent by design, like the ledger row: a diagnostics artifact must
   * never fail or delay terminal handling of a real dispatch. Written via
   * tmp+rename so a reader never observes a half-written verdict.
   */
  private writeResultFileOnce(): void {
    const target = this.resultPath();
    const tmp = `${target}.${process.pid}.tmp`;
    const lines = [
      `# clanker run ${this.id}`,
      "",
      `- status: ${this.turnStatus}`,
      `- lane: ${this.lane}`,
      `- run_dir: ${this.runDir}`,
      `- cwd: ${this.cwd}`,
      ...(this.worktreeRetained ? [`- worktree_retained: ${this.worktreeRetained}`] : []),
      "",
    ];
    if (this.error) {
      lines.push("## error", "", this.error, "");
      if (this.failureClass) lines.push(`failure_class: ${this.failureClass}`, "");
    }
    // doNotTouch breaches are reported, never silently absorbed — and never a
    // status flip: the run's outcome stands, the contract violation is listed
    // alongside it with the concrete offending paths.
    if (this.contractViolations && this.contractViolations.length > 0) {
      lines.push("## contract_violations", "");
      for (const violation of this.contractViolations) {
        lines.push(`- pattern \`${violation.pattern}\`:`);
        for (const file of violation.files) lines.push(`  - ${file}`);
      }
      lines.push("");
    }
    // Last section, deliberately: a reader (or `tail`) that stops early still
    // ends on the verdict itself rather than on metadata.
    lines.push(RESULT_FINAL_MESSAGE_HEADING, "", this.lastFinalMessage, "");
    try {
      fs.mkdirSync(this.runDir, { recursive: true });
      fs.writeFileSync(tmp, lines.join("\n"));
      fs.renameSync(tmp, target);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
      console.error(
        `[clanker] result file write failed for run '${this.id}' at '${target}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * One ledger row per DISPATCH, not per terminal transition.
   *
   * "Once" used to be an emergent property rather than a rule: `completeTurn`
   * and `failTurn` both return early on an already-terminal run, so with a
   * strictly one-shot controller they could only fire once. A correction turn
   * (manager.promptExisting) breaks that arithmetic — it clears `terminalAt`
   * and reaches a second terminal transition — so a supervised run would have
   * appended two rows describing one dispatch, quietly double-counting every
   * GLM write in the ledger's stats. The invariant now belongs to a flag that
   * says so, instead of to a coincidence of control flow.
   *
   * Deliberately NOT symmetric with `writeResultFileOnce`, which has no such
   * flag and must not have one: the verdict file has to hold the LATEST turn's
   * result, or a corrected run would hand its reader the very output the
   * correction was issued to replace.
   */
  private ledgerRowWritten = false;

  private writeLedgerRowOnce(): void {
    if (this.ledgerRowWritten) return;
    this.ledgerRowWritten = true;
    appendLedgerRow({
      id: this.id,
      lane: this.lane,
      cwd: this.cwd,
      agentProfile: this.requestOpts.profile,
      model: this.telemetry().resolved_model ?? null,
      initialPrompt: this.initialPrompt,
      turnStatus: this.turnStatus,
      error: this.error,
    });
  }
  private persistTelemetry(): void {
    const target = path.join(this.runDir, "telemetry.json");
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.telemetry(), null, 2));
      fs.renameSync(tmp, target);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
      console.error(`[clanker] telemetry persistence failed for run '${this.id}' at '${target}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setFinalTouched(files: string[]): void {
    this.finalTouchedFiles = files;
  }

  finalTouched(): string[] {
    return this.finalTouchedFiles;
  }

  /** Drain digest fragments accumulated since the last wait, advancing cursor. */
  drainDigest(): string {
    const fresh = this.digestLog.filter((d) => d.seq > this.reportedSeq);
    this.reportedSeq = this.seq;
    if (fresh.length === 0) return "";
    let text = fresh.map((d) => d.text).join("\n");
    if (text.length > DIGEST_CHAR_BUDGET) {
      // Keep the most recent fragments (tail) when over budget.
      text = "…\n" + text.slice(text.length - DIGEST_CHAR_BUDGET);
    }
    return text;
  }

  // ---- long-poll signaling ------------------------------------------------

  /** Resolve after the next event/state change or after `ms`, whichever first. */
  waitForSignal(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.waiters.push(finish);
    });
  }

  private touch(_reason: string): void {
    this.lastEventAt = Date.now();
    this.stallAcknowledged = false;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  // ---- persistence --------------------------------------------------------

  private pushDigest(text: string, significant = false): void {
    this.seq += 1;
    this.digestLog.push({ seq: this.seq, text, significant });
    if (this.digestLog.length > 500) this.digestLog.splice(0, this.digestLog.length - 500);
  }

  /**
   * Shared append template for both forensic streams (#37 A6): once
   * `sessionClosed`, append synchronously (no stream to keep open past
   * teardown); otherwise lazily open a durable append stream and write
   * through it. `streamField` names which of the two per-instance
   * WriteStream slots (`eventsStream` / `chunksStream`) this call owns.
   */
  private appendToStream(file: string, streamField: "eventsStream" | "chunksStream", line: string): void {
    if (this.sessionClosed) {
      fs.mkdirSync(this.runDir, { recursive: true });
      fs.appendFileSync(path.join(this.runDir, file), line);
      return;
    }
    if (!this[streamField]) {
      fs.mkdirSync(this.runDir, { recursive: true });
      this[streamField] = fs.createWriteStream(path.join(this.runDir, file), { flags: "a" });
    }
    this[streamField]!.write(line);
  }

  private writeEvent(obj: unknown): void {
    const line = JSON.stringify({ ts: Date.now(), ...(obj as object) }) + "\n";
    this.appendToStream(EVENTS_FILE, "eventsStream", line);
  }

  private logChunk(kind: "thought" | "message", text: string): void {
    if (!text) return;
    const line = `[${new Date().toISOString()}] ${kind}: ${text}\n`;
    this.appendToStream(CHUNKS_FILE, "chunksStream", line);
  }

  closeStreams(): void {
    this.eventsStream?.end();
    this.chunksStream?.end();
    this.eventsStream = null;
    this.chunksStream = null;
  }

  private async closeStreamsAndWait(): Promise<void> {
    const eventsStream = this.eventsStream;
    const chunksStream = this.chunksStream;
    await Promise.all([
      this.finishStream(eventsStream, "events"),
      this.finishStream(chunksStream, "chunks"),
    ]);
    if (this.eventsStream === eventsStream) this.eventsStream = null;
    if (this.chunksStream === chunksStream) this.chunksStream = null;
  }

  private finishStream(stream: fs.WriteStream | null, artifact: string): Promise<void> {
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        stream.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        console.error(
          `[clanker] ${artifact} stream close failed for '${this.id}': ${error.message}`,
        );
        finish();
      };
      stream.once("error", onError);
      stream.end(finish);
    });
  }

  private relToCwd(p: string): string {
    try {
      const rel = path.relative(this.cwd, p);
      return rel && !rel.startsWith("..") ? rel : p;
    } catch {
      return p;
    }
  }
}

function blockText(block: ContentBlock): string {
  if (block && typeof block === "object" && "type" in block) {
    if (block.type === "text") return block.text;
    return `[${block.type}]`;
  }
  return "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}
