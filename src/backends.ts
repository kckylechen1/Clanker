/**
 * Lane registry — the single source of truth for how each external lane is
 * spawned as an ACP agent, and how model / effort / read-only map onto that
 * lane's real CLI surface.
 *
 * Mechanisms below were derived from the installed CLIs' `--help` output and
 * the codex-acp package README (2026-07-06):
 *
 * - grok    `grok agent [--model M] [--reasoning-effort E] stdio`
 *           model + effort are flags on the `grok agent` parent command.
 * - opencode `opencode acp` — no model flag on the acp subcommand. Model is
 *           supplied via OPENCODE_CONFIG pointing at a per-run JSON config
 *           ({"model":"provider/model"}). opencode has no ACP-mode reasoning
 *           effort knob (that is the `--variant` run flag), so effort warns.
 * - codex   `npx -y @agentclientprotocol/codex-acp@<CODEX_ACP_VERSION>` — model +
 *           reasoning effort via CODEX_CONFIG (JSON merged into the Codex
 *           session config: {"model":...,"model_reasoning_effort":...});
 *           read-only via INITIAL_AGENT_MODE (read-only | agent-full-access).
 *
 *           The npx spec is version-pinned, not `@latest`. 2026-07-13 incident
 *           precedent: an unpinned `@latest` silently picked up a codex-acp
 *           release whose app-server mode registered a reserved
 *           `collaboration.spawn_agent` tool (multi_agent_v2), breaking every
 *           codex dispatch with a turn-1 400 that nobody could pin to a code
 *           change because the dependency itself had moved under us. Upgrading
 *           codex-acp is now an explicit, reviewable act: bump
 *           `CODEX_ACP_VERSION` below and run `npm run smoke -- codex` (and a
 *           sol-model-override smoke) before trusting the new version.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveOcModel } from "./constants.js";
import type { LaneName, LaneRequestOptions, SpawnSpec } from "./types.js";

/**
 * Pinned `@agentclientprotocol/codex-acp` version. Verified-working as of
 * 2026-07-13 (see file header). Never widen this back to `@latest` — bump it
 * deliberately and re-smoke.
 */
const CODEX_ACP_VERSION = "1.1.2";

interface LaneCapabilities {
  model: boolean;
  effort: boolean;
  /** Whether the CLI enforces read-only at its own layer (vs client gate). */
  nativeReadOnly: boolean;
}

const CAPS: Record<LaneName, LaneCapabilities> = {
  codex: { model: true, effort: true, nativeReadOnly: true },
  opencode: { model: true, effort: false, nativeReadOnly: false },
  grok: { model: true, effort: true, nativeReadOnly: false },
};

/**
 * Build the concrete spawn recipe for a lane.
 *
 * @param runDir directory where per-run scratch files (e.g. the opencode
 *   config) may be written. Must already exist.
 */
export function buildSpawnSpec(
  lane: LaneName,
  opts: LaneRequestOptions,
  runDir: string,
): SpawnSpec {
  const warnings: string[] = [];
  const env: Record<string, string> = {};
  const caps = CAPS[lane];

  if (opts.model && !caps.model) {
    warnings.push(`lane '${lane}' does not support model override; ignoring model='${opts.model}'`);
  }
  if (opts.effort && !caps.effort) {
    warnings.push(`lane '${lane}' does not support reasoning-effort override; ignoring effort='${opts.effort}'`);
  }

  switch (lane) {
    case "grok": {
      const args = ["agent"];
      if (opts.model) args.push("--model", opts.model);
      if (opts.effort) args.push("--reasoning-effort", opts.effort);
      args.push("stdio");
      return { command: "grok", args, env, warnings };
    }

    case "opencode": {
      const args = ["acp"];
      // Shortnames (glm/ds/kimi/free) resolve to full provider/model ids from the
      // single source in constants.ts; full ids pass through unchanged.
      const model = resolveOcModel(opts.model);
      if (model) {
        const cfgPath = path.join(runDir, "opencode-config.json");
        fs.writeFileSync(
          cfgPath,
          JSON.stringify({ $schema: "https://opencode.ai/config.json", model }, null, 2),
        );
        env.OPENCODE_CONFIG = cfgPath;
      }
      return { command: "opencode", args, env, warnings };
    }

    case "codex": {
      const codexConfig: Record<string, unknown> = {};
      if (opts.model) codexConfig.model = opts.model;
      if (opts.effort) codexConfig.model_reasoning_effort = opts.effort;
      if (Object.keys(codexConfig).length > 0) {
        env.CODEX_CONFIG = JSON.stringify(codexConfig);
      }
      env.INITIAL_AGENT_MODE = opts.readOnly ? "read-only" : "agent-full-access";
      return {
        command: "npx",
        args: ["-y", `@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}`],
        env,
        warnings,
      };
    }
  }
}
