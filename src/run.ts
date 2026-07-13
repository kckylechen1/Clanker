/**
 * LaneRun — in-memory state for one persistent lane session across turns.
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
  SessionUpdate,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import { DIGEST_CHAR_BUDGET, FINAL_MESSAGE_CHAR_BUDGET } from "./constants.js";
import type {
  LaneName,
  PlanEntrySnapshot,
  PlanState,
  RunStatus,
} from "./types.js";

export type SessionState = "working" | "idle" | "stalled" | "closed";

interface DigestEntry {
  seq: number;
  text: string;
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
  readonly cwd: string;
  readonly worktreeBranch?: string;
  readonly worktreePath?: string;
  readonly readOnly: boolean;
  readonly runDir: string;
  readonly createdAt = Date.now();

  turnStatus: RunStatus = "running";
  turnsCount = 0;
  sessionClosed = false;
  error?: string;
  /** Set alongside `error` when the failure was classified (see failure-classifier.ts). */
  failureClass?: string;
  sessionId?: string;
  worktreeRetained?: string;

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
    cwd: string;
    runDir: string;
    readOnly: boolean;
    worktreeBranch?: string;
    worktreePath?: string;
  }) {
    this.id = init.id;
    this.lane = init.lane;
    this.cwd = init.cwd;
    this.runDir = init.runDir;
    this.readOnly = init.readOnly;
    this.worktreeBranch = init.worktreeBranch;
    this.worktreePath = init.worktreePath;
  }

  // ---- lifecycle ----------------------------------------------------------

  beginTurn(prompt: string): void {
    this.turnsCount += 1;
    this.turnStatus = "running";
    this.currentTurnMessage = "";
    this.lastEmittedMsgLen = 0;
    this.idleSince = null;
    this.touch("turn_start");
    this.pushDigest(`▶ turn ${this.turnsCount}: ${truncate(prompt, 160)}`);
    this.writeEvent({ t: "turn_start", turn: this.turnsCount, prompt });
  }

  completeTurn(): void {
    this.flushMessageDigest();
    this.turnStatus = "done";
    this.lastFinalMessage = this.currentTurnMessage.trim();
    this.idleSince = Date.now();
    this.pushDigest(`✓ turn ${this.turnsCount} done (${this.toolCallCount} tools)`);
    this.writeEvent({ t: "turn_done", turn: this.turnsCount, stopReason: "end_turn" });
    this.touch("turn_done");
  }

  /**
   * @param failureClass optional classification tag (e.g. CLANKER-INFRA-FAILURE)
   *   from failure-classifier.ts, surfaced verbatim to wait/status callers.
   */
  failTurn(message: string, failureClass?: string): void {
    this.flushMessageDigest();
    this.turnStatus = "error";
    this.error = message;
    this.failureClass = failureClass;
    this.idleSince = Date.now();
    const tag = failureClass ? ` [${failureClass}]` : "";
    this.pushDigest(`✗ error: ${truncate(message, 200)}${tag}`);
    this.writeEvent({ t: "turn_error", turn: this.turnsCount, message, failureClass });
    this.touch("turn_error");
  }

  /**
   * Record a non-terminal capacity-transient retry (see failure-classifier.ts
   * isCapacityTransient). Does not touch turnStatus — the turn is still
   * "running" from a caller's perspective while the retry backoff is in
   * flight, so a concurrent clanker_wait keeps long-polling instead of
   * seeing a premature terminal state.
   */
  recordTransientRetry(message: string, backoffMs: number, attempt: number): void {
    this.pushDigest(
      `↻ transient backend failure, retrying in ${backoffMs}ms (attempt ${attempt}): ${truncate(message, 160)}`,
    );
    this.writeEvent({ t: "transient_retry", backoffMs, attempt, message });
    this.touch("transient_retry");
  }

  cancelTurn(): void {
    this.flushMessageDigest();
    this.turnStatus = "cancelled";
    this.idleSince = Date.now();
    this.pushDigest(`⊘ turn ${this.turnsCount} cancelled`);
    this.writeEvent({ t: "turn_cancelled", turn: this.turnsCount });
    this.touch("turn_cancelled");
  }

  markClosed(): void {
    this.sessionClosed = true;
    this.writeEvent({ t: "session_closed" });
    this.closeStreams();
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
          this.pushDigest(`⚠ tool failed: ${truncate(title, 100)}`);
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
    this.plan = { entries: snap, completed, inProgress, pending, total: snap.length, currentStep };
    this.pushDigest(`📋 ${this.planSummary()}`);
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

  finalMessage(): string {
    return truncate(this.lastFinalMessage, FINAL_MESSAGE_CHAR_BUDGET);
  }

  toolTouchedFiles(): string[] {
    return [...this.touchedFromTools, ...this.touchedFromWrites];
  }

  toolCalls(): number {
    return this.toolCallCount;
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
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  // ---- persistence --------------------------------------------------------

  private pushDigest(text: string): void {
    this.seq += 1;
    this.digestLog.push({ seq: this.seq, text });
    if (this.digestLog.length > 500) this.digestLog.splice(0, this.digestLog.length - 500);
  }

  private writeEvent(obj: unknown): void {
    if (!this.eventsStream) {
      fs.mkdirSync(this.runDir, { recursive: true });
      this.eventsStream = fs.createWriteStream(path.join(this.runDir, "events.jsonl"), { flags: "a" });
    }
    this.eventsStream.write(JSON.stringify({ ts: Date.now(), ...(obj as object) }) + "\n");
  }

  private logChunk(kind: "thought" | "message", text: string): void {
    if (!text) return;
    if (!this.chunksStream) {
      fs.mkdirSync(this.runDir, { recursive: true });
      this.chunksStream = fs.createWriteStream(path.join(this.runDir, "chunks.log"), { flags: "a" });
    }
    this.chunksStream.write(`[${new Date().toISOString()}] ${kind}: ${text}\n`);
  }

  closeStreams(): void {
    this.eventsStream?.end();
    this.chunksStream?.end();
    this.eventsStream = null;
    this.chunksStream = null;
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
