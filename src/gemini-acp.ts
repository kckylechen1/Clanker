#!/usr/bin/env node
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent as createAgent,
  ndJsonStream,
  type ContentBlock,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const RECON_ROLE_PREFIX = [
  "You are Clanker: Gemini, a read-only reconnaissance lane.",
  "Research, grounded web search, and repository discovery only.",
  "Do not modify workspace files or run destructive commands.",
  "Return concise conclusions, source URLs or repository evidence, uncertainties, and the recommended next lane.",
].join(" ");

const RESEARCH_ROLE_PREFIX = [
  "You are Clanker: Gemini, a read-only online research lane.",
  "Grounded web research only: every conclusion must carry its source URL; mark anything you could not source as unverified.",
  "Do not modify workspace files or run destructive commands.",
  "Return concise conclusions with source URLs, uncertainties, and the recommended next lane.",
].join(" ");

/**
 * backends.ts sets CLANKER_GEMINI_ROLE from the dispatch profile id when it
 * builds the spawn spec, so `gemini-recon` and `gemini-research` share this
 * sidecar with distinct role copy. Anything unset or unrecognized falls back
 * to the recon copy — the lane's original, most conservative shape.
 */
function rolePrefix(): string {
  return process.env.CLANKER_GEMINI_ROLE?.trim() === "gemini-research" ? RESEARCH_ROLE_PREFIX : RECON_ROLE_PREFIX;
}

/** The default agy runs on when nothing overrides it. See backends.ts for the load-bearing copy. */
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash-high";

/**
 * The single source of truth for what this turn actually runs on. `runAgy`
 * builds argv from it and `session/new` reports it, so telemetry can never
 * disagree with the process that was spawned.
 */
function activeModel(): string {
  return process.env.CLANKER_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

function activeEffort(): string | undefined {
  return process.env.CLANKER_GEMINI_EFFORT?.trim() || undefined;
}

/**
 * ACP `configOptions` is how run.ts learns what a lane is really running:
 * `observeConfigOptions` maps `category: "model"` to `observed_model` and
 * `category: "thought_level"` to `observed_effort`. A lane that reports
 * nothing leaves both `null` — which is exactly how an opencode dispatch once
 * ran on a substituted model while its telemetry claimed the requested one and
 * nobody could tell. Gemini had that same blind spot: agy is spawned as an
 * opaque `--print` child, so if the sidecar stays silent there is no other
 * place the truth could come from.
 */
function sessionConfigOptions(): SessionConfigOption[] {
  const effort = activeEffort();
  // A one-value select: agy takes its model from argv, so there is nothing for
  // a caller to choose here — the option exists to *state* what this turn runs
  // on, which is the reading run.ts turns into `observed_model`.
  const asSelect = (id: string, name: string, category: "model" | "thought_level", value: string): SessionConfigOption => ({
    id,
    name,
    category,
    type: "select",
    currentValue: value,
    options: [{ value, name: value }],
  });
  const options = [asSelect("model", "Model", "model", activeModel())];
  if (effort) options.push(asSelect("thought_level", "Reasoning effort", "thought_level", effort));
  return options;
}

type Session = { cwd: string; active?: ChildProcess; cancellationRequested: boolean };
const sessions = new Map<string, Session>();

class TurnCancelled extends Error {}

function textOf(blocks: ContentBlock[]): string {
  const text = blocks.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) throw new Error("Clanker: Gemini requires a non-empty text prompt");
  return text;
}

