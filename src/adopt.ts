/**
 * Orphan adoption (#32, control layer).
 *
 * Visibility was recoverable from disk (foreign.ts); control was not, and the
 * honest answer was a refusal: `wait`/`cancel` need the process that holds the
 * worker's stdio. That refusal is right while that process EXISTS. It stops
 * being right the moment it dies, which is the whole failure this repo exists
 * to survive — the worker outlives its session, so a dead session leaves a live
 * worker holding a worktree, burning tokens, answerable to nobody.
 *
 * So control transfers on exactly one condition:
 *
 *   **the owning server is provably dead.**
 *
 * Not "unresponsive", not "probably gone", not "I would like to have it". Two
 * processes racing for one child's stdio is worse than an uncontrollable job,
 * and "I could not prove it is alive" is not proof of death — a missing
 * `server_pid` (a run that predates PR #40) fails CLOSED, back to the refusal.
 *
 * Once ownership does transfer, the second hazard is pid reuse. A pid on disk
 * names a number, not a process; the OS is free to hand that number to
 * something else the moment the worker is reaped, and `kill(-pid)` on a
 * recycled number signals a whole innocent process group. Hence
 * `worker_started_at` and `verifyWorkerIdentity`: a pid is signalable only
 * while its observed start time still matches the one recorded at spawn, and
 * that check is repeated between SIGTERM and SIGKILL because the grace window
 * is precisely when the worker dies and its number becomes reusable.
 *
 * Everything here fails closed: unreadable `ps`, unparsable date, unsupported
 * platform, missing pid — all mean "unverified", and unverified means NO
 * signal is sent. The cost of a false negative is an orphan that survives one
 * more cancel; the cost of a false positive is killing a stranger's process
 * tree.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RESULT_FILE, RESULT_FINAL_MESSAGE_HEADING } from "./run.js";

/** lstart prints whole seconds, and `worker_started_at` is stamped a beat after fork. */
export const IDENTITY_TOLERANCE_MS = 2_000;

/** How often the post-signal death watch re-probes the pid. */
const DEATH_POLL_MS = 50;

/** Settle window after SIGKILL before reporting whether the group actually went away. */
const KILL_SETTLE_MS = 1_000;

// ---- owner liveness ---------------------------------------------------------

export type OwnerLiveness = "alive" | "dead" | "unknown";

export interface OwnerProbe {
  state: OwnerLiveness;
  /** The pid that was probed, or null when the record names none. */
  pid: number | null;
  /** Why the probe concluded what it concluded — quoted verbatim in refusals. */
  detail: string;
}

/**
 * Is the server process that started this run still around?
 *
 * `kill(pid, 0)` delivers nothing and only asks "may I signal this?". Three
 * answers matter and only ONE of them unlocks adoption:
 *
 *  - success        → alive. Refuse.
 *  - EPERM          → alive, and not ours (the pid belongs to another user).
 *                     Still alive, so still refuse — EPERM is proof of
 *                     existence, not permission to take over.
 *  - ESRCH          → dead. The one case adoption is legal.
 *
 * Anything else (no pid recorded, a nonsense pid, an errno we do not model) is
 * `unknown`, which is treated exactly like `alive`: control does not move on a
 * guess.
 */
export function probeOwner(serverPid: number | null | undefined, self: number = process.pid): OwnerProbe {
  if (typeof serverPid !== "number" || !Number.isInteger(serverPid) || serverPid <= 0) {
    return {
      state: "unknown",
      pid: null,
      detail:
        "this run's telemetry names no server_pid (it predates PR #40), so whether its owner is still alive " +
        "cannot be established",
    };
  }
  // A run whose owner is THIS process, yet which is not in this process's run
  // map, is not an orphan — it is a bookkeeping hole (or a pid the OS recycled
  // onto us). Either way the one process that must never adopt this run is the
  // one that is supposed to own it.
  if (serverPid === self) {
    return { state: "alive", pid: serverPid, detail: `server_pid ${serverPid} is this very process` };
  }
  try {
    process.kill(serverPid, 0);
    return { state: "alive", pid: serverPid, detail: `server_pid ${serverPid} answers to kill(pid, 0)` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { state: "dead", pid: serverPid, detail: `server_pid ${serverPid} no longer exists (ESRCH)` };
    }
    if (code === "EPERM") {
      return {
        state: "alive",
        pid: serverPid,
        detail: `server_pid ${serverPid} exists but belongs to another user (EPERM)`,
      };
    }
    return {
      state: "unknown",
      pid: serverPid,
      detail: `probing server_pid ${serverPid} failed with ${code ?? "an unknown error"}`,
    };
  }
}

