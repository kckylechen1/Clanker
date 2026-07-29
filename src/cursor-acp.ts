#!/usr/bin/env node
/**
 * Cursor ACP sidecar — projects `cursor-agent --print --output-format
 * stream-json` onto the ACP surface Clanker's LaneConnection speaks.
 *
 * Same shape as gemini-acp.ts (a non-ACP CLI wearing an ACP face), with one
 * substantive difference: agy is an opaque `--print` child whose entire output
 * arrives at once, while cursor-agent emits a newline-delimited JSON event
 * stream. So this file is a real projector, and every rule it applies to those
 * events was measured against the installed binary (cursor-agent
 * 2026.07.23-e383d2b, 2026-07-28) rather than inferred from documentation. The
 * measurements are quoted inline where they are load-bearing.
 *
 * The process-governance shape (undetached child, exit-vs-close settle, the
 * exitCode/signalCode double gate) is inherited verbatim from gemini-acp.ts
 * AFTER PR #40's cold review fixed it there. Those comments explain the
 * reasoning at the original site; the short version is repeated at each gate so
 * a reader here does not have to go find it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent as createAgent,
  ndJsonStream,
  type ContentBlock,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolKind,
  type Usage,
} from "@agentclientprotocol/sdk";
import { laneSessionMeta } from "./lane-session.js";

const REVIEW_ROLE_PREFIX = [
  "You are Clanker: Cursor, a read-only review and reconnaissance lane.",
  "Read code, run no destructive commands, and modify nothing in the workspace.",
  "Return concise conclusions with file:line evidence, the things you could not verify, and the recommended next lane.",
].join(" ");

const WRITE_ROLE_PREFIX = [
  "You are Clanker: Cursor, a write-capable implementation lane running inside a managed git worktree.",
  "Confine every change to this worktree, commit periodically so a deadline kill still leaves reviewable work,",
  "and never push, open a pull request, or touch another checkout.",
  "Return the changed files, the verification you actually ran, and whatever remains unproven.",
].join(" ");

/**
 * The model this lane runs when nothing overrides it.
 *
 * Load-bearing, not cosmetic: cursor-agent's own default is NOT stable. Two
 * back-to-back probes with no `--model` reported `Cursor Grok 4.5` and
 * `Cursor Grok 4.5 High Fast` in their init events, so a dispatch that omits
 * the flag cannot say what it ran on. backends.ts always sets
 * CLANKER_CURSOR_MODEL on the real dispatch path (so this fallback only fires
 * when the sidecar is run standalone); the two must stay in sync — same
 * shadowing hazard #13 documents for gemini.
 */
const DEFAULT_CURSOR_MODEL = "composer-2.5";

/**
 * Execution mode, which is also the read/write boundary.
 *
 * `ask` and `plan` are cursor-agent's own read-only modes; `write` is the
 * write-capable shape. Anything unset or unrecognized falls back to `ask` — the
 * most conservative of the three, so a misconfigured env can only ever make the
 * lane more restrictive than intended.
 */
type CursorMode = "ask" | "plan" | "write";

function activeMode(): CursorMode {
  const raw = process.env.CLANKER_CURSOR_MODE?.trim();
  return raw === "write" || raw === "plan" ? raw : "ask";
}

function rolePrefix(mode: CursorMode): string {
  return mode === "write" ? WRITE_ROLE_PREFIX : REVIEW_ROLE_PREFIX;
}

function activeModel(): string {
  return process.env.CLANKER_CURSOR_MODEL?.trim() || DEFAULT_CURSOR_MODEL;
}

/**
 * The backend conversation this turn continues, if any (#43).
 *
 * Set by manager.ts's resume path from the id this lane itself reported on an
 * earlier turn (see `laneSessionMeta` below). Unset on a fresh dispatch — an
 * empty or whitespace value is the same as unset, never an empty `--resume`
 * argument, which cursor-agent would read as "resume the session named ''".
 */
function activeResumeRef(): string | undefined {
  return process.env.CLANKER_CURSOR_RESUME?.trim() || undefined;
}