function runAgy(sessionId: string, session: Session, prompt: string): Promise<string> {
  if (session.active) throw new Error(`Clanker: Gemini session '${sessionId}' already has an active turn`);
  session.cancellationRequested = false;
  const args = [
    "--mode", "plan",
    "--sandbox",
    // Same accessors session/new reports from: argv and telemetry must never be
    // two independent computations of "what model is this".
    "--model", activeModel(),
  ];
  const effort = activeEffort();
  if (effort) args.push("--effort", effort);
  // Read-only recon turns observed at 178s-338s in practice; a 3m ceiling
  // killed real work and the resulting failure was indistinguishable from a
  // genuine backend crash (see close handler below). 10m gives real recon
  // headroom while CLANKER_GEMINI_PRINT_TIMEOUT remains the escape hatch.
  const printTimeout = process.env.CLANKER_GEMINI_PRINT_TIMEOUT || "10m";
  args.push("--print-timeout", printTimeout, "--print", `${rolePrefix()}\n\nTask:\n${prompt}`);

  const agyPath = process.env.CLANKER_AGY_PATH || "agy";
  const invocation = workspaceReadOnlyInvocation(agyPath, args, session.cwd);
  const agyEnv = { ...process.env };
  delete agyEnv.GEMINI_API_KEY;
  delete agyEnv.GOOGLE_API_KEY;
  delete agyEnv.GOOGLE_APPLICATION_CREDENTIALS;

  const turnStartedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: session.cwd,
      env: agyEnv,
      // NOT detached, deliberately (PR #40 cold review, run codex-62e86).
      //
      // acp-client.ts spawns THIS sidecar detached, so the sidecar leads a
      // process group whose pgid is its own pid, and every manager teardown
      // signals `-sidecarPid`. Leaving agy undetached puts it in that same
      // group: one kill(-sidecarPid) covers the sidecar, agy, and every
      // descendant agy did not setsid away — atomically, in one syscall,
      // needing no cooperation from this process.
      //
      // Giving agy a group of its own (the shape this replaces) looked
      // stronger and was weaker. The manager's escalation to SIGKILL is
      // uncatchable and lands on the SIDECAR's group only, so whenever the
      // manager's grace elapsed before terminateChild's fixed 1s inner
      // escalation below, this process died first and agy's entire group was
      // orphaned with nothing left alive that knew its pgid.
      //
      // The price, paid knowingly: a session/cancel can no longer take down
      // agy's own helpers, because a group kill from in here would kill this
      // sidecar too. terminateChild signals agy's pid alone, so a helper agy
      // leaves behind lives until the manager's group kill — bounded by the
      // connection (manager.ts's cancel() closes it after CANCEL_GRACE_MS),
      // rather than orphaned past every process that knew its pgid.
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.active = child;
    let stdout = "";
    let stderr = "";
    // Only ever clear the slot this turn put there. A cancelled turn settles on
    // `exit` while its `close` can arrive far later (see below) — by then the
    // next turn may already own session.active, and clearing it would strand
    // that turn's child unreachable by terminateChild.
    const releaseSlot = () => { if (session.active === child) session.active = undefined; };
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { releaseSlot(); reject(new Error(`Clanker: Gemini failed to start agy: ${error.message}`)); });
    // A CANCELLED turn settles here, on `exit`, not on `close`.
    //
    // `close` additionally waits for the stdio pipes, and agy's helpers inherit
    // them. Now that agy shares this sidecar's group (see spawn above),
    // terminateChild reaches agy alone, so a helper it leaves behind holds
    // stdout open long past agy's death: measured on this machine, agy killed
    // at +1.9s and `close` not firing until +3.4s, when the orphan helper was
    // killed by hand — unbounded in general (a `sleep 45` helper holds it for
    // 45s). manager.ts's cancel() gives the turn CANCEL_GRACE_MS to report
    // `cancelled` before it force-kills the run and flags forced_kill, so a
    // cancel that waits on the pipes is a cancel that gets recorded as a forced
    // kill. Nothing is lost by settling early: a cancelled turn discards its
    // output. Every other outcome still settles on `close`, where the full
    // stdout is guaranteed to have been read.
    child.once("exit", () => {
      if (!session.cancellationRequested) return;
      releaseSlot();
      reject(new TurnCancelled("Clanker: Gemini turn cancelled"));
    });
    child.once("close", (code, signal) => {
      releaseSlot();
      // Still reachable, and still correct: a cancel that arrives between
      // `exit` and `close` never saw the early settle above.
      if (session.cancellationRequested) {
        reject(new TurnCancelled("Clanker: Gemini turn cancelled"));
        return;
      }
      const output = stdout.trim();
      if (code !== 0) {
        const trimmedStderr = stderr.trim();
        // agy exits nonzero with this exact phrase when ITS OWN
        // --print-timeout ceiling elapses — that is a task-duration ceiling,
        // not a genuine backend crash, and the two must not be conflated in
        // the surfaced error (a prior mis-diagnosis read a print-timeout as
        // "the lane is dead").
        if (/timeout waiting for response/i.test(trimmedStderr)) {
          const elapsedSeconds = Math.round((Date.now() - turnStartedAt) / 1000);
          reject(new Error(
            `Clanker: Gemini hit the print-timeout (limit ${printTimeout}, elapsed ~${elapsedSeconds}s) — ` +
            `task exceeded the configured print-timeout ceiling, this is not a backend crash: ${trimmedStderr}`,
          ));
        } else {
          reject(new Error(`Clanker: Gemini agy failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${trimmedStderr || "no stderr"}`));
        }
      } else if (!output) {
        reject(new Error(`Clanker: Gemini agy returned empty output${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      } else resolve(output);
    });
  });
}

function workspaceReadOnlyInvocation(command: string, args: string[], cwd: string): { command: string; args: string[] } {
  if (process.platform !== "darwin") {
    throw new Error("Clanker: Gemini currently requires macOS sandbox-exec for a fail-closed workspace read-only boundary");
  }
  try {
    fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
  } catch {
    throw new Error("Clanker: Gemini requires executable /usr/bin/sandbox-exec for a fail-closed workspace read-only boundary");
  }
  const deniedRoots = workspaceDeniedRoots(cwd)
    .map((root) => `(subpath ${JSON.stringify(root)})`)
    .join(" ");
  const profile = `(version 1) (allow default) (deny file-write* ${deniedRoots})`;
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, command, ...args] };
}

function workspaceDeniedRoots(cwd: string): string[] {
  const roots = new Set([fs.realpathSync(cwd)]);
  const topLevel = gitPath(cwd, "--show-toplevel");
  if (!topLevel) return [...roots];
  roots.add(topLevel);
  for (const worktree of gitWorktreePaths(cwd)) roots.add(worktree);
  for (const flag of ["--absolute-git-dir", "--git-common-dir"] as const) {
    const resolved = gitPath(cwd, flag);
    if (!resolved) throw new Error(`Clanker: Gemini could not resolve ${flag} for the inspected Git workspace`);
    roots.add(resolved);
  }
  return [...roots];
}

function gitWorktreePaths(cwd: string): string[] {
  let output: string;
  try {
    output = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Clanker: Gemini could not enumerate sibling Git worktrees for the read-only boundary");
  }
  const paths = output
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length))
    .map((worktree) => fs.realpathSync(worktree));
  if (paths.length === 0) {
    throw new Error("Clanker: Gemini received no worktree paths from Git for the read-only boundary");
  }
  return paths;
}

function gitPath(cwd: string, flag: "--show-toplevel" | "--absolute-git-dir" | "--git-common-dir"): string | undefined {
  let output: string;
  try {
    output = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", flag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  if (output.endsWith("\n")) output = output.slice(0, -1);
  if (!output || /[\0\r\n]/.test(output)) {
    throw new Error(`Clanker: Gemini received an unsafe ${flag} path from Git`);
  }
  return fs.realpathSync(output);
}

/**
 * Terminate this session's agy, escalating to SIGKILL if it does not go.
 *
 * Both gates test `exitCode !== null || signalCode !== null` — the same pair
 * acp-client.ts's signalWorkerGroup checks (src/acp-client.ts:81), for the same
 * measured reason. Node reports a SIGNAL-killed child as `exitCode === null`
 * with `signalCode` set, so an exitCode-only gate reads a child that has
 * already been killed and reaped as "still running". PR #40's cold review (run
 * codex-62e86) proved it with a live probe — `exitCode null signalCode SIGTERM`
 * on a child whose `close` was still pending behind a descendant — and caught
 * this file signalling reaped children through both gates.
 *
 * The two gates are not redundant: the first keeps an already-dead turn from
 * arming a pointless escalation timer, the second keeps that timer from firing
 * at a child that died during the grace window.
 */
function terminateChild(session: Session): void {
  const child = session.active;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalAgy(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (session.active === child && child.exitCode === null && child.signalCode === null) signalAgy(child, "SIGKILL");
  }, 1_000);
  timer.unref?.();
}

/**
 * Signal agy itself — its pid, never a process group.
 *
 * agy runs in THIS sidecar's process group (see the spawn in runAgy), so
 * `-agy.pid` is not agy's group at all: at best ESRCH, at worst an unrelated
 * group that recycled the pid — the wrong-group signal acp-client.ts:64-74
 * spells out. The group that does cover agy is this sidecar's own, and its only
 * correct signaller is the manager: sending it from in here would kill this
 * sidecar too, which is precisely what a cancel must not do.
 *
 * `child.kill` and not `process.kill(child.pid)`: Node drops the handle when it
 * reaps the child, so kill on an already-reaped child is a no-op instead of a
 * raw syscall at a pid that may since have been recycled.
 */
function signalAgy(child: ChildProcess, signal: NodeJS.Signals): void {
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
createAgent({ name: "clanker-gemini" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { promptCapabilities: {} },
    authMethods: [],
  }))
  .onRequest("authenticate", () => ({}))
  .onRequest("session/new", (ctx) => {
    const sessionId = `gemini-${crypto.randomUUID()}`;
    sessions.set(sessionId, { cwd: ctx.params.cwd, cancellationRequested: false });
    return { sessionId, configOptions: sessionConfigOptions() };
  })
  .onRequest("session/prompt", async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw RequestError.internalError(undefined, `unknown Clanker: Gemini session '${ctx.params.sessionId}'`);
    let output: string;
    try {
      output = await runAgy(ctx.params.sessionId, session, textOf(ctx.params.prompt));
    } catch (error) {
      if (error instanceof TurnCancelled) return { stopReason: "cancelled" };
      throw RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
    }
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) return;
    session.cancellationRequested = true;
    terminateChild(session);
  })
  .connect(stream);
process.stdin.resume();
