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
import { HANDSHAKE_TIMEOUT_MS } from "./constants.js";
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

  private constructor(
    session: ActiveSession,
    child: ChildProcessWithoutNullStreams,
    ctx: ClientContext,
    shutdown: Deferred<void>,
    exited: Promise<ExitInfo>,
    stderrRef: () => string,
  ) {
    this.session = session;
    this.child = child;
    this.ctx = ctx;
    this.shutdown = shutdown;
    this.exited = exited;
    this.getStderr = stderrRef;
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
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
      // Escalate if the child ignores SIGTERM.
      setTimeout(() => {
        if (!this.child.killed) this.child.kill("SIGKILL");
      }, 2_000).unref();
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

    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...spec.env },
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
      () => clearTimeout(hsTimer),
      () => clearTimeout(hsTimer),
    );

    child.on("error", (err) => {
      if (!resolvedReady) ready.reject(new Error(`failed to spawn '${spec.command}': ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      shutdown.resolve();
      exited.resolve({ code, signal, stderr: stderrTail });
      if (!resolvedReady) {
        ready.reject(
          new Error(
            `lane process exited before handshake (code=${code} signal=${signal}). stderr: ${stderrTail.trim().slice(-800)}`,
          ),
        );
      }
    });

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const handlePermission = (params: RequestPermissionRequest): RequestPermissionResponse =>
      choosePermissionOption(params.options ?? [], readOnly);

    const handleReadTextFile = (params: ReadTextFileRequest): ReadTextFileResponse => {
      try {
        const content = fs.readFileSync(params.path, "utf8");
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
      fs.writeFileSync(params.path, params.content);
      onFileWritten?.(params.path);
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
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        const session = await ctx.buildSession(cwd).start();
        const conn = new LaneConnection(session, child, ctx, shutdown, exited.promise, () => stderrTail);
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
        if (!resolvedReady) ready.reject(e);
      });

    return ready.promise;
  }
}
