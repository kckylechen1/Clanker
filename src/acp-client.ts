/**
 * ACP client wrapper — spawns one lane CLI as an ACP agent subprocess, performs
 * the initialize / session/new handshake, and exposes a long-lived
 * `ActiveSession` plus cancel / close controls.
 *
 * Built on the official `@agentclientprotocol/sdk`. Its `ActiveSession`
 * (`prompt()` + `nextUpdate()` loop yielding `session_update` / `stop`) maps
 * 1:1 onto spec §6, so hand-rolling the JSON-RPC core is unnecessary.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ActiveSession,
  ClientContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { HANDSHAKE_TIMEOUT_MS, PROCESS_TERM_GRACE_MS } from "./constants.js";
import type { SpawnSpec } from "./types.js";

/** Minimal promise-with-resolvers helper (Node's Promise.withResolvers exists on 22+ but kept explicit). */
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (v: T | PromiseLike<T>) => void;
  reject!: (e: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Permission option shape we depend on (subset of ACP PermissionOption). */
export interface PermissionChoice {
  optionId: string;
  kind?: string;
}

/**
 * Decide a `session/request_permission` outcome.
 *
 * CP5 invariant: a read-only lane NEVER auto-approves. If the agent offers no
 * `reject*` option, we decline with `cancelled` rather than falling back to an
 * `allow*` option (the previous `options[0]` fallback could approve a write).
 */
export function choosePermissionOption(
  options: readonly PermissionChoice[],
  readOnly: boolean,
): RequestPermissionResponse {
  if (options.length === 0) return { outcome: { outcome: "cancelled" } };
  if (readOnly) {
    const reject = options.find((o) => (o.kind ?? "").startsWith("reject"));
    if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
    return { outcome: { outcome: "cancelled" } };
  }
  const allow = options.find((o) => (o.kind ?? "").startsWith("allow")) ?? options[0];
  return { outcome: { outcome: "selected", optionId: allow.optionId } };
}

export interface LaneConnectionOptions {
  spec: SpawnSpec;
  cwd: string;
  readOnly: boolean;
  /** Invoked when the agent routes a write through the client fs capability. */
  onFileWritten?: (absPath: string) => void;
  /** Handshake timeout override (ms). */
  handshakeTimeoutMs?: number;
  /** SIGTERM grace before SIGKILL (test override). */
  terminateGraceMs?: number;
  /** Cancels a subprocess that is still completing the ACP handshake. */
  signal?: AbortSignal;
  /**
   * When set, reconnect to this existing ACP session id via `session/resume`
   * instead of creating a fresh one via `session/new`. Used to respawn a
   * seat's subprocess after the idle-TTL reaper (or an out-of-band process
   * death) killed it, without losing the backend's own conversation state
   * (e.g. opencode's persisted session store) — see manager.ts
   * resumeConnection. Only meaningful for a lane whose agent advertises the
   * `session/resume` capability (verified: opencode); other lanes will
   * surface a JSON-RPC error from the agent, which propagates as a rejected
   * connect().
   */
  resumeSessionId?: string;
}

/**
 * A live ACP connection to one lane subprocess.
 *
 * The connection stays open across multiple prompt turns (G1c persistent
 * session). Call `close()` to dispose the session and kill the subprocess.
 */
export class LaneConnection {
  readonly session: ActiveSession;
  /** Resolves when the subprocess exits (drives the run to a terminal state). */
  readonly exited: Promise<ExitInfo>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ctx: ClientContext;
  private readonly shutdown: Deferred<void>;
  private readonly getStderr: () => string;
  private closed = false;
  private exitedProcess = false;
  private readonly terminateGraceMs: number;

  private constructor(
    session: ActiveSession,
    child: ChildProcessWithoutNullStreams,
    ctx: ClientContext,
    shutdown: Deferred<void>,
    exited: Promise<ExitInfo>,
    stderrRef: () => string,
    terminateGraceMs: number,
  ) {
    this.session = session;
    this.child = child;
    this.ctx = ctx;
    this.shutdown = shutdown;
    this.exited = exited;
    this.getStderr = stderrRef;
    this.terminateGraceMs = terminateGraceMs;
    void exited.then(() => { this.exitedProcess = true; });
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  /** Send an ACP `session/cancel` notification for this session. */
  async cancel(): Promise<void> {
    if (this.closed) return;
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId });
  }

  /** Dispose the session's update routing and terminate the subprocess. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdown.resolve();
    try {
      this.session.dispose();
    } catch {
      /* already disposed */
    }
    if (!this.exitedProcess) {
      this.child.kill("SIGTERM");
      // Escalate if the child ignores SIGTERM.
      setTimeout(() => {
        if (!this.exitedProcess) this.child.kill("SIGKILL");
      }, this.terminateGraceMs).unref();
    }
  }

  /** Terminate the subprocess and wait until its actual exit event is observed. */
  async closeAndWait(): Promise<ExitInfo> {
    this.close();
    const deadlineMs = this.terminateGraceMs + 2_000;
    let handle: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`lane process did not exit within ${deadlineMs}ms after termination began`)),
        deadlineMs,
      );
      handle.unref?.();
    });
    try {
      return await Promise.race([this.exited, timeout]);
    } finally {
      clearTimeout(handle!);
    }
  }

  stderr(): string {
    return this.getStderr();
  }

  /**
   * Spawn the lane subprocess and complete the ACP handshake. Resolves once the
   * session is created and ready to prompt; rejects if the subprocess exits, the
   * spawn fails, or the handshake exceeds `handshakeTimeoutMs`.
   */
  static async connect(options: LaneConnectionOptions): Promise<LaneConnection> {
    const { spec, cwd, readOnly, onFileWritten, resumeSessionId } = options;
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;

    // The MCP server is often launched with an absolute node path but a minimal
    // PATH that omits node's own bin dir, so `npx`-based lanes (e.g. codex-acp)
    // fail with spawn ENOENT. Prepend the running node's bin dir (where npx lives)
    // — derived, not hard-coded — so those lanes resolve.
    // A nonexistent cwd makes node's spawn fail with a misleading
    // "spawn <command> ENOENT" (reads as a PATH problem; cost a real PATH
    // chase on 2026-07-10 when a reaped worktree was passed as cwd).
    // Fail loud and name the actual problem instead.
    if (cwd && !fs.existsSync(cwd)) {
      throw new Error(
        `lane cwd does not exist: ${cwd} (worktree reaped or path typo?) — refusing to spawn`,
      );
    }

    const nodeBinDir = path.dirname(process.execPath);
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: {
        ...process.env,
        ...spec.env,
        PATH: `${nodeBinDir}${path.delimiter}${spec.env?.PATH ?? process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4_000);
    });

    const ready = new Deferred<LaneConnection>();
    const shutdown = new Deferred<void>();
    const exited = new Deferred<ExitInfo>();
    let resolvedReady = false;
    let aborted = options.signal?.aborted ?? false;

    const terminatePending = () => {
      if (resolvedReady) return;
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* process may already be gone */ }
      const killTimer = setTimeout(() => {
        if (!resolvedReady) {
          try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
        }
      }, options.terminateGraceMs ?? PROCESS_TERM_GRACE_MS);
      killTimer.unref?.();
      void exited.promise.finally(() => clearTimeout(killTimer));
    };
    options.signal?.addEventListener("abort", terminatePending, { once: true });
    if (aborted) terminatePending();

    const hsTimer = setTimeout(() => {
      if (!resolvedReady) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
        ready.reject(new Error(`handshake timed out after ${handshakeTimeoutMs}ms for '${spec.command}'`));
      }
    }, handshakeTimeoutMs);
    hsTimer.unref?.();
    void ready.promise.then(
      () => { clearTimeout(hsTimer); options.signal?.removeEventListener("abort", terminatePending); },
      () => { clearTimeout(hsTimer); options.signal?.removeEventListener("abort", terminatePending); },
    );

    child.on("error", (err) => {
      if (!resolvedReady) ready.reject(new Error(`failed to spawn '${spec.command}': ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      shutdown.resolve();
      exited.resolve({ code, signal, stderr: stderrTail });
      if (!resolvedReady) {
        ready.reject(aborted
          ? new Error("lane connection cancelled before handshake completed")
          : new Error(
            `lane process exited before handshake (code=${code} signal=${signal}). stderr: ${stderrTail.trim().slice(-800)}`,
          ));
      }
    });

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const handlePermission = (params: RequestPermissionRequest): RequestPermissionResponse =>
      choosePermissionOption(params.options ?? [], readOnly);

    const root = fs.realpathSync(cwd);
    const handleReadTextFile = (params: ReadTextFileRequest): ReadTextFileResponse => {
      try {
        const target = resolveContainedReadPath(root, params.path);
        const content = fs.readFileSync(target, "utf8");
        return { content };
      } catch (e) {
        throw new Error(`read_text_file failed for ${params.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const handleWriteTextFile = (params: WriteTextFileRequest): WriteTextFileResponse => {
      // CP5: read-only refuses writes unconditionally, independent of the
      // permission flow above.
      if (readOnly) {
        throw new Error(`write rejected: Clanker is read-only (path=${params.path})`);
      }
      const target = resolveContainedWritePath(root, params.path);
      writeContainedTextFile(target, params.path, params.content);
      onFileWritten?.(target);
      return {};
    };

    // connectWith holds the connection open for the lifetime of `op`; we park on
    // `shutdown` so the ActiveSession stays usable from outside this closure.
    acp
      .client({ name: "clanker" })
      .onRequest(acp.methods.client.session.requestPermission, (rc) => handlePermission(rc.params))
      .onRequest(acp.methods.client.fs.readTextFile, (rc) => handleReadTextFile(rc.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (rc) => handleWriteTextFile(rc.params))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: !readOnly } },
        });
        const session = resumeSessionId
          ? await resumeSession(ctx, resumeSessionId, cwd)
          : await ctx.buildSession(cwd).start();
        if (aborted) return;
        const conn = new LaneConnection(session, child, ctx, shutdown, exited.promise, () => stderrTail,
          options.terminateGraceMs ?? PROCESS_TERM_GRACE_MS);
        resolvedReady = true;
        ready.resolve(conn);
        await shutdown.promise;
        try {
          session.dispose();
        } catch {
          /* noop */
        }
      })
      .catch((e) => {
        if (!resolvedReady) {
          // A rejection here (e.g. initialize/session-resume/session-new
          // itself failing at the JSON-RPC level, not a process crash) means
          // the subprocess is still alive with its stdio pipes open — kill
          // it, or it leaks forever and keeps the parent's event loop alive
          // waiting on those pipes (found via a real hang: a rejected
          // session/resume never terminated its fake-agent child).
          if (!child.killed) child.kill("SIGKILL");
          ready.reject(e);
        }
      });

    return ready.promise;
  }
}

function assertContained(root: string, target: string, requested: string): string {
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`filesystem boundary rejection: path is outside session cwd (${requested})`);
  }
  return target;
}

/** Resolve an existing read target through realpath and enforce the session root. */
export function resolveContainedReadPath(root: string, requested: string): string {
  const canonicalRoot = fs.realpathSync(root);
  const lexical = path.resolve(canonicalRoot, requested);
  if (!path.isAbsolute(requested)) assertContained(canonicalRoot, lexical, requested);
  return assertContained(canonicalRoot, fs.realpathSync(lexical), requested);
}

/** Resolve a write through its real parent; final symlinks are never followed. */
export function resolveContainedWritePath(root: string, requested: string): string {
  const canonicalRoot = fs.realpathSync(root);
  const lexical = path.resolve(canonicalRoot, requested);
  if (!path.isAbsolute(requested)) assertContained(canonicalRoot, lexical, requested);
  try {
    if (fs.lstatSync(lexical).isSymbolicLink()) {
      throw new Error(`filesystem boundary rejection: final write target is a symlink (${requested})`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const parent = assertContained(canonicalRoot, fs.realpathSync(path.dirname(lexical)), requested);
  return assertContained(canonicalRoot, path.join(parent, path.basename(lexical)), requested);
}

/** Write a resolved cwd-contained target without following symlinks or modifying shared hardlink inodes. */
export function writeContainedTextFile(target: string, requested: string, content: string): void {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(target, flags, 0o666);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.nlink > 1) {
      throw new Error(
        `filesystem boundary rejection: write target has ${stat.nlink} hardlinks (${requested})`,
      );
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reconnect to a previously created ACP session by id via `session/resume`,
 * returning an `ActiveSession` usable exactly like the one `buildSession(...)
 * .start()` returns.
 *
 * `session/resume` (unlike `session/load`) resumes the backend's session
 * context without replaying prior message history back to us as
 * `session/update` notifications — the right primitive here since we're
 * respawning a dead subprocess and only care that the NEXT turn continues
 * the same conversation, not about re-ingesting history we already digested
 * once.
 *
 * `@agentclientprotocol/sdk` 1.1.0's public `ClientContext` has no
 * loadSession/resumeSession -> `ActiveSession` bridge: `ActiveSession`
 * objects are only ever built by the private `attachSession(response)`
 * method, which `SessionBuilder.start()` (session/new) calls internally.
 * `ResumeSessionResponse` omits `sessionId` (the caller already supplied it
 * in the request), so we synthesize a `NewSessionResponse`-shaped object
 * carrying the id we already have and reuse `attachSession` via a runtime
 * cast — verified against the installed SDK source (dist/acp.js):
 * `attachSession` is a plain instance method, not a `#`-private field, and
 * `SessionUpdateRouter.attach(response, updates)` only ever reads
 * `response.sessionId` off the object it's given.
 */
async function resumeSession(ctx: acp.ClientContext, sessionId: string, cwd: string): Promise<ActiveSession> {
  const resumed = await ctx.request(acp.methods.agent.session.resume, { sessionId, cwd });
  const synthetic: acp.NewSessionResponse = {
    sessionId,
    modes: resumed.modes,
    configOptions: resumed.configOptions,
    _meta: resumed._meta,
  };
  const attach = ctx as unknown as { attachSession(response: acp.NewSessionResponse): ActiveSession };
  return attach.attachSession(synthetic);
}
