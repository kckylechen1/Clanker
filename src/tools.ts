/**
 * Public MCP surface.
 *
 * Two entrances, one policy source:
 *  - `clanker_start(profile, ...)` — the generic entrance kept for the leader
 *    that actually chooses which profile a job belongs to.
 *  - `clanker_start_<profile-id>` — one narrow tool generated per registry row.
 *    Its input schema contains ONLY that profile's free parameters; `lane`,
 *    `read_only`, `sandbox` and every welded `model` are absent from the schema
 *    rather than overwritten in the handler, so a seat that holds one of these
 *    tools has no way to ask for a capability the profile does not grant.
 *
 * All routing and safety policy is still enforced by LaneManager; the registry
 * narrows the entrance, it does not re-implement the gates.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, PROGRESS_EXPERIMENTAL } from "./constants.js";
import { hostLaneBlockedReason } from "./host.js";
import type { LaneManager, WaitResult } from "./manager.js";
import {
  DISPATCH_PROFILES,
  PROFILE_IDS,
  resolveProfileDispatch,
  type DispatchProfile,
} from "./profiles.js";
import { LANE_NAMES } from "./types.js";

export const laneEnum = z.enum(LANE_NAMES);

const promptField = z.string().trim().min(1).describe("The task/prompt to send to the worker");
const cwdField = z.string().optional().describe("Absolute working directory (default: server base repo)");
const effortField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Reasoning effort override (codex/gemini/grok only; warned and ignored elsewhere)");

const startShape = {
  profile: z
    .enum(PROFILE_IDS)
    .describe(`Dispatch profile — the whole capability combination: ${PROFILE_IDS.join(" | ")}`),
  prompt: promptField,
  cwd: cwdField,
  worktree: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Managed worktree branch name — required by write profiles, rejected by read-only ones"),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Only for profiles whose model is caller-required; rejected when the profile welds a model or takes the lane default"),
  effort: effortField,
} as const;

function narrowShape(profile: DispatchProfile): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = { prompt: promptField, cwd: cwdField };
  if (profile.isolation === "required") {
    shape.worktree = z.string().trim().min(1).describe("Required branch name for the server-created isolated worktree");
  }
  if (profile.model.kind === "caller-required") {
    shape.model = z.string().trim().min(1).describe("Required explicit model id or supported alias for this lane");
  }
  shape.effort = effortField;
  return shape;
}

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

/**
 * Profiles a given host may start. A host that cannot drive the lane never sees
 * the tool, and (0.2.x parity) host=codex never sees the supervised-GLM profile
 * because that shape requires the Claude/Sonnet supervisor seat.
 */
export function profilesForHost(manager: LaneManager): DispatchProfile[] {
  const host = manager.host ?? "standalone";
  return DISPATCH_PROFILES.filter((profile) => {
    if (hostLaneBlockedReason(host, profile.lane)) return false;
    if (profile.supervision === "sonnet" && host === "codex") return false;
    return true;
  });
}

function describe(profile: DispatchProfile): string {
  const welded = [
    `lane=${profile.lane}`,
    `read_only=${profile.readOnly}`,
    profile.sandbox ? `sandbox=${profile.sandbox}` : undefined,
    profile.model.kind === "welded" ? `model=${profile.model.id}` : undefined,
    profile.ocProfile ? `opencode-profile=${profile.ocProfile}` : undefined,
  ].filter(Boolean).join(", ");
  return [
    profile.description,
    `Server-welded: ${welded}. Isolation: ${profile.isolation}.`,
    profile.secrets.length
      ? `Credentials: ${profile.secrets.join(", ")} materialized from the OS keychain via \`tachi vault exec\` at spawn time — never passed as a parameter.`
      : undefined,
    profile.supervision === "sonnet"
      ? "Requires a Sonnet supervisor seat holding clanker_prompt/clanker_cancel."
      : undefined,
    `Hard turn ceiling: ${Math.round(profile.turnTimeoutMs / 60_000)} minutes${profile.readOnly ? "" : " — commit periodically so a timeout still leaves reviewable work in the worktree"}.`,
    profile.status === "dormant" ? `DORMANT: ${profile.dormantReason}.` : undefined,
  ].filter(Boolean).join(" ");
}

export function registerTools(server: McpServer, manager: LaneManager): void {
  server.registerTool("clanker_start", {
    title: "Start a Clanker job",
    description:
      "Start one asynchronous cross-harness job by naming a dispatch profile. The profile fixes lane, " +
      "write mode, sandbox, isolation, credentials, supervision and turn ceiling; routing and host gates " +
      "are normalized server-side.",
    inputSchema: startShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      return ok(await manager.dispatchStart(resolveProfileDispatch(args)));
    } catch (error) { return fail(error); }
  });

  for (const profile of profilesForHost(manager)) {
    server.registerTool(`clanker_start_${profile.id}`, {
      title: profile.title,
      description: describe(profile),
      inputSchema: narrowShape(profile),
      annotations: {
        readOnlyHint: profile.readOnly,
        destructiveHint: !profile.readOnly,
        idempotentHint: false,
        openWorldHint: true,
      },
    }, async (args: Record<string, unknown>) => {
      try {
        return ok(await manager.dispatchStart(resolveProfileDispatch({
          profile: profile.id,
          prompt: args.prompt as string,
          cwd: args.cwd as string | undefined,
          worktree: args.worktree as string | undefined,
          model: args.model as string | undefined,
          effort: args.effort as string | undefined,
        })));
      } catch (error) { return fail(error); }
    });
  }

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
