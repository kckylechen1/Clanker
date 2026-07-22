/**
 * MCP tool surface (spec §2 + addenda A/B/C). Tools are thin adapters over
 * LaneManager; all backend Clanker logic lives there.
 *
 * Tool responses are JSON text (the ignition-hand agents parse text). The
 * information-pollution defense (spec §6) is enforced upstream: only `digest`
 * (in clanker_wait) and `final_message` cross the tool boundary; raw thought /
 * message chunks never do.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_WAIT_MS, isGlmModel, MAX_WAIT_MS, PROGRESS_EXPERIMENTAL } from "./constants.js";
import type { LaneManager, WaitResult } from "./manager.js";
import { LANE_NAMES, type CodexSandboxMode, type DispatchPolicyTelemetry, type LaneName } from "./types.js";
import { hostLaneBlockedReason, laneNamesForHost, type ClankerHost } from "./host.js";

// Full registry enum, exported so tests can detect drift from LANE_NAMES.
// Registered dispatch tools always replace it with a host-filtered enum.
export const laneEnum = z.enum(LANE_NAMES);

const dispatchOptionsShape = {
  prompt: z.string().min(1).describe("The task/prompt to send to the Clanker"),
  cwd: z.string().optional().describe("Absolute working directory (default: server base repo)"),
  worktree: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Branch name; server creates a git worktree cut from origin/main and runs there"),
  model: z
    .string()
    .optional()
    .describe("Model override, e.g. 'zhipuai-coding-plan/glm-5.2' (opencode) — warned & echoed if the Clanker can't honor it"),
  effort: z.string().optional().describe("Reasoning effort override (codex/grok only)"),
  read_only: z.boolean().optional().describe("If true, the Clanker is gated read-only (default false)"),
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional()
    .describe(
      "codex-only native sandbox strictness override (independent of read_only). " +
        "\"workspace-write\" boxes writes to the session cwd + tmp — the review-seat recipe " +
        "is worktree + sandbox=\"workspace-write\", so cargo/go test can actually run instead " +
        "of being Not-checked. Unset defaults writes to workspace-write; danger-full-access requires an explicit override. " +
        "Ignored (warned) on grok/opencode. Grok still derives its native read-only/workspace sandbox " +
        "from read_only; opencode has no native sandbox tier.",
    ),
  agent: z
    .string()
    .optional()
    .describe(
      "Deprecated compatibility field; ignored with a warning on every lane. " +
        "Opencode always runs Clanker's fixed clanker-worker profile so callers cannot replace its permission boundary.",
    ),
  seat: z
    .boolean()
    .optional()
    .describe(
      "If true, this run is a persistent seat: the idle-TTL reaper only kills the backend " +
        "subprocess (never the session/worktree), and clanker_prompt on a dead-process seat " +
        "transparently respawns + resumes the same ACP session via session/resume. Verified " +
        "against opencode; codex/grok backends don't implement session/resume, so resuming a " +
        "dead-process seat on those lanes surfaces an error instead of reconnecting. Use " +
        "clanker_close to explicitly end a seat.",
    ),
} as const;

const glmWriteDispatchShape = z
  .object(dispatchOptionsShape)
  .omit({ model: true, effort: true, read_only: true, sandbox: true, agent: true })
  .extend({
    worktree: z.string().trim().min(1).describe("Required branch name for the server-created isolated GLM worktree"),
  }).shape;

function rejectsUnsupervisedGlmWrite(args: { lane: string; model?: string; read_only?: boolean }): boolean {
  return isGlmModel(args.model) && !(args.read_only ?? false);
}

function glmWriteBlockedMessage(host: ClankerHost): string {
  return host === "codex"
    ? "GLM writes are unavailable on host=codex because they require the Claude/Sonnet supervisor"
    : "GLM writes require clanker_dispatch_glm_write_start and Sonnet supervision";
}

function progressSender(extra: unknown): ((r: WaitResult) => void) | undefined {
  if (!PROGRESS_EXPERIMENTAL) return undefined;
  const e = extra as {
    _meta?: { progressToken?: string | number };
    sendNotification?: (n: unknown) => Promise<void>;
  };
  const token = e?._meta?.progressToken;
  if (token === undefined || token === null || typeof e.sendNotification !== "function") return undefined;
  return (r: WaitResult) => {
    void e
      .sendNotification!({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: r.plan_final?.completed ?? 0,
          total: r.plan_final?.total ?? undefined,
          message: `[${r.lane}] ${r.plan_summary}`,
        },
      })
      .catch(() => {
        /* experimental channel one: best-effort only */
      });
  };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string, telemetry?: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...(telemetry ? { telemetry } : {}) }, null, 2) }], isError: true };
}

