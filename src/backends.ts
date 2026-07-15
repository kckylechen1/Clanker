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
 * - opencode `opencode acp` — no model or agent flag on the acp subcommand.
 *           A per-run config selects the model (when requested) and an inline
 *           `clanker-worker` primary agent, keeping Clanker's ACP worker
 *           contract out of the user's normal opencode configuration. The
 *           same JSON is supplied through OPENCODE_CONFIG_CONTENT because
 *           project config loads after OPENCODE_CONFIG and could otherwise
 *           replace the selected agent or weaken its permissions.
 *           opencode has no ACP-mode reasoning-effort knob (that is the
 *           `--variant` run flag), so effort warns.
 *
 *           MERGE NOTE (rebase of fix/codex-acp-local-dep-bypass-npx onto
 *           main, 2026-07-18): main separately grew a caller-supplied
 *           `LaneRequestOptions.agent` (a named opencode agent-profile
 *           override via `default_agent`, e.g. a markdown profile under
 *           `~/.config/opencode/agents/<name>.md`) before this isolation
 *           commit existed. This isolation commit's own fixed `clanker-worker`
 *           contract is a security fix for an observed incident (a read-only
 *           lane reaching `tachi_task`/`tachi_skill`), so a caller-chosen
 *           `default_agent` overriding it here would silently reopen exactly
 *           that hole. This rebase resolution keeps the isolation
 *           non-bypassable and treats opencode's `agent` capability as
 *           retired (CAPS.opencode.agent = false; a request that sets
 *           `opts.agent` for opencode now just warns and is ignored, same as
 *           any other unsupported-capability request). That is a judgment
 *           call made during conflict resolution, not a verified product
 *           decision — flag for explicit sign-off before this lands.
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
 *           codex-acp only starts Codex in `app-server` mode (never `exec`),
 *           and app-server registers a `collaboration.spawn_agent` tool
 *           whenever the (currently "under development") multi_agent_v2
 *           feature is on — reproduced 2026-07-13 as a turn-1, zero-tool-call
 *           HTTP 400 ("Function 'collaboration.spawn_agent' is reserved for
 *           use by this model and must match the configured schema") on both
 *           the default and sol-override codex lanes; `codex exec` with the
 *           same model + same global config was unaffected, confirming the
 *           break is app-server-specific, not a Clanker- or model-side bug.
 *           Every Clanker codex dispatch is solo by contract (no delegation,
 *           no sub-agent fan-out), so this tool is dead weight for us even
 *           when it's healthy. Disable multi_agent_v2 for Clanker's own
 *           session config only — this does not touch the shared
 *           ~/.codex/config.toml default (owner may still want it on for
 *           interactive sessions) and forecloses the whole reserved-schema
 *           failure class for Clanker regardless of upstream cause.
 *
 *           The npx spec is version-pinned, not `@latest`. 2026-07-13 incident
 *           precedent: an unpinned `@latest` silently picked up a codex-acp
 *           release whose app-server mode registered the same reserved
 *           `collaboration.spawn_agent` tool, breaking every codex dispatch
 *           with a turn-1 400 that nobody could pin to a code change because
 *           the dependency itself had moved under us. Upgrading codex-acp is
 *           now an explicit, reviewable act: bump `CODEX_ACP_VERSION` below
 *           and run `npm run smoke -- codex` (and a sol-model-override smoke)
 *           before trusting the new version.
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
  /** Whether the CLI can select a named agent/profile (see LaneRequestOptions.agent). */
  agent: boolean;
}

const CAPS: Record<LaneName, LaneCapabilities> = {
  codex: { model: true, effort: true, nativeReadOnly: true, sandbox: true, agent: false },
  // opencode's `agent` capability is retired as of the clanker-worker isolation
  // fix below: the worker's identity and permission set are fixed by Clanker,
  // not caller-selectable, so a caller-supplied `opts.agent` now just warns
  // (see the file header MERGE NOTE for why this couldn't be a silent merge).
  opencode: { model: true, effort: false, nativeReadOnly: false, sandbox: false, agent: false },
  grok: { model: true, effort: true, nativeReadOnly: false, sandbox: false, agent: false },
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

function opencodeClankerAgent(readOnly: boolean) {
  return {
    description: "Dedicated OpenCode ACP worker controlled by Clanker.",
    mode: "primary",
    permission: {
      task: "deny",
      skill: "deny",
      external_directory: "deny",
      edit: readOnly ? "deny" : "allow",
      bash: readOnly ? "deny" : "allow",
    },
    prompt: [
      "You are a Clanker-controlled OpenCode ACP worker.",
      "Execute only the exact task supplied by the parent in the provided working directory.",
      "Clanker owns the session lifecycle, workspace or worktree selection, cancellation, and progress reporting.",
      "Never spawn or delegate to subagents, load skills, access paths outside the current worktree, create or switch worktrees, or attempt to manage Clanker itself.",
      "Return concrete results, changed files, verification evidence, and any remaining risk to the parent.",
    ].join("\n"),
  } as const;
}

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
  if (opts.agent && !caps.agent) {
    warnings.push(`lane '${lane}' does not support agent profile override; ignoring agent='${opts.agent}'`);
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
      // NOTE (rebase merge resolution): main's `opts.agent` (caller-selected
      // default_agent) is intentionally NOT honored here — see the file
      // header MERGE NOTE. The clanker-worker identity below is fixed.
      const config: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        default_agent: "clanker-worker",
        agent: { "clanker-worker": opencodeClankerAgent(opts.readOnly === true) },
      };
      if (model) config.model = model;

      const cfgPath = path.join(runDir, "opencode-config.json");
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
      env.OPENCODE_CONFIG = cfgPath;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      // Clanker's worker has its own fixed contract and must not ingest the
      // interactive Claude/Codex skill layer from ~/.claude or ~/.agents.
      // The public compatibility flag suppresses .claude; 1.17.x's narrower
      // external-skills flag also suppresses .agents. `permission.skill=deny`
      // above remains the enforcement fallback if discovery behavior changes.
      env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
      env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
      return { command: "opencode", args, env, warnings };
    }

    case "codex": {
      // Clanker dispatches are always solo (no delegation, no sub-agent
      // fan-out) — never advertise Codex's own multi-agent collaboration
      // tool into these sessions. See the file header for why this is also
      // a live-incident guard, not just an unused-capability trim.
      const codexConfig: Record<string, unknown> = {
        features: { multi_agent_v2: { enabled: false } },
      };
      if (opts.model) codexConfig.model = opts.model;
      if (opts.effort) codexConfig.model_reasoning_effort = opts.effort;
      env.CODEX_CONFIG = JSON.stringify(codexConfig);
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
