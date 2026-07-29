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
import type { LaneRun } from "./run.js";
import type { LaneName, LaneRequestOptions, SpawnSpec } from "./types.js";

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
  constructor(private readonly host: TurnHost) {}
}
