/**
 * Lane registry — the single source of truth for how each external lane is
 * spawned as an ACP agent, and how model / effort / read-only map onto that
 * lane's real CLI surface.
 *
 * Mechanisms below were derived from the installed CLIs' `--help` output and
 * the codex-acp package README (2026-07-06):
 *
 * - grok    `grok --sandbox <read-only|workspace> --permission-mode default
 *           --no-subagents agent --no-leader [--model M]
 *           [--reasoning-effort E] stdio`. The top-level safety flags must
 *           precede `agent`; model + effort belong after `agent`. Clanker
 *           never inherits Grok's user-level `always-approve` or shared
 *           leader settings. The native sandbox is the filesystem boundary;
 *           ACP permission rejection remains a second layer.
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
 * - codex   `@agentclientprotocol/codex-acp` as a pinned build dependency,
 *           packaged into each plugin as a self-contained `dist/codex-acp.mjs`
 *           sidecar and spawned directly with Node instead of
 *           `npx -y @agentclientprotocol/codex-acp`. npx's cold-start
 *           registry/package resolution measured ~35s per lane spawn
 *           (reproduced 2026-07-17); the packaged bridge handshake comes back
 *           in ~1s and remains resolvable after plugin managers copy only the
 *           plugin directory into their caches. Source/tsc development falls
 *           back to the pinned package in the repository's node_modules. The
 *           package is installed with `--ignore-scripts` to skip its own
 *           `@openai/codex` dependency's postinstall (which downloads a
 *           ~178MB bundled Codex binary we don't need); CODEX_PATH below
 *           points codex-acp at the system's already-installed `codex`
 *           instead of that bundled copy. Model + reasoning effort still go
 *           via CODEX_CONFIG (JSON merged into the Codex session config:
 *           {"model":...,"model_reasoning_effort":...}); sandbox strictness
 *           via INITIAL_AGENT_MODE. Verified against the codex-acp 1.1.2
 *           source (src/AgentMode.ts): three modes exist, not two —
 *           `read-only` (readOnly sandbox, no writes at all), `agent`
 *           (workspaceWrite sandbox: writes boxed to the session cwd + tmp —
 *           this is the middle tier `opts.sandbox="workspace-write"` maps
 *           to), and `agent-full-access` (dangerFullAccess: writes anywhere,
 *           no sandbox). Without an explicit `opts.sandbox`, behavior is
 *           safe by default: `readOnly ? "read-only" : "agent"`. Full access
 *           is available only through an explicit danger-full-access override.
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
 *           codex-acp's version is pinned in package.json (exact, not `^`),
 *           not via a runtime npx `@version` arg — see the 2026-07-13
 *           version-drift incident note in the git history for why an
 *           unpinned version is unacceptable (an unpinned release silently
 *           picked up the reserved collaboration.spawn_agent schema above).
 *           Bumping codex-acp is an explicit `npm i --save
 *           @agentclientprotocol/codex-acp@<version>`, reviewed like any
 *           other dependency bump, followed by `npm run smoke -- codex` (and
 *           a sol-model-override smoke) before trusting the new version.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isGlmModel, resolveOcModel } from "./constants.js";
import type { LaneName, LaneRequestOptions, SpawnSpec } from "./types.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Installed plugins carry a self-contained codex-acp sidecar next to the MCP
 * bundle because plugin managers copy the plugin directory without the repo's
 * node_modules. Source and tsc development keep a local-package fallback.
 */
function resolveCodexAcpEntry(): string {
  const packagedEntry = fileURLToPath(new URL("./codex-acp.mjs", import.meta.url));
  if (fs.existsSync(packagedEntry)) return packagedEntry;
  const pkgJsonPath = nodeRequire.resolve("@agentclientprotocol/codex-acp/package.json");
  return path.join(path.dirname(pkgJsonPath), "dist", "index.js");
}

/**
 * Resolve the real `codex` CLI binary from PATH ourselves, rather than pass
 * the bare string "codex" through and let codex-acp's own internal spawn
 * resolve it. `codex` on this machine (and possibly others) is a zsh
 * *alias* (`codex --dangerously-bypass-approvals-and-sandbox`) — irrelevant
 * to `child_process.spawn` without `shell: true` (which neither Clanker's
 * nor codex-acp's spawn calls use), but codex-acp's own PATH lookup depends
 * on whatever PATH the Clanker MCP server process happened to inherit,
 * which the acp-client.ts PATH-prepend comment already flags as sometimes
 * minimal. Resolving the absolute path here, in the same process that
 * builds the spawn spec, removes that indirection.
 */
