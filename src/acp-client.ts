/**
 * ACP client wrapper — spawns one lane CLI as an ACP agent subprocess, performs
 * the initialize / session/new handshake, and exposes a long-lived
 * `ActiveSession` plus cancel / close controls.
 *
 * Built on the official `@agentclientprotocol/sdk`. Its `ActiveSession`
 * (`prompt()` + `nextUpdate()` loop yielding `session_update` / `stop`) maps
 * 1:1 onto spec §6, so hand-rolling the JSON-RPC core is unnecessary.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
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

/**
 * Signal a worker's whole PROCESS GROUP, falling back to the bare pid (#32).
 *
 * A lane worker is not a leaf: codex-acp spawns `codex app-server`, opencode
 * and grok start helpers of their own. Killing only `child.pid` leaves those
 * grandchildren running — still holding the worktree, still burning tokens,
 * invisible to every lifecycle tool. `connect()` therefore spawns each worker
 * `detached`, which makes it the leader of a new group whose pgid equals its
 * pid, and every kill path in this file signals `-pid` so the whole tree goes
 * down together.
 *
 * This is deliberately NOT scoped to the foreign-adoption protocol #32 adds on
 * top of it: own and foreign workers grow the same grandchildren, so the
 * owner's own teardown (close / closeAndWait / handshake abort) needs the same
 * knife. Adoption just reuses it.
 *
 * Two guards, both load-bearing:
 *  - An already-reaped child gets NOTHING. Once the OS has reaped the worker
 *    its pid — and therefore the pgid derived from it — may already have been
 *    recycled onto an unrelated process, and `process.kill(-pid)` would signal
 *    a whole group of innocents. `child.kill()` is safe there because Node
 *    knows the child is gone; the raw syscall has no such knowledge.
 *  - A failed group kill (ESRCH: group already gone; EPERM; or a platform/spawn
 *    shape where the worker never led a group at all — win32, or any spawn that
 *    predates `detached`) falls through to the single-pid kill rather than
 *    leaving a live worker unsignaled. Losing the grandchildren is bad; losing
 *    the worker too would be worse.
 *
 * (gemini-acp.ts has a sibling `signalChildTree` for the same reason. It is a
 * standalone sidecar with no imports from src/, so the two stay separate on
 * purpose rather than sharing a module that would drag this file into the
 * sidecar bundle.)
 */
function signalWorkerGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* group gone or never existed — fall through to the direct pid */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* process may already be gone */
  }
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
   * Invoked the instant `spawn` hands back a pid, BEFORE the handshake (#32).
   *
   * The handshake can take up to HANDSHAKE_TIMEOUT_MS, and a worker is a real,
   * running, grandchild-growing process for every millisecond of it. If this
   * server dies in that window, whoever finds the leftovers can only kill them
   * with a pid that was written down — so the pid is published here rather
   * than on the success path. `pid` is also the worker's process GROUP id (the
   * spawn is detached; see signalWorkerGroup).
   */
  onSpawn?: (info: { pid: number; startedAt: number }) => void;
}

/**
 * A live ACP connection to one lane subprocess.
 *
 * The connection stays open until the job is cancelled, closed after its idle
 * TTL, or the manager shuts down. `close()` disposes the session and kills the
 * subprocess.
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
      signalWorkerGroup(this.child, "SIGTERM");
      // Escalate if the child ignores SIGTERM.
      setTimeout(() => {
        if (!this.exitedProcess) signalWorkerGroup(this.child, "SIGKILL");
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
    const { spec, cwd, readOnly, onFileWritten } = options;
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
      // Give every worker its own process group (pgid === worker pid) so the
      // kill paths above can take down the grandchildren it spawns — see
      // signalWorkerGroup. `detached` changes NOTHING else here: stdio stays
      // piped (the ACP transport is these pipes), and the child is
      // deliberately NOT unref'd — this server must keep waiting on its exit.
      // The one real consequence is that a worker no longer receives signals
      // sent to the SERVER's group (e.g. a terminal Ctrl-C); that is handled
      // by index.ts's SIGINT/SIGTERM handlers, which run manager.shutdown()
      // and come back through these same kill paths.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const spawnedAt = Date.now();
    // No pid means spawn itself failed; the 'error' event below is the honest
    // report of that, and there is no process to publish.
    if (child.pid !== undefined) options.onSpawn?.({ pid: child.pid, startedAt: spawnedAt });

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
      signalWorkerGroup(child, "SIGTERM");
      const killTimer = setTimeout(() => {
        if (!resolvedReady) signalWorkerGroup(child, "SIGKILL");
      }, options.terminateGraceMs ?? PROCESS_TERM_GRACE_MS);
      killTimer.unref?.();
      void exited.promise.finally(() => clearTimeout(killTimer));
    };
    options.signal?.addEventListener("abort", terminatePending, { once: true });
    if (aborted) terminatePending();

    const hsTimer = setTimeout(() => {
      if (!resolvedReady) {
        signalWorkerGroup(child, "SIGKILL");
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
        const session = await ctx.buildSession(cwd).start();
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
          // A JSON-RPC handshake rejection can leave the subprocess alive
          // with stdio pipes open. Kill it so the parent's event loop cannot
          // leak a failed backend connection. No `child.killed` guard: that
          // flag only tracks single-pid `child.kill()` calls, so it stays
          // false after a group kill and would gate this on the wrong fact —
          // signalWorkerGroup's own already-reaped check is the real guard.
          signalWorkerGroup(child, "SIGKILL");
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