/**
 * Default turn ceiling per mode, in ms.
 *
 * cursor-agent has NO `--print-timeout` of its own (verified against
 * `cursor-agent --help`), unlike agy — so unlike gemini-acp.ts, which delegates
 * the ceiling to the CLI, this sidecar has to enforce it itself (see the
 * watchdog in runCursor).
 *
 * The ceiling must sit just BELOW the manager's per-profile turn timeout, or
 * the manager kills the run first and the timeout is reported as a generic
 * infrastructure failure instead of "the task ran long" (the same ordering
 * gemini's 10m sidecar / 11m profile pair exists to preserve). The profiles are
 * 15m for `cursor-review` and 45m for `cursor-write`, hence 10m for the
 * read-only modes and 40m for write. CLANKER_CURSOR_PRINT_TIMEOUT overrides
 * both.
 */
const DEFAULT_PRINT_TIMEOUT_MS: Record<CursorMode, number> = {
  ask: 600_000,
  plan: 600_000,
  write: 2_400_000,
};

const DURATION = /^(\d+)(ms|s|m|h)?$/;
const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * `10m` / `600s` / `900000` → ms. A bare number is milliseconds.
 *
 * Fails LOUDLY rather than falling back to the default: an unparseable ceiling
 * that silently reverts is indistinguishable from one that was honored, and the
 * operator only finds out when a turn runs for the wrong length.
 */
function parseDurationMs(raw: string): number {
  const match = DURATION.exec(raw.trim());
  if (!match) {
    throw new Error(
      `Clanker: Cursor could not parse CLANKER_CURSOR_PRINT_TIMEOUT='${raw}'; expected e.g. '10m', '600s', '900000'`,
    );
  }
  const value = Number.parseInt(match[1], 10) * (DURATION_UNIT_MS[match[2] ?? "ms"]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Clanker: Cursor requires a positive CLANKER_CURSOR_PRINT_TIMEOUT; received '${raw}'`);
  }
  return value;
}

function printTimeoutMs(mode: CursorMode): number {
  const override = process.env.CLANKER_CURSOR_PRINT_TIMEOUT?.trim();
  return override ? parseDurationMs(override) : DEFAULT_PRINT_TIMEOUT_MS[mode];
}

/**
 * The argv for one turn — and the single place the read/write flag sets are
 * chosen, which is what makes them mutually exclusive.
 *
 * Measured: cursor-agent ACCEPTS `--mode ask --force` together without a word
 * of complaint (probe, 2026-07-28), so nothing downstream enforces this. One
 * switch, two disjoint branches: `--mode`/`--sandbox enabled` exist only on the
 * read-only path and `--force` only on the write path, so no combination of env
 * can produce both.
 *
 * The prompt is a trailing positional (that is cursor-agent's own interface)
 * and is always prefixed by the role copy, so it can never begin with a `-`
 * and be re-read as a flag.
 */
function cursorArgs(mode: CursorMode, model: string, prompt: string, resumeRef?: string): string[] {
  // A caller-supplied model is free-form (unknown ids pass through by design —
  // Cursor ships new ones faster than this registry can), but it lands in argv
  // as its own token. A value like `--force` would therefore be a flag, and on
  // a read-only dispatch the argv IS the whole read-only boundary (the CLI
  // accepts `--mode ask --force` silently — measured). Cold review
  // (codex-8b2b3) proved the invariant false; refuse the shape rather than
  // trust a downstream parser to reclassify it.
  refuseFlagShapedToken("model", model, "--model");
  const args = ["--print", "--output-format", "stream-json", "--stream-partial-output", "--model", model];
  if (resumeRef !== undefined) {
    // The SAME hazard, one field over (#43): a resume ref is also a standalone
    // argv token, and its value arrives from the backend's own event stream
    // rather than from anything this file controls. It gets the same refusal —
    // an argv-level boundary is only a boundary if every token that reaches it
    // is checked, not just the one whose bug was found first.
    refuseFlagShapedToken("resume ref", resumeRef, "--resume");
    args.push("--resume", resumeRef);
  }
  if (mode === "write") {
    // `--force` allows commands unless explicitly denied; `--trust` skips the
    // interactive workspace-trust prompt that would otherwise hang a headless
    // run. The write boundary is Clanker's managed worktree (the profile makes
    // one mandatory), not cursor's own sandbox, so `--sandbox` is left at the
    // user's configured setting rather than overridden here.
    args.push("--force", "--trust");
  } else {
    // Double read-only: cursor's own read-only execution mode AND its sandbox,
    // on top of the profile's welded read_only. Verified to run: `--mode ask
    // --sandbox enabled --trust` returned a normal result line.
    args.push("--mode", mode, "--sandbox", "enabled", "--trust");
  }
  args.push(`${rolePrefix(mode)}\n\nTask:\n${prompt}`);
  return args;
}