// ---- worker identity --------------------------------------------------------

export interface ProcessFacts {
  /** ms epoch of the process's start, parsed from `ps -o lstart=`. */
  startedAt: number;
  /** `ps -o comm=`: a full path on macOS, a 15-char-truncated basename on Linux. */
  comm: string;
}

export type ProcessProbe = { ok: true; facts: ProcessFacts } | { ok: false; reason: string };

/**
 * `ps -p <pid> -o lstart=,comm=` — the only two facts needed to tell "the
 * worker" from "whatever the OS gave this number to since".
 *
 * `LC_ALL=C` is load-bearing, not hygiene: with this machine's ambient
 * `LANG=en_SG.UTF-8`, macOS `ps` prints `Wed 29 Jul 09:31:09 2026` (day before
 * month) while under C it prints the canonical `Wed Jul 29 09:31:09 2026`.
 * The parser below accepts both orders anyway — a locale that reorders the
 * fields must not become an unverifiable worker, and an unverifiable worker is
 * one that never gets cancelled.
 *
 * PLATFORM ASSUMPTIONS. Verified on macOS (darwin 25.5). On Linux, GNU ps
 * prints lstart in the same ctime layout under LC_ALL=C, and `comm` is the
 * truncated basename from /proc/<pid>/comm — which is why comm is advisory
 * (see verifyWorkerIdentity) and only the timestamp is load-bearing. On win32
 * there is no ps and no process group to signal, so this returns "unsupported"
 * and the caller sends nothing at all. Every parse failure degrades the same
 * way: unverified, therefore no signal (fail closed).
 */