function resolveSystemCodexPath(): string {
  const searchPath = process.env.PATH ?? "";
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "codex");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here, keep looking */
    }
  }
  // Nothing executable found on PATH; fall back to the bare name so
  // codex-acp's own resolution gets a chance (and the failure, if any, is
  // codex-acp's ENOENT rather than us silently swallowing it here).
  return "codex";
}

interface LaneCapabilities {
  model: boolean;
  effort: boolean;
  /** Whether the CLI exposes a mid-strictness native sandbox tier (see CodexSandboxMode). */
  sandbox: boolean;
  /** Whether the CLI can select a named agent/profile (see LaneRequestOptions.agent). */
  agent: boolean;
}

const CAPS: Record<LaneName, LaneCapabilities> = {
  codex: { model: true, effort: true, sandbox: true, agent: false },
  // opencode's `agent` capability is retired as of the clanker-worker isolation
  // fix below: the worker's identity and permission set are fixed by Clanker,
  // not caller-selectable, so a caller-supplied `opts.agent` now just warns
  // (see the file header MERGE NOTE for why this couldn't be a silent merge).
  opencode: { model: true, effort: false, sandbox: false, agent: false },
  grok: { model: true, effort: true, sandbox: false, agent: false },
};

/**
 * Per-lane environment variables that must come from the vault (OS
 * keychain), never the ambient process environment, and therefore force the
 * spawned command through `tachi vault exec` (see wrapWithVaultExec below).
 * codex and grok authenticate via their own OAuth login state — Clanker
 * never holds a long-lived secret for them, so both declare an empty list.
 * opencode is model-dependent (most models it serves are also OAuth-backed
 * through opencode's own credential store); only the GLM lane authenticates
 * with a bare API key, so its requiredEnv is resolved per-request in
 * opencodeRequiredEnv rather than declared statically here.
 */
const REQUIRED_ENV: Record<Exclude<LaneName, "opencode">, string[]> = {
  codex: [],
  grok: [],
};

/** GLM is the only normal opencode lane that needs a vault-sourced secret. */
function opencodeRequiredEnv(model: string | undefined): string[] {
  return isGlmModel(model) ? ["ZHIPUAI_API_KEY"] : [];
}

/**
 * Rewrite a spawn command to run under `tachi vault exec --keychain
 * --require <vars> -- <original command> <original args>` when the lane
 * declares required env vars, so the secret is materialized from the OS
 * keychain into the child's environment at spawn time instead of living in
 * Clanker's (or the ambient shell's) own environment. `tachi` resolves via
 * PATH, same as every other lane binary here. An empty requiredEnv list is
 * a no-op — the returned spec is unchanged, so every existing OAuth lane's
 * spawn command stays byte-for-byte identical to before this wiring.
 */
function wrapWithVaultExec(spec: SpawnSpec, requiredEnv: string[]): SpawnSpec {
  if (requiredEnv.length === 0) return spec;
  return {
    ...spec,
    command: "tachi",
    args: ["vault", "exec", "--keychain", "--require", requiredEnv.join(","), "--", spec.command, ...spec.args],
  };
}

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
      // OpenCode flattens every injected MCP tool to `${server}_${tool}` and
      // matches the permission globs against those concrete names before the
      // LLM request (session/tools.ts -> permission/index.ts). Denying that
      // namespace is what actually closes the door: a read-only lane was
      // observed calling `tachi_task` (it really spawned a claude dispatch)
      // and `tachi_skill`, because `task`/`skill` below only ever matched the
      // NATIVE tools of those exact names. Native tools are all compact
      // lowercase — bash/read/glob/grep/edit/write/webfetch/todowrite — so
      // this costs the worker nothing (`apply_patch` and the MCP resource
      // helpers are normalized to `edit`/`read` before the glob runs).
      // Do NOT "simplify" this to `mcp: {}` in the config: configs deep-merge,
      // so an empty mcp object removes no ambient server. This is the fix.
      "*_*": "deny",
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