/**
 * Refuse an argv token that would be re-read as a flag.
 *
 * One helper, two call sites (`--model` and `--resume`), so the rule cannot
 * hold for one free-form token and quietly not for the next one added.
 */
function refuseFlagShapedToken(label: string, value: string, flag: string): void {
  if (!value.startsWith("-")) return;
  throw new Error(
    `Clanker: Cursor ${label} '${value}' starts with '-' and would reach cursor-agent as a flag, ` +
      `not as the value of ${flag}; refusing (the read-only argv is this lane's write boundary)`,
  );
}

/**
 * ACP `configOptions` is how run.ts learns what a lane is really running:
 * `observeConfigOptions` maps `category: "model"` onto `observed_model`.
 *
 * This lane reports it TWICE, and the second one is the interesting one:
 *
 *  1. At `session/new`, from argv — the only thing knowable before a child
 *     exists, and the same contract gemini-acp.ts provides.
 *  2. At the child's `system/init` event, from Cursor's OWN statement of what
 *     it is running, relayed as a `config_option_update`. That value is the
 *     vendor's display NAME (`Composer 2.5` for `composer-2.5`, `Cursor Grok
 *     4.5 High Fast` for `cursor-grok-4.5-high-fast`), not the id we asked
 *     for, so a reader comparing `resolved_model` with `observed_model` should
 *     compare model FAMILY, not string equality. It is reported in the
 *     vendor's own spelling on purpose: normalizing it here would mean
 *     inventing an id mapping, and a fabricated agreement is exactly the
 *     failure this field exists to catch.
 */
function selectOption(id: string, name: string, category: "model", value: string): SessionConfigOption {
  return { id, name, category, type: "select", currentValue: value, options: [{ value, name: value }] };
}

function sessionConfigOptions(): SessionConfigOption[] {
  return [selectOption("model", "Model", "model", activeModel())];
}

type Session = { cwd: string; active?: ChildProcess; cancellationRequested: boolean };
const sessions = new Map<string, Session>();

class TurnCancelled extends Error {}

function textOf(blocks: ContentBlock[]): string {
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Clanker: Cursor requires a non-empty text prompt");
  return text;
}

