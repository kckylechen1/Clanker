import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const execute = promisify(execFile);

/** Only model identifiers leave the CLI boundary, never config, auth, or stderr. */
export async function openCodeModels(): Promise<string[]> {
  const { stdout } = await execute("opencode", ["models", "--pure"], {
    timeout: 30_000, maxBuffer: 1_048_576, encoding: "utf8",
  });
  const models = [...new Set(stdout.split(/\r?\n/).map(s => s.trim())
    .filter(s => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(s)))].sort();
  if (!models.length) throw new Error("OpenCode returned no model identifiers");
  return models;
}

export function registerModelCatalog(server: McpServer): void {
  server.registerTool("clanker_models", {
    title: "List OpenCode model routes",
    description: "Discover provider/model IDs, including configured DGX or other self-hosted providers. " +
      "Lists configuration, not endpoint health or remaining credits. Never starts inference. " +
      "Use the exact returned ID with oc-managed-review or oc-managed-write.",
    inputSchema: {
      provider: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ provider, offset, limit }) => {
    try {
      const all = (await openCodeModels()).filter(id => !provider || id.startsWith(`${provider}/`));
      const result = { models: all.slice(offset, offset + limit), total: all.length,
        next_offset: offset + limit < all.length ? offset + limit : null, availability: "configured_only" };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch {
      return { isError: true, content: [{ type: "text" as const,
        text: "CLANKER-MODEL-CATALOG: OpenCode model discovery failed or timed out. Check the local opencode CLI; no inference was started." }] };
    }
  });
}