export function readProcessFacts(pid: number): ProcessProbe {
  if (process.platform === "win32") {
    return { ok: false, reason: "process identity cannot be verified on win32 (no ps, no process groups)" };
  }
  let result;
  try {
    result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: 5_000,
    });
  } catch (error) {
    return { ok: false, reason: `ps could not be run: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.error) return { ok: false, reason: `ps could not be run: ${result.error.message}` };
  if (result.status !== 0) {
    // ps exits non-zero when no process matches — the ordinary "already gone".
    return { ok: false, reason: `ps reports no process with pid ${pid} (exit ${result.status})` };
  }
  const line = (result.stdout ?? "").split("\n").find((l) => l.trim().length > 0);
  if (!line) return { ok: false, reason: `ps returned no row for pid ${pid}` };
  // Weekday, then either "Mon 29" or "29 Mon", then clock, then year. The
  // trailing remainder is comm, which may itself contain spaces (a macOS full
  // path), so it is taken as "everything after the date" rather than as a
  // whitespace-split token.
  const match = /^\s*(\w{3}\s+(?:\w{3}\s+\d{1,2}|\d{1,2}\s+\w{3})\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(\S.*)?$/.exec(line);
  if (!match) return { ok: false, reason: `ps start time is not in a format this build can parse: '${line.trim()}'` };
  const startedAt = Date.parse(match[1]);
  if (!Number.isFinite(startedAt)) {
    return { ok: false, reason: `ps start time '${match[1]}' did not parse as a date` };
  }
  return { ok: true, facts: { startedAt, comm: (match[2] ?? "").trim() } };
}

/**
 * Commands a lane's worker may legitimately be running under.
 *
 * Advisory only (see verifyWorkerIdentity): every node-hosted lane spawns
 * `node <sidecar>`, any lane may be wrapped in `tachi vault exec` when its
 * profile declares secrets (backends.ts wrapWithVaultExec), and Linux truncates
 * comm at 15 characters. A mismatch is a fact worth reporting, never a fact
 * worth refusing a cancel over.
 */
const LANE_COMMANDS: Record<string, readonly string[]> = {
  codex: ["node", "tachi", "codex", "codex-acp"],
  cursor: ["node", "tachi", "cursor-agent", "cursor"],
  gemini: ["node", "tachi", "agy", "gemini"],
  grok: ["grok", "tachi", "node"],
  opencode: ["opencode", "tachi", "node", "bun"],
};

export interface IdentityCheck {
  /** True only when the pid's observed start time still matches the recorded one. */
  verified: boolean;
  reason: string;
  /** Present when ps answered: the start time it reported, ms epoch. */
  observed_started_at?: number;
  /** observed − recorded, in ms. */
  skew_ms?: number;
  comm?: string;
  /** Advisory: did comm look like something this lane spawns? */
  comm_matches_lane?: boolean;
}

/**
 * Is the process answering to `pid` still the worker this run spawned?
 *
 * The timestamp is the whole guard and the ONLY thing `verified` depends on.
 * A recycled pid is a different process with a different start time, so a start
 * time inside ±2s of the recorded one is the strongest identity claim available
 * without a handle to the child.
 *
 * `comm` is reported and never enforced: the same lane legitimately appears as
 * `node`, as `tachi` (vault-wrapped spawn), or truncated by Linux, so refusing
 * on a comm mismatch would strand real orphans. It rides along in the result so
 * a surprising cancel can be read after the fact.
 */
export function verifyWorkerIdentity(
  pid: number,
  recordedStartedAt: number | null | undefined,
  lane: string | null,
  toleranceMs: number = IDENTITY_TOLERANCE_MS,
): IdentityCheck {
  if (typeof recordedStartedAt !== "number" || !Number.isFinite(recordedStartedAt)) {
    return {
      verified: false,
      reason:
        "no worker_started_at on record, so a pid-reuse check is impossible — refusing to signal a pid that " +
        "cannot be shown to still be the worker",
    };
  }
  const probe = readProcessFacts(pid);
  if (!probe.ok) return { verified: false, reason: probe.reason };
  const skew = probe.facts.startedAt - recordedStartedAt;
  const expected = LANE_COMMANDS[lane ?? ""] ?? [];
  const base = path.basename(probe.facts.comm);
  const commMatches = expected.length === 0 ? undefined : expected.some((c) => base === c || base.startsWith(c));
  const shared = {
    observed_started_at: probe.facts.startedAt,
    skew_ms: skew,
    comm: probe.facts.comm,
    ...(commMatches === undefined ? {} : { comm_matches_lane: commMatches }),
  };
  if (Math.abs(skew) > toleranceMs) {
    return {
      ...shared,
      verified: false,
      reason:
        `pid ${pid} started ${new Date(probe.facts.startedAt).toISOString()}, but this run recorded its worker ` +
        `starting ${new Date(recordedStartedAt).toISOString()} (${skew}ms apart, tolerance ±${toleranceMs}ms) — ` +
        "the pid has been recycled onto a different process and must not be signalled",
    };
  }
  return {
    ...shared,
    verified: true,
    reason:
      `pid ${pid} start time matches the recorded worker within ${Math.abs(skew)}ms` +
      (commMatches === false ? `, though its command '${probe.facts.comm}' is not one lane '${lane}' usually spawns` : ""),
  };
}

// ---- taking the worker down -------------------------------------------------

export interface KillOutcome {
  /** Did this adoption actually send a terminating signal? */
  killed: boolean;
  /** Did the identity check pass — i.e. was signalling this pid legal at all? */
  identity_verified: boolean;
  /** Is the pid gone now? False means something survived and the note says what. */
  worker_gone: boolean;
  /** Signals actually delivered, in order. */
  signals: string[];
  note: string;
  identity?: IdentityCheck;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForDeath(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(Math.min(DEATH_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return !alive(pid);
}

/**
 * Signal the worker's process GROUP, with the same fallback reasoning as
 * acp-client.ts's signalWorkerGroup: `-pid` reaches the grandchildren a lane
 * grows (codex-acp's `codex app-server`, opencode's helpers), and an ESRCH on
 * the group when the pid ITSELF is still alive means the worker never led a
 * group (a spawn shape predating `detached`) — in which case signalling the
 * bare pid loses the grandchildren but not the worker. Losing both is worse.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): { sent: string; groupWide: boolean } | { sent: null; reason: string } {
  try {
    process.kill(-pid, signal);
    return { sent: `${signal}→group ${pid}`, groupWide: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!alive(pid)) return { sent: null, reason: `group ${pid} was already gone (${code ?? "error"})` };
    try {
      process.kill(pid, signal);
      return { sent: `${signal}→pid ${pid} (not a group leader)`, groupWide: false };
    } catch (inner) {
      return { sent: null, reason: `neither group nor pid ${pid} could be signalled (${(inner as NodeJS.ErrnoException).code})` };
    }
  }
}

/**
 * Terminate an adopted worker: verify identity, TERM the group, wait out the
 * grace, RE-VERIFY, then KILL.
 *
 * The second verification is the point of the whole function. The grace window
 * is exactly when the worker dies, gets reaped, and its number becomes
 * available again; a SIGKILL sent on the strength of a check performed
 * `graceMs` ago is a SIGKILL sent to whatever holds the number NOW. So the
 * check is redone against the same recorded start time, and a pid that stopped
 * matching gets nothing — the run is archived instead.
 */
export async function killAdoptedWorker(opts: {
  workerPid: number | null | undefined;
  workerStartedAt: number | null | undefined;
  lane: string | null;
  graceMs: number;
}): Promise<KillOutcome> {
  const { workerPid, workerStartedAt, lane, graceMs } = opts;
  if (typeof workerPid !== "number" || !Number.isInteger(workerPid) || workerPid <= 0) {
    return {
      killed: false,
      identity_verified: false,
      worker_gone: true,
      signals: [],
      note: "no worker_pid on record — the dispatch died before it ever spawned a worker; nothing to signal",
    };
  }
  if (!alive(workerPid)) {
    return {
      killed: false,
      identity_verified: false,
      worker_gone: true,
      signals: [],
      note: `worker pid ${workerPid} is already gone; archiving the record only`,
    };
  }
  const identity = verifyWorkerIdentity(workerPid, workerStartedAt, lane);
  if (!identity.verified) {
    return {
      killed: false,
      identity_verified: false,
      // Something IS alive on that pid; it is just not provably our worker.
      worker_gone: false,
      signals: [],
      identity,
      note: `no signal sent: ${identity.reason}`,
    };
  }

  const signals: string[] = [];
  const term = signalGroup(workerPid, "SIGTERM");
  const bareOnly = term.sent !== null && !term.groupWide;
  if (term.sent) signals.push(term.sent);
  if (await waitForDeath(workerPid, graceMs)) {
    return {
      killed: signals.length > 0,
      identity_verified: true,
      worker_gone: true,
      signals,
      identity,
      note: signals.length
        ? `worker group ${workerPid} exited on SIGTERM` +
          (bareOnly ? " (bare pid — worker led no group, so descendants may survive)" : "")
        : `worker ${workerPid} vanished before any signal landed`,
    };
  }

  // Still alive after the grace: re-establish that this pid is STILL the
  // worker before escalating. This is the guard that keeps a SIGKILL off an
  // innocent process that inherited the number during the grace.
  const recheck = verifyWorkerIdentity(workerPid, workerStartedAt, lane);
  if (!recheck.verified) {
    return {
      killed: signals.length > 0,
      identity_verified: false,
      worker_gone: false,
      signals,
      identity: recheck,
      note:
        `SIGTERM was sent, but pid ${workerPid} no longer verifies as this run's worker ` +
        `(${recheck.reason}) — SIGKILL withheld`,
    };
  }
  const kill = signalGroup(workerPid, "SIGKILL");
  if (kill.sent) signals.push(kill.sent);
  const gone = await waitForDeath(workerPid, KILL_SETTLE_MS);
  return {
    killed: signals.length > 0,
    identity_verified: true,
    worker_gone: gone,
    signals,
    identity: recheck,
    note: gone
      ? `worker group ${workerPid} survived SIGTERM for ${graceMs}ms and was SIGKILLed`
      : `worker group ${workerPid} did not exit within ${KILL_SETTLE_MS}ms of SIGKILL — it may be stuck in the kernel`,
  };
}