/** One parsed stream-json line. Only the fields this file actually reads are named. */
interface CursorEvent {
  type?: string;
  subtype?: string;
  call_id?: string;
  session_id?: string;
  request_id?: string;
  timestamp_ms?: number;
  model?: string;
  permissionMode?: string;
  apiKeySource?: string;
  is_error?: boolean;
  duration_ms?: number;
  result?: string;
  text?: string;
  message?: { content?: { type?: string; text?: string }[] };
  tool_call?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

function contentText(event: CursorEvent): string {
  return (event.message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/**
 * Tool kinds, mapped ONLY from what has been observed on the wire.
 *
 * A write probe produced `tool_call.editToolCall`, so `edit` is a measured
 * mapping. Every other `<name>ToolCall` key is reported as ACP kind `other`
 * under the vendor's own name — legible, and not a guess about a schema nobody
 * here has seen. Grow this map from evidence, never from the shape of the key.
 */
const MEASURED_TOOL_KINDS: Record<string, ToolKind> = { editToolCall: "edit" };

function describeToolCall(toolCall: Record<string, unknown> | undefined): { kind: ToolKind; title: string } {
  const key = Object.keys(toolCall ?? {}).find((k) => k.endsWith("ToolCall"));
  if (!key) return { kind: "other", title: "tool call" };
  const name = key.slice(0, -"ToolCall".length);
  const args = (toolCall?.[key] as { args?: Record<string, unknown> } | undefined)?.args;
  const target = typeof args?.path === "string" ? args.path : undefined;
  return { kind: MEASURED_TOOL_KINDS[key] ?? "other", title: target ? `${name} ${target}` : name };
}

/**
 * Cursor's per-turn token counts, projected onto ACP's Usage.
 *
 * `totalTokens` is required by the protocol and cursor does not send one, so it
 * is the sum of the two counters cursor DOES send. The cache counters are
 * reported alongside rather than added: whether `inputTokens` already includes
 * them is not something the observed payload states, and adding them on a guess
 * would inflate every row.
 */
function projectUsage(usage: Record<string, unknown> | undefined): Usage | undefined {
  const num = (key: string): number | undefined => (typeof usage?.[key] === "number" ? (usage[key] as number) : undefined);
  const inputTokens = num("inputTokens");
  const outputTokens = num("outputTokens");
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const cachedReadTokens = num("cacheReadTokens");
  const cachedWriteTokens = num("cacheWriteTokens");
  return {
    totalTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
  };
}

interface TurnOutcome {
  /** Everything relayed as agent_message_chunk, in order — the turn's answer. */
  message: string;
  usage?: Usage;
}

/**
 * Projects one cursor-agent stream-json turn onto ACP updates.
 *
 * Stateful across the turn because the recap rule below needs to know what has
 * already been streamed.
 */
class TurnProjection {
  /** Concatenation of every agent_message_chunk relayed so far. */
  private streamed = "";
  private resultSeen = false;
  private resultText = "";
  private usage: Usage | undefined;
  private failure: string | undefined;
  /** First non-JSON stdout line, kept for the diagnostic of a turn that produces no result. */
  unparsed: string | undefined;

  constructor(private readonly emit: (update: SessionUpdate) => void) {}

  line(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let event: CursorEvent;
    try {
      event = JSON.parse(trimmed) as CursorEvent;
    } catch {
      this.unparsed ??= trimmed.slice(0, 2_000);
      return;
    }
    switch (event.type) {
      case "system":
        if (event.subtype === "init") this.init(event);
        break;
      case "thinking":
        // CP4: the reasoning stream is disk-only on the Clanker side. Relaying
        // it still matters — every update refreshes the run's last_event_age_ms,
        // which is what keeps a long, quiet turn from reading as a stall.
        if (event.subtype === "delta" && event.text) {
          this.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
        }
        break;
      case "assistant":
        // `timestamp_ms` present == a live delta; absent == the end-of-turn recap.
        this.assistant(contentText(event), event.timestamp_ms === undefined);
        break;
      case "tool_call":
        this.toolCall(event);
        break;
      case "result":
        this.result(event);
        break;
      default:
        // `user` (the echo of our own prompt) and anything this projector has
        // not measured: ignored rather than guessed at.
        break;
    }
  }

  private init(event: CursorEvent): void {
    if (typeof event.model === "string" && event.model) {
      this.emit({
        sessionUpdate: "config_option_update",
        configOptions: [selectOption("model", "Model", "model", event.model)],
      });
    }
    // The chat id goes out TWICE, in two different registers, and the
    // duplication is the point (#43):
    //
    //  - `clanker.cursor` is this vendor's own forensic block. It lands in the
    //    run's events.jsonl (run.ts writes every update raw before projecting
    //    it) and stays shaped like cursor's event, permission mode and key
    //    source included.
    //  - `clanker.lane_session` is the lane-NEUTRAL side channel run.ts reads
    //    into `laneSessionRef`, which is what a later `--resume` turn is spawned
    //    with. It carries the id and nothing else, so the machinery that
    //    consumes it never learns a cursor-shaped field name.
    //
    // Emitted from `system/init`, which is where cursor states the id, and
    // again from the result line below: a RESUMED turn is a fresh CLI
    // invocation, so whatever id it reports is the one the next resume must
    // carry — the freshest report wins rather than the first one.
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: {
        "clanker.cursor": {
          chat_id: event.session_id,
          reported_model: event.model,
          permission_mode: event.permissionMode,
          api_key_source: event.apiKeySource,
        },
        ...laneSessionMeta(event.session_id),
      },
    });
  }

  /**
   * Relay assistant text, dropping cursor's end-of-turn recap.
   *
   * Measured twice (a read-only and a write turn, 2026-07-28): with
   * `--stream-partial-output` cursor emits one `assistant` event per fragment,
   * each carrying `timestamp_ms`, and THEN one final `assistant` event with no
   * `timestamp_ms` repeating the whole message. Without the flag only that
   * final event is sent.
   *
   * run.ts CONCATENATES every agent_message_chunk into `final_message`, so
   * relaying both halves hands the caller the answer twice.
   *
   * The discriminator is STRUCTURAL — `timestamp_ms` present on every live
   * delta, absent on the end-of-turn recap — not content equality. Cold review
   * (codex-8b2b3) killed the content-equality form with a three-event stream
   * `"a"`, `"a"`, `"b"`: the second genuine delta equals everything streamed
   * so far, got deleted as a recap, and the result-line repair below could no
   * longer prefix-match to put it back — silent truncation of a real answer.
   * A repeated delta is indistinguishable from a recap BY CONTENT; only the
   * field the CLI actually varies can tell them apart.
   *
   * Content equality is GONE, not demoted — the second half of the guard
   * (`this.streamed !== ""`) is the empty-stream exception, not a content
   * check: without `--stream-partial-output` the only assistant event is
   * itself timestamp-less, and nothing has streamed yet, so it must be
   * relayed rather than swallowed as a recap of nothing. (Round-2 review
   * codex-9678d caught this paragraph still describing the deleted rule — a
   * stale comment in a load-bearing spot is how the next maintainer restores
   * the bug it documents.)
   */
  private assistant(text: string, isRecap: boolean): void {
    if (!text) return;
    if (isRecap && this.streamed !== "") return;
    this.streamed += text;
    this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  private toolCall(event: CursorEvent): void {
    const toolCallId = event.call_id ?? (event.tool_call?.toolCallId as string | undefined);
    if (!toolCallId) return;
    if (event.subtype === "started") {
      const { kind, title } = describeToolCall(event.tool_call);
      // Deliberately NO `locations`: touched files for this lane come from the
      // run's real git diff (manager.ts), and a location list built from a tool
      // schema this projector has only partially observed would resurrect the
      // false-positive class the per-kind filter in run.ts exists to kill.
      this.emit({ sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress" });
      return;
    }
    // Only `completed` has been observed; any other terminal subtype refreshes
    // the call without asserting a status this projector cannot vouch for.
    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId,
      // ACP has a real "failed" status and run.ts only escalates a tool event
      // into the digest when it sees exactly that (`status === "failed"`).
      // Mapping only `completed` left a failed tool call as a statusless
      // update — invisible to the poller watching for trouble (codex-8b2b3).
      // Anything else stays statusless: inventing a status for a subtype this
      // sidecar has not measured would be worse than saying nothing.
      ...(event.subtype === "completed"
        ? { status: "completed" as const }
        : event.subtype === "failed"
          ? { status: "failed" as const }
          : {}),
    });
  }

  private result(event: CursorEvent): void {
    this.resultSeen = true;
    this.resultText = typeof event.result === "string" ? event.result : "";
    this.usage = projectUsage(event.usage);
    if (event.is_error === true) {
      this.failure = `Clanker: Cursor reported a failed turn (subtype ${event.subtype ?? "unknown"}): ${
        this.resultText || "no detail on the result line"
      }`;
    }
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: {
        "clanker.cursor": {
          chat_id: event.session_id,
          request_id: event.request_id,
          duration_ms: event.duration_ms,
          subtype: event.subtype,
        },
        ...laneSessionMeta(event.session_id),
      },
    });
  }