function opencodeKimiCrewAgent() {
  return {
    description: "Kimi Crew lead for one OpenCode-native implementation and review session.",
    mode: "primary",
    permission: {
      "*_*": "deny",
      task: {
        "*": "deny",
        "worker-glm": "allow",
        "reviewer-deepseek": "allow",
        oracle: "allow",
      },
      skill: "deny",
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
      edit: "deny",
      // The lead needs git inspection and direct verification. This is not a
      // hard read-only profile or shell sandbox: the managed worktree is the
      // expected cwd, while bash itself remains trusted.
      bash: "allow",
    },
    prompt: [
      "You are Kimi Crew. Lead the supplied task through the existing OpenCode agent profiles.",
      "Prefer worker-glm for implementation, use reviewer-deepseek for cold review, and call oracle only when risk or evidence warrants it.",
      "Use shell access to inspect Git, understand the repository, and verify the integrated result when useful.",
      "Personally adjudicate the agents' findings, require verification evidence, and return concrete evidence and remaining concerns.",
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
      // Grok can authorize tools locally without asking the ACP client. Its
      // user config on this machine is intentionally permissive for
      // interactive work, so Clanker must override that state explicitly.
      // Keep top-level flags before `agent`; the Grok CLI parser does not
      // accept them on the agent subcommand.
      const args = [
        "--sandbox",
        opts.readOnly === true ? "read-only" : "workspace",
        "--permission-mode",
        "default",
        "--no-subagents",
        "agent",
        "--no-leader",
        "--model",
        opts.model ?? "grok-4.5",
      ];
      if (opts.effort) args.push("--reasoning-effort", opts.effort);
      args.push("stdio");
      return wrapWithVaultExec({ command: "grok", args, env, warnings }, REQUIRED_ENV.grok);
    }

    case "opencode": {
      // Fail closed: without an explicit model, opencodeRequiredEnv(undefined)
      // below returns [] and wrapWithVaultExec becomes a no-op, while the
      // actual model that runs is decided by opencode's own config default —
      // which this process does not control and cannot assume is non-GLM.
      // That combination silently spawns a key-bearing lane outside the
      // vault-exec credential wrap (found by codex cold review, run
      // codex-2db38). Every buildSpawnSpec caller (tools/run/adapters) is
      // routed through here, so the guard covers all of them, read-only
      // included.
      if (!opts.model?.trim()) {
        throw new Error(
          "opencode lane requires an explicit model id — omitting it would let opencode's own config default (possibly GLM) run outside the vault-exec credential wrap",
        );
      }
      const args = ["acp"];
      // Shortnames (glm/ds/kimi/free) resolve to full provider/model ids from the
      // single source in constants.ts; full ids pass through unchanged.
      const model = resolveOcModel(opts.model);
      // NOTE (rebase merge resolution): main's `opts.agent` (caller-selected
      // default_agent) is intentionally NOT honored here — see the file
      // header MERGE NOTE. The clanker-worker identity below is fixed.
      const profile = opts.kimiCrew ? "clanker-kimi-crew" : "clanker-worker";
      const agent = opts.kimiCrew
        ? { [profile]: opencodeKimiCrewAgent() }
        : { [profile]: opencodeClankerAgent(opts.readOnly === true) };
      const config: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        default_agent: profile,
        agent,
      };
      if (model) config.model = model;

      const cfgPath = path.join(runDir, "opencode-config.json");
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
      env.OPENCODE_CONFIG = cfgPath;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      if (!opts.kimiCrew) {
        // The isolated generic worker must not ingest the interactive
        // Claude/Codex skill layer from ~/.claude or ~/.agents. Kimi Crew is
        // intentionally different: its installed child profiles retain their
        // original prompts, skills, and permissions under OpenCode's merge.
        env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
        env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
      }
      const requiredEnv = opts.kimiCrew
        ? ["KIMI_API_KEY", "ZHIPUAI_API_KEY"]
        : opencodeRequiredEnv(opts.model);
      return wrapWithVaultExec({ command: "opencode", args, env, warnings }, requiredEnv);
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
      // otherwise writes default to the cwd-boxed workspace tier.
      const agentMode = opts.sandbox
        ? (SANDBOX_TO_AGENT_MODE[opts.sandbox] ?? (opts.readOnly ? "read-only" : "agent"))
        : opts.readOnly
          ? "read-only"
          : "agent";
      env.INITIAL_AGENT_MODE = agentMode;
      // CODEX_PATH tells codex-acp which `codex` binary to spawn for its
      // app-server. We install codex-acp with --ignore-scripts (see file
      // header), so its own bundled @openai/codex copy was never
      // downloaded — CODEX_PATH is load-bearing, not an optional override.
      env.CODEX_PATH = resolveSystemCodexPath();
      return wrapWithVaultExec(
        { command: process.execPath, args: [resolveCodexAcpEntry()], env, warnings },
        REQUIRED_ENV.codex,
      );
    }
  }
}
