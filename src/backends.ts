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
 *           sandbox strictness via INITIAL_AGENT_MODE. Verified against the
 *           codex-acp 1.1.2 source (src/AgentMode.ts): three modes exist, not
 *           two — `read-only` (readOnly sandbox, no writes at all), `agent`
 *           (workspaceWrite sandbox: writes boxed to the session cwd + tmp —
 *           this is the middle tier `opts.sandbox="workspace-write"` maps
 *           to), and `agent-full-access` (dangerFullAccess: writes anywhere,
 *           no sandbox). Without an explicit `opts.sandbox`, behavior is
 *           unchanged from before this option existed: `readOnly ?
 *           "read-only" : "agent-full-access"` — the workspace-write middle
 *           tier is opt-in only.
 *
 *           Recommended usage for a review seat that needs to actually run
 *           `cargo test`/`go test` (not just read code): dispatch into a
 *           detached worktree (`worktree: <branch>`) with `sandbox:
 *           "workspace-write"`. That pairing is what closes the "review seat
 *           can't run tests, everything ends up Not-checked" gap — test
 *           tooling can write build/test caches inside the worktree, while
 *           the worktree boundary (not this repo's main checkout) contains
 *           the blast radius. `read_only: true` can still be set alongside
 *           it: it independently gates this client's own fs/write_text_file
 *           RPC handler and permission-request auto-decline (see
 *           acp-client.ts CP5) — a second belt, not a substitute for the
 *           worktree boundary.
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
  /** Whether the CLI exposes a mid-strictness native sandbox tier (see CodexSandboxMode). */
  sandbox: boolean;
}

const CAPS: Record<LaneName, LaneCapabilities> = {
  codex: { model: true, effort: true, nativeReadOnly: true, sandbox: true },
  opencode: { model: true, effort: false, nativeReadOnly: false, sandbox: false },
  grok: { model: true, effort: true, nativeReadOnly: false, sandbox: false },
};

/**
 * Maps the public `sandbox` option (CodexSandboxMode, mirroring codex-acp's
 * own sandboxMode labels) onto codex-acp's INITIAL_AGENT_MODE id. See the
 * file header for the codex-acp 1.1.2 source verification.
 */
const SANDBOX_TO_AGENT_MODE: Record<string, string> = {
  "read-only": "read-only",
  "workspace-write": "agent",
  "danger-full-access": "agent-full-access",
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
  if (opts.sandbox && !caps.sandbox) {
    warnings.push(`lane '${lane}' does not support sandbox override; ignoring sandbox='${opts.sandbox}'`);
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
      // opts.sandbox (workspace-write middle tier) takes precedence when set;
      // otherwise unchanged legacy behavior derived from readOnly.
      const agentMode = opts.sandbox
        ? (SANDBOX_TO_AGENT_MODE[opts.sandbox] ?? (opts.readOnly ? "read-only" : "agent-full-access"))
        : opts.readOnly
          ? "read-only"
          : "agent-full-access";
      env.INITIAL_AGENT_MODE = agentMode;
      return {
        command: "npx",
        args: ["-y", `@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}`],
        env,
        warnings,
      };
    }
  }
}