export function registerTools(server: McpServer, manager: LaneManager): void {
  const host: ClankerHost = manager.host ?? "standalone";
  const hostLanes = laneNamesForHost(host) as [LaneName, ...LaneName[]];
  const hostLaneEnum = z.enum(hostLanes);
  const hostDispatchShape = {
    lane: hostLaneEnum.describe(`Backend Clanker to drive: ${hostLanes.join(" | ")}`),
    ...dispatchOptionsShape,
  };
  const hostReadonlyDispatchShape = z.object(hostDispatchShape).omit({ read_only: true, sandbox: true }).shape;
  const writeModelSchema = z.string().trim().min(1);
  const hostWriteDispatchShape = z.object(hostDispatchShape).omit({ read_only: true }).extend({
    model: host === "codex"
      ? writeModelSchema.describe("Required explicit model id or supported model alias for opencode/grok writes")
      : writeModelSchema.optional().describe(
          "Model override. Optional for lane=codex (omit it to use Codex's configured default); required for opencode/grok writes. A lane name is not a model id.",
        ),
    worktree: z.string().trim().min(1).describe("Required branch name for the server-created isolated worktree"),
  }).shape;
  const policyFailure = (lane: LaneName) => {
    const blocked_reason = hostLaneBlockedReason(host, lane);
    if (!blocked_reason) return undefined;
    const telemetry: DispatchPolicyTelemetry = { host, requested_lane: lane, actual_lane: null, blocked_reason };
    return fail(blocked_reason, telemetry);
  };

  server.registerTool(
    "clanker_dispatch_start",
    {
      title: "Start a Clanker turn (non-blocking)",
      description:
        "Spawn/handshake a Clanker and start a prompt turn, returning {id} immediately. Poll progress with clanker_wait(id). Setup errors (unknown backend, worktree creation) fail here; runtime errors surface via clanker_wait.",
      inputSchema: hostDispatchShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const blocked = policyFailure(args.lane);
        if (blocked) return blocked;
        if (rejectsUnsupervisedGlmWrite(args)) {
          return fail(glmWriteBlockedMessage(host));
        }
        const { id, warnings } = await manager.dispatchStart(toDispatch(args));
        return ok({ id, warnings });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_dispatch_readonly_start",
    {
      title: "Start a read-only Clanker turn (non-blocking)",
      description:
        "Relay-only start path. The server always forces read_only=true and exposes no caller override. Returns {id} immediately; poll with clanker_wait(id).",
      inputSchema: hostReadonlyDispatchShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const blocked = policyFailure(args.lane);
        if (blocked) return blocked;
        const { id, warnings } = await manager.dispatchStart({
          ...toDispatch(args),
          readOnly: true,
          sandbox: undefined,
        });
        return ok({ id, warnings });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_dispatch_write_start",
    {
      title: "Start an isolated write-capable Clanker turn (non-blocking)",
      description:
        "Write-relay start path. The server always forces read_only=false and requires a managed worktree branch. Returns {id} immediately; poll with clanker_wait(id).",
      inputSchema: hostWriteDispatchShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const blocked = policyFailure(args.lane);
        if (blocked) return blocked;
        if (args.lane !== "codex" && !args.model) {
          return fail(`an explicit model is required for write lane '${args.lane}'`);
        }
        if (isGlmModel(args.model)) {
          return fail(glmWriteBlockedMessage(host));
        }
        const { id, warnings } = await manager.dispatchStart({ ...toDispatch(args), readOnly: false });
        return ok({ id, warnings });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  if (host !== "codex") server.registerTool(
    "clanker_dispatch_glm_write_start",
    {
      title: "Start a supervised isolated GLM write turn (non-blocking)",
      description:
        "GLM-supervisor-only start path. The server fixes lane=opencode, model=glm, read_only=false, and requires a managed worktree branch. Returns {id} immediately; poll with clanker_wait(id).",
      inputSchema: glmWriteDispatchShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const { id, warnings } = await manager.dispatchSupervisedGlmWrite({
          prompt: args.prompt,
          cwd: args.cwd,
          worktree: args.worktree,
          seat: args.seat,
        });
        return ok({ id, warnings });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_wait",
    {
      title: "Long-poll a Clanker run",
      description: `Wait up to timeout_ms (default ${DEFAULT_WAIT_MS}, cap ${MAX_WAIT_MS}) for new events or completion. Returns {status, digest, plan_summary, last_event_age_ms, suspected_stall}; when status is terminal also {final_message, touched_files, plan_final}, and on error also {error, failure_class}. digest is a human-readable summary of events since the previous wait — tool titles, file writes, plan check changes, key message sentences. failure_class="CLANKER-INFRA-FAILURE" means the backend rejected the request shape on turn 1 with zero tool calls — retrying the identical dispatch is pointless; run a smoke check first. Quiet mode (default on): only wakes before the deadline on a plan/status change, a tool error, a suspected stall, or a terminal state — trivial chatter (a tool_call starting, a file-location echo, a message-chunk fragment) does not cut the wait short, so callers no longer need to repoll tightly just because the run is reading/grepping. Pass quiet:false for the old any-event wake-up.`,
      inputSchema: {
        id: z
          .string()
          .describe(
            "Run id from a Clanker dispatch/start tool",
          ),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Long-poll window in ms (default ${DEFAULT_WAIT_MS}, capped at ${MAX_WAIT_MS})`),
        quiet: z
          .boolean()
          .optional()
          .describe(
            "Debounce mode (default true): wake early only on plan/status change, tool error, suspected stall, or terminal state. quiet:false restores waking on every trivial event (tool_call start, file echo, message chunk) — the pre-debounce behavior.",
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const result = await manager.wait(args.id, args.timeout_ms, args.quiet);
        progressSender(extra)?.(result);
        return ok(result);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_dispatch",
    {
      title: "Dispatch to a Clanker and block until the turn completes",
      description:
        "Convenience path = clanker_dispatch_start + loop clanker_wait until the turn is terminal. Returns the terminal WaitResult {status, final_message, touched_files, plan_final}. For long tasks prefer clanker_dispatch_start + clanker_wait so the caller controls polling and avoids MCP request timeouts.",
      inputSchema: hostDispatchShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const blocked = policyFailure(args.lane);
        if (blocked) return blocked;
        if (rejectsUnsupervisedGlmWrite(args)) {
          return fail(glmWriteBlockedMessage(host));
        }
        const result = await manager.dispatchBlocking(toDispatch(args), progressSender(extra));
        return ok(result);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_prompt",
    {
      title: "Continue an existing Clanker session with a new turn",
      description:
        "Start a new prompt turn on an already-open session (persistent-session reuse). Set correction=true only when this turn is a supervisor correction; telemetry counts it separately from ordinary continuation turns. Returns {id}; poll with clanker_wait(id). Errors if the session was reaped/closed or a turn is already running.",
      inputSchema: {
        id: z.string().describe("Existing run/session id"),
        prompt: z.string().min(1).describe("Prompt for the new turn"),
        correction: z.boolean().optional().describe("Mark this continuation as a supervisor correction in run telemetry"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(await manager.promptExisting(args.id, args.prompt, args.correction ?? false));
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_status",
    {
      title: "Cheap status of a Clanker run",
      description:
        "Return {status, plan (checkbox counts + current step), tool_calls, last_event_age_ms, suspected_stall}. Does not wait. suspected_stall flags a running turn silent past the stall threshold. When status is \"error\" also returns {error, failure_class}; failure_class=\"CLANKER-INFRA-FAILURE\" means the backend rejected the request shape before the agent did anything — retrying the identical dispatch is pointless.",
      inputSchema: { id: z.string().describe("Run id") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(manager.status(args.id));
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_cancel",
    {
      title: "Cancel a Clanker's in-flight turn",
      description: "Request ACP cancellation, wait for a terminal result, and force-terminate an uncooperative backend after CLANKER_CANCEL_GRACE_MS. Returns only after cancelled (or a loud terminal error). No-op if idle.",
      inputSchema: { id: z.string().describe("Run id") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(await manager.cancel(args.id));
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "clanker_list",
    {
      title: "List active Clanker sessions",
      description:
        "Overview of live Clankers: [{id, lane, state (working|idle|stalled), idle_ms, turns_count, plan_summary, suspected_stall}]. Reaped/closed sessions are omitted.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => ok({ clankers: manager.list() }),
  );

  server.registerTool(
    "clanker_close",
    {
      title: "Explicitly close a Clanker session",
      description:
        "Terminal close: disposes the ACP session, kills the subprocess, and cleans the worktree " +
        "if unchanged (retained if dirty, same as the idle-TTL reaper's non-seat path). Seat runs " +
        "are never closed by the idle-TTL reaper (it only kills the subprocess, keeping the session " +
        "resumable) — this is how a seat gets deliberately ended. No-op if already closed.",
      inputSchema: { id: z.string().describe("Run id") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        await manager.close(args.id);
        return ok({ id: args.id, closed: true });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );
}

function toDispatch(args: {
  lane: LaneName;
  prompt: string;
  cwd?: string;
  worktree?: string;
  model?: string;
  effort?: string;
  read_only?: boolean;
  sandbox?: CodexSandboxMode;
  agent?: string;
  seat?: boolean;
}) {
  return {
    lane: args.lane,
    prompt: args.prompt,
    cwd: args.cwd,
    worktree: args.worktree,
    model: args.model,
    effort: args.effort,
    readOnly: args.read_only,
    sandbox: args.sandbox,
    agent: args.agent,
    seat: args.seat,
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