  /**
   * Settle the turn's message against the authoritative `result` line.
   *
   *  - nothing streamed  → the result line IS the message (the no-partial shape,
   *    and any turn whose assistant events were all empty).
   *  - result extends what was streamed → relay only the tail, so nothing is
   *    lost to a stream that ended early.
   *  - otherwise → the stream already carried the answer (the measured case).
   *    Re-emitting the result here would duplicate it.
   */
  finish(): TurnOutcome {
    if (this.failure) throw new Error(this.failure);
    if (!this.resultSeen) {
      throw new Error(
        `Clanker: Cursor produced no result line${this.unparsed ? `; first unparsed stdout line: ${this.unparsed}` : ""}`,
      );
    }
    if (this.streamed === "") {
      if (this.resultText) {
        this.streamed = this.resultText;
        this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: this.resultText } });
      }
    } else if (this.resultText.startsWith(this.streamed) && this.resultText.length > this.streamed.length) {
      const tail = this.resultText.slice(this.streamed.length);
      this.streamed += tail;
      this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: tail } });
    }
    if (!this.streamed.trim()) throw new Error("Clanker: Cursor returned empty output");
    return { message: this.streamed, usage: this.usage };
  }
}

function runCursor(
  sessionId: string,
  session: Session,
  prompt: string,
  emit: (update: SessionUpdate) => void,
): Promise<TurnOutcome> {
  if (session.active) throw new Error(`Clanker: Cursor session '${sessionId}' already has an active turn`);
  session.cancellationRequested = false;
  const mode = activeMode();
  const model = activeModel();
  // Parsed BEFORE the spawn: a bad ceiling must fail the turn, not start a
  // child that then runs unbounded.
  const timeoutMs = printTimeoutMs(mode);
  const args = cursorArgs(mode, model, prompt, activeResumeRef());
  const command = process.env.CLANKER_CURSOR_AGENT_PATH || "cursor-agent";

  const childEnv = { ...process.env };
  // Cursor authenticates from its own login state (`apiKeySource: "login"` in
  // the observed init event). An ambient key or a redirected endpoint would
  // silently change WHO the turn runs as and WHERE it goes, so neither is
  // inherited — same rule gemini-acp.ts applies to GEMINI_API_KEY.
  delete childEnv.CURSOR_API_KEY;
  delete childEnv.CURSOR_API_ENDPOINT;

  const turnStartedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: session.cwd,
      env: childEnv,
      // NOT detached, deliberately — inherited from gemini-acp.ts's PR #40 cold
      // review. acp-client.ts spawns THIS sidecar detached, so the sidecar leads
      // the group every manager teardown signals; leaving cursor-agent
      // undetached puts it and its descendants in that same group, so one
      // kill(-sidecarPid) reaps the whole tree without this process having to
      // cooperate. Giving it a group of its own looked stronger and was weaker:
      // the manager's SIGKILL lands on the sidecar's group only, so a short
      // grace killed the one process that knew the child's pgid.
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.active = child;

    const projection = new TurnProjection(emit);
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    let projectionError: Error | undefined;

    const feed = (line: string): void => {
      if (projectionError) return;
      try {
        projection.line(line);
      } catch (error) {
        // A projector fault must not kill the sidecar from inside a stream
        // handler; it fails this turn and nothing else.
        projectionError = error instanceof Error ? error : new Error(String(error));
      }
    };

    // Only ever clear the slot this turn put there: a turn that settles on
    // `exit` can have its `close` arrive after the NEXT turn claimed the slot,
    // and clearing it then would strand that turn's child unreachable by
    // terminateChild.
    const releaseSlot = () => { if (session.active === child) session.active = undefined; };

    const watchdog = setTimeout(() => {
      timedOut = true;
      terminateChild(session);
    }, timeoutMs);
    watchdog.unref?.();

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        feed(line);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

    child.once("error", (error) => {
      clearTimeout(watchdog);
      releaseSlot();
      reject(new Error(`Clanker: Cursor failed to start cursor-agent: ${error.message}`));
    });

    // A turn whose OUTPUT IS DISCARDED settles here, on `exit`, not on `close`.
    //
    // `close` additionally waits for the stdio pipes, which cursor-agent's
    // helpers inherit; since the child shares this sidecar's group, terminate
    // reaches the child alone and a surviving helper can hold those pipes open
    // for an unbounded time. manager.ts's cancel() only waits CANCEL_GRACE_MS
    // for `cancelled` before force-killing and flagging forced_kill, so a
    // cancel that waits on pipes is recorded as a forced kill. The same
    // reasoning covers the print-timeout: its output is discarded too. Every
    // other outcome still settles on `close`, where stdout is complete.
    child.once("exit", () => {
      if (!session.cancellationRequested && !timedOut) return;
      clearTimeout(watchdog);
      releaseSlot();
      reject(settleDiscarded(session.cancellationRequested, timeoutMs, turnStartedAt));
    });

    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      releaseSlot();
      // Still reachable and still correct: a cancel or timeout that landed
      // between `exit` and `close` never saw the early settle above.
      if (session.cancellationRequested || timedOut) {
        reject(settleDiscarded(session.cancellationRequested, timeoutMs, turnStartedAt));
        return;
      }
      if (stdoutBuffer.trim()) feed(stdoutBuffer);
      const trimmedStderr = stderr.trim();
      if (projectionError) {
        reject(new Error(`Clanker: Cursor could not project the cursor-agent stream: ${projectionError.message}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `Clanker: Cursor cursor-agent failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${trimmedStderr || "no stderr"}`,
        ));
        return;
      }
      try {
        resolve(projection.finish());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(trimmedStderr ? `${message}: ${trimmedStderr}` : message));
      }
    });
  });
}

/**
 * The error for a turn whose output is thrown away.
 *
 * A print-timeout is a TASK-DURATION ceiling, not a backend crash, and the two
 * must not be conflated in the surfaced error — reading a print-timeout as "the
 * lane is dead" is a mis-diagnosis this project has already made once (#13).
 */
function settleDiscarded(cancelled: boolean, timeoutMs: number, startedAt: number): Error {
  if (cancelled) return new TurnCancelled("Clanker: Cursor turn cancelled");
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  return new Error(
    `Clanker: Cursor hit the print-timeout (limit ${timeoutMs}ms, elapsed ~${elapsedSeconds}s) — ` +
      `task exceeded the configured print-timeout ceiling, this is not a backend crash`,
  );
}

/**
 * Terminate this session's cursor-agent, escalating to SIGKILL if it does not go.
 *
 * Both gates test `exitCode !== null || signalCode !== null` — the same pair
 * acp-client.ts's signalWorkerGroup checks (src/acp-client.ts:85), for the same
 * measured reason: Node reports a SIGNAL-killed child as `exitCode === null`
 * with `signalCode` set, so an exitCode-only gate reads an already-killed,
 * already-reaped child as "still running" and signals a pid the OS may have
 * recycled. PR #40's cold review proved that with a live probe.
 *
 * The two gates are not redundant: the first keeps an already-dead turn from
 * arming a pointless escalation timer, the second keeps that timer from firing
 * at a child that died during the grace window.
 */
function terminateChild(session: Session): void {
  const child = session.active;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (session.active === child && child.exitCode === null && child.signalCode === null) signalChild(child, "SIGKILL");
  }, 1_000);
  timer.unref?.();
}

/**
 * Signal cursor-agent itself — its pid, never a process group.
 *
 * It runs in THIS sidecar's group (see the spawn in runCursor), so `-child.pid`
 * is not its group at all: at best ESRCH, at worst an unrelated group that
 * recycled the pid. The group that does cover it is this sidecar's own, and its
 * only correct signaller is the manager — sending it from in here would kill
 * this sidecar too, which is precisely what a cancel must not do.
 *
 * `child.kill` and not `process.kill(child.pid)`: Node drops the handle when it
 * reaps the child, so a kill on an already-reaped child is a no-op instead of a
 * raw syscall at a pid that may since have been recycled.
 */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(signal); } catch { /* already exited */ }
}

function terminateAll(signal: NodeJS.Signals): void {
  for (const session of sessions.values()) {
    session.cancellationRequested = true;
    terminateChild(session);
  }
  const timer = setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 1_100);
  timer.unref?.();
}

process.once("SIGINT", () => terminateAll("SIGINT"));
process.once("SIGTERM", () => terminateAll("SIGTERM"));

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
createAgent({ name: "clanker-cursor" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { promptCapabilities: {} },
    authMethods: [],
  }))
  .onRequest("authenticate", () => ({}))
  .onRequest("session/new", (ctx) => {
    const sessionId = `cursor-${crypto.randomUUID()}`;
    sessions.set(sessionId, { cwd: ctx.params.cwd, cancellationRequested: false });
    return { sessionId, configOptions: sessionConfigOptions() };
  })
  .onRequest("session/prompt", async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw RequestError.internalError(undefined, `unknown Clanker: Cursor session '${ctx.params.sessionId}'`);
    // Notifications are chained rather than fired in parallel: the client
    // concatenates agent_message_chunks into the turn's final message, so their
    // order is the answer's order.
    let queue: Promise<unknown> = Promise.resolve();
    const emit = (update: SessionUpdate): void => {
      queue = queue
        .then(() => ctx.client.notify("session/update", { sessionId: ctx.params.sessionId, update }))
        .catch(() => { /* the turn's own settle reports the failure */ });
    };
    let outcome: TurnOutcome;
    try {
      outcome = await runCursor(ctx.params.sessionId, session, textOf(ctx.params.prompt), emit);
    } catch (error) {
      await queue;
      if (error instanceof TurnCancelled) return { stopReason: "cancelled" };
      throw RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
    }
    await queue;
    return { stopReason: "end_turn", ...(outcome.usage ? { usage: outcome.usage } : {}) };
  })
  .onNotification("session/cancel", (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) return;
    session.cancellationRequested = true;
    terminateChild(session);
  })
  .connect(stream);
process.stdin.resume();
