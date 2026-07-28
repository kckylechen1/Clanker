/**
 * Public MCP surface.
 *
 * The ONLY dispatch entrance is `clanker_start_<profile-id>`: one narrow tool
 * generated per registry row, whose input schema contains ONLY that profile's
 * free parameters. Every welded dimension is absent from the schema rather
 * than overwritten in the handler, so a seat that holds one of these tools has
 * no way to ask for a capability the profile does not grant.
 *
 * There is deliberately NO generic `clanker_start(profile, ...)`. It existed
 * in the first #19 revision "for the leader", and cold review showed that one
 * exception voids the whole property: on host=codex — where the supervised-GLM
 * seat is not supposed to exist at all — the generic entrance still started
 * `oc-glm-write` and returned a live opencode/glm/write job. A universal
 * entrance that can reach every profile makes the narrow tools decoration.
 *
 * Host filtering therefore has to be complete rather than cosmetic: a profile
 * whose lane the host cannot drive, and any supervised profile on host=codex,
 * is never registered, so no tool on the surface can reach it.
 *
 * All routing and safety policy is still enforced by LaneManager; the registry
 * narrows the entrance, it does not re-implement the gates.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, PROGRESS_EXPERIMENTAL } from "./constants.js";
import { hostLaneBlockedReason } from "./host.js";
import type { LaneManager, WaitResult } from "./manager.js";
import { DISPATCH_PROFILES, type DispatchProfile } from "./profiles.js";
import { LANE_NAMES, type CodexSandboxMode } from "./types.js";

export const laneEnum = z.enum(LANE_NAMES);

const promptField = z.string().trim().min(1).describe("The task/prompt to send to the worker");
const cwdField = z.string().optional().describe("Absolute working directory (default: server base repo)");
const effortField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Reasoning effort override (codex/gemini/grok only; warned and ignored elsewhere)");

const sandboxEnum = z.enum(["read-only", "workspace-write", "danger-full-access"]);

function narrowShape(profile: DispatchProfile): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = { prompt: promptField, cwd: cwdField };
  if (profile.isolation === "required") {
    shape.worktree = z.string().trim().min(1).describe("Required branch name for the server-created isolated worktree");
  } else if (profile.isolation === "optional") {
    shape.worktree = z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional branch name. Omit to review the working checkout in place; supply one to run the read inside an " +
          "isolated worktree — the recipe for a review that must actually run build/test tooling.",
      );
  }
  if (profile.model.kind === "caller-required") {
    shape.model = z.string().trim().min(1).describe("Required explicit model id or supported alias for this lane");
  }
  if (profile.sandbox?.kind === "caller") {
    shape.sandbox = sandboxEnum
      .optional()
      .describe(
        `Codex-native sandbox strictness (default ${profile.sandbox.defaultMode}). "read-only" blocks all writes, ` +
          `"workspace-write" boxes them to the session cwd + tmp, "danger-full-access" removes the sandbox.`,
      );
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
    profile.sandbox?.kind === "welded" ? `sandbox=${profile.sandbox.mode}` : undefined,
    profile.model.kind === "welded" ? `model=${profile.model.id}` : undefined,
    profile.ocProfile ? `opencode-profile=${profile.ocProfile}` : undefined,
  ].filter(Boolean).join(", ");
  const isolation =
    profile.isolation === "required"
      ? "a managed worktree is mandatory"
      : profile.isolation === "optional"
        ? "runs in place, or inside a managed worktree when you name one"
        : "worktrees are rejected by this lane";
  return [
    profile.description,
    `Server-welded: ${welded}. Isolation: ${profile.isolation} — ${isolation}.`,
    profile.sandbox?.kind === "caller"
      ? `Caller-selectable sandbox across all three Codex tiers, default ${profile.sandbox.defaultMode}.`
      : undefined,
    profile.secrets.length
      ? `Credentials: ${profile.secrets.join(", ")} materialized from the OS keychain via \`tachi vault exec\` at spawn time — never passed as a parameter.`
      : undefined,
    profile.supervision === "sonnet"
      ? "Requires a Sonnet supervisor seat holding clanker_cancel."
      : undefined,
    `Hard turn ceiling: ${Math.round(profile.turnTimeoutMs / 60_000)} minutes${profile.readOnly ? "" : " — commit periodically so a timeout still leaves reviewable work in the worktree"}.`,
    profile.status === "dormant" ? `DORMANT: ${profile.dormantReason}.` : undefined,
  ].filter(Boolean).join(" ");
}

export function registerTools(server: McpServer, manager: LaneManager): void {
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
        // dispatchProfile is the only entrance that mints a registry
        // capability; the handler forwards free parameters and nothing else.
        return ok(await manager.dispatchProfile({
          profile: profile.id,
          prompt: args.prompt as string,
          cwd: args.cwd as string | undefined,
          worktree: args.worktree as string | undefined,
          model: args.model as string | undefined,
          sandbox: args.sandbox as CodexSandboxMode | undefined,
          effort: args.effort as string | undefined,
        }));
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