// ---- terminal archival ------------------------------------------------------

/** Written into telemetry.terminal_reason so an adopted cancel is never mistaken for the owner's own. */
export const ADOPTED_TERMINAL_REASON = "cancelled-foreign";

export interface ArchiveResult {
  telemetry_written: boolean;
  result_stub_written: boolean;
  /** Non-empty when a write failed; archival is best-effort and says so rather than throwing. */
  problems: string[];
}

/**
 * Close the record of a run this process just killed.
 *
 * Without this, adoption is only half a fix: the worker is dead and
 * `telemetry.json` still says `terminal_at: null`, so foreign.ts's scan — the
 * board an orphan sweep reads — keeps reporting a corpse as in flight forever.
 * The one thing worse than an uncontrollable job on the board is a dead job
 * that cannot be gotten OFF the board.
 *
 * This is the only place a process writes to another process's run directory,
 * and it is legal for exactly one reason: the owner is provably dead, so there
 * is no concurrent writer left to race. Two rules keep it honest:
 *
 *  - An existing `terminal_at` is never overwritten. If the owner already
 *    recorded how this run ended, that record is the truth of what happened;
 *    adoption only fills a gap, it does not rewrite history.
 *  - The adopting pid goes in the `error` line. Anyone reading this record
 *    later must be able to see that a stranger closed it, and which one.
 */
