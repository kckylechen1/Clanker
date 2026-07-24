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
} from "@agentclientprotocol/sdk";

const ROLE_PREFIX = [
  "You are Clanker: Gemini, a read-only reconnaissance lane.",
  "Research, grounded web search, and repository discovery only.",
  "Do not modify workspace files or run destructive commands.",
  "Return concise conclusions, source URLs or repository evidence, uncertainties, and the recommended next lane.",
].join(" ");

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
    "--model", process.env.CLANKER_GEMINI_MODEL || "gemini-3.6-flash-medium",
  ];
  const effort = process.env.CLANKER_GEMINI_EFFORT?.trim();
  if (effort) args.push("--effort", effort);
  // Read-only recon turns observed at 178s-338s in practice; a 3m ceiling
  // killed real work and the resulting failure was indistinguishable from a
  // genuine backend crash (see close handler below). 10m gives real recon
  // headroom while CLANKER_GEMINI_PRINT_TIMEOUT remains the escape hatch.
  const printTimeout = process.env.CLANKER_GEMINI_PRINT_TIMEOUT || "10m";
  args.push("--print-timeout", printTimeout, "--print", `${ROLE_PREFIX}\n\nTask:\n${prompt}`);

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
      // A headless agent may launch terminal/search helpers of its own. Give
      // the turn a process group so cancellation tears down the whole tree
      // instead of orphaning a grandchild that keeps stdout/stderr open.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.active = child;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { session.active = undefined; reject(new Error(`Clanker: Gemini failed to start agy: ${error.message}`)); });
    child.once("close", (code, signal) => {
      session.active = undefined;
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

function terminateChild(session: Session): void {
  const child = session.active;
  if (!child || child.exitCode !== null) return;
  signalChildTree(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (session.active === child && child.exitCode === null) signalChildTree(child, "SIGKILL");
  }, 1_000);
  timer.unref?.();
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone; fall through to the direct PID.
    }
  }
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
    return { sessionId };
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
