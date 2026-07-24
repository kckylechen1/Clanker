/** Public MCP surface. All routing and safety policy is enforced by LaneManager. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, PROGRESS_EXPERIMENTAL } from "./constants.js";
import type { LaneManager, WaitResult } from "./manager.js";
import { LANE_NAMES } from "./types.js";

export const laneEnum = z.enum(LANE_NAMES);

const startShape = {
  lane: laneEnum.describe(`Backend lane: ${LANE_NAMES.join(" | ")}`),
  prompt: z.string().trim().min(1),
  cwd: z.string().optional(),
  worktree: z.string().trim().min(1).optional().describe("Managed worktree branch name"),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  read_only: z.boolean().optional(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  profile: z.enum(["worker", "kimi-crew"]).optional().default("worker"),
} as const;

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

function progressSender(extra: unknown): ((r: WaitResult) => void) | undefined {
  if (!PROGRESS_EXPERIMENTAL) return undefined;
  const e = extra as { _meta?: { progressToken?: string | number }; sendNotification?: (n: unknown) => Promise<void> };
  const token = e?._meta?.progressToken;
  if (token === undefined || typeof e.sendNotification !== "function") return undefined;
  return (r) => void e.sendNotification!({
    method: "notifications/progress",
    params: { progressToken: token, progress: r.plan_final?.completed ?? 0, total: r.plan_final?.total, message: `[${r.lane}] ${r.plan_summary}` },
  }).catch(() => {});
}

export function registerTools(server: McpServer, manager: LaneManager): void {
  server.registerTool("clanker_start", {
    title: "Start a Clanker job",
    description: "Start one asynchronous cross-harness job. Routing, host gates, write isolation, and profile policy are normalized server-side.",
    inputSchema: startShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      const result = await manager.dispatchStart({
        lane: args.lane,
        prompt: args.prompt,
        cwd: args.cwd,
        worktree: args.worktree,
        model: args.model,
        effort: args.effort,
        readOnly: args.read_only,
        sandbox: args.sandbox,
        profile: args.profile,
      });
      return ok(result);
    } catch (error) { return fail(error); }
  });

  server.registerTool("clanker_wait", {
    title: "Long-poll a Clanker job",
    description: `Wait for progress or completion (default ${DEFAULT_WAIT_MS}ms, cap ${MAX_WAIT_MS}ms).`,
    inputSchema: { id: z.string(), timeout_ms: z.number().int().min(0).optional(), quiet: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    try {
      const result = await manager.wait(args.id, args.timeout_ms, args.quiet);
      progressSender(extra)?.(result);
      return ok(result);
    } catch (error) { return fail(error); }
  });

  server.registerTool("clanker_status", {
    title: "Get Clanker job status",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => { try { return ok(manager.status(args.id)); } catch (error) { return fail(error); } });

  server.registerTool("clanker_cancel", {
    title: "Cancel a Clanker job",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (args) => { try { return ok(await manager.cancel(args.id)); } catch (error) { return fail(error); } });

  server.registerTool("clanker_list", {
    title: "List Clanker jobs",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => ok({ clankers: manager.list() }));
}