export function archiveAdoptedRun(input: {
  runDir: string;
  id: string;
  adopterPid: number;
  ownerPid: number | null;
  workerPid: number | null;
  outcome: KillOutcome;
  now?: number;
}): ArchiveResult {
  const { runDir, id, adopterPid, ownerPid, workerPid, outcome } = input;
  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  const problems: string[] = [];
  const explanation =
    `run '${id}' was adopted and cancelled by Clanker server pid ${adopterPid} at ${nowIso}: its own server ` +
    `(pid ${ownerPid ?? "unknown"}) was gone, so this process took over. worker_pid ${workerPid ?? "none"}; ` +
    `identity_verified=${outcome.identity_verified}; signals=[${outcome.signals.join(", ") || "none"}]; ${outcome.note}`;

  let telemetryWritten = false;
  const telemetryPath = path.join(runDir, "telemetry.json");
  try {
    let record: Record<string, unknown> = {};
    try {
      record = JSON.parse(fs.readFileSync(telemetryPath, "utf8")) as Record<string, unknown>;
    } catch {
      // A record that cannot be read is still a record that must end up
      // terminal, or the scan keeps it in flight; rebuild the minimum.
      record = { id };
      problems.push("existing telemetry.json was unreadable; wrote a minimal terminal record over it");
    }
    if (!record.terminal_at) {
      record.terminal_at = nowIso;
      record.terminal_reason = ADOPTED_TERMINAL_REASON;
    }
    record.error = record.error ? `${String(record.error)}\n${explanation}` : explanation;
    const tmp = `${telemetryPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, telemetryPath);
    telemetryWritten = true;
  } catch (error) {
    problems.push(`telemetry archival failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The verdict file is written only when there is none: an adopted run that
  // already produced a real verdict keeps it. The stub exists so a reader who
  // follows `result_path` finds an explanation instead of a missing file.
  let resultStubWritten = false;
  const resultPath = path.join(runDir, RESULT_FILE);
  try {
    let size = 0;
    try { size = fs.statSync(resultPath).size; } catch { /* no file */ }
    if (size === 0) {
      const lines = [
        `# clanker run ${id}`,
        "",
        "- status: cancelled",
        `- terminal_reason: ${ADOPTED_TERMINAL_REASON}`,
        `- run_dir: ${runDir}`,
        "",
        "## adoption",
        "",
        explanation,
        "",
        RESULT_FINAL_MESSAGE_HEADING,
        "",
        "(no verdict: this run was cancelled by an adopting server process, which never held its event stream. " +
          "Nothing here was produced by the worker.)",
        "",
      ];
      const tmp = `${resultPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, lines.join("\n"));
      fs.renameSync(tmp, resultPath);
      resultStubWritten = true;
    }
  } catch (error) {
    problems.push(`result stub write failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { telemetry_written: telemetryWritten, result_stub_written: resultStubWritten, problems };
}
