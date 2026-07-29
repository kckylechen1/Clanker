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
 *           `profile="kimi-crew"` is the one exception: it selects a named
 *           profile installed and owned by OpenCode, while Clanker keeps
 *           process and workspace lifecycle ownership.
 *           opencode has no ACP-mode reasoning-effort knob (that is the
 *           `--variant` run flag), so effort warns.
 * - cursor  `cursor-agent --print --output-format stream-json` is not ACP, but
 *           it is a real event stream, so the lane ships its own sidecar
 *           (`src/cursor-acp.ts`, bundled to `dist/cursor-acp.mjs`) that
 *           projects those events onto ACP updates — the same trick the gemini
 *           lane plays on `agy`. Everything the lane needs is passed through
 *           the sidecar's environment: CLANKER_CURSOR_MODE (the read/write
 *           boundary), CLANKER_CURSOR_MODEL, CLANKER_CURSOR_AGENT_PATH, an
 *           optional CLANKER_CURSOR_PRINT_TIMEOUT, and — on a correction turn
 *           only — CLANKER_CURSOR_RESUME, the chat id this run reported
 *           earlier, which makes the respawn continue that conversation
 *           (including on a different model, #43). Auth is Cursor's own login
 *           state under ~/.cursor, like opencode's credential store — Clanker
 *           holds nothing.
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CURSOR_MODEL,
  LANES_WITH_RESUME,
  isGlmModel,
  resolveCursorModel,
  resolveOcModel,
} from "./constants.js";
import { resolveGrokHome } from "./grok-diagnostics.js";
import { resolveNodeBinary } from "./node-binary.js";
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

function resolveGeminiAcpEntry(): string {
  const candidates = [
    fileURLToPath(new URL("./gemini-acp.mjs", import.meta.url)),
    fileURLToPath(new URL("./gemini-acp.js", import.meta.url)),
    fileURLToPath(new URL("../plugin/dist/gemini-acp.mjs", import.meta.url)),
  ];
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  if (entry) return entry;
  throw new Error("Gemini ACP sidecar is missing; run `npm run bundle` before dispatching Clanker: Gemini");
}

function resolveCursorAcpEntry(): string {
  const candidates = [
    fileURLToPath(new URL("./cursor-acp.mjs", import.meta.url)),
    fileURLToPath(new URL("./cursor-acp.js", import.meta.url)),
    fileURLToPath(new URL("../plugin/dist/cursor-acp.mjs", import.meta.url)),
  ];
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  if (entry) return entry;
  throw new Error("Cursor ACP sidecar is missing; run `npm run bundle` before dispatching Clanker: Cursor");
}

function isGeminiModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gemini-");
}

function requireGeminiWorkspaceSandbox(): void {
  if (process.platform !== "darwin") {
    throw new Error("Clanker: Gemini currently requires macOS sandbox-exec for a fail-closed workspace read-only boundary");
  }
  try {
    fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
  } catch {
    throw new Error("Clanker: Gemini requires executable /usr/bin/sandbox-exec for a fail-closed workspace read-only boundary");
  }
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
 *
 * Which `codex` this actually finds differs by context, and that
 * difference is load-bearing (#39): an *installed plugin* ships only its
 * bundled `codex-acp.mjs` sidecar, no repo `node_modules/`, so this walk
 * lands on the operator's real PATH entry (the system-installed `codex`,
 * kept current independently of this repo). Running from source under
 * `npm run <script>` / `npx` is different — npm prepends the repo's own
 * `node_modules/.bin` to PATH for the child process, and `npm install`
 * hoists `@openai/codex` (codex-acp's pinned transitive dependency) into
 * `node_modules/.bin/codex`, which then shadows the real system binary
 * for exactly this search. So the pinned in-repo `@openai/codex` version
 * (see package.json's `@agentclientprotocol/codex-acp` pin) only matters
 * for `npm run smoke` / `npm test` and other source-tree runs, not for an
 * installed plugin in production — verified 2026-07-29 by comparing the
 * codex-acp app-server log's reported `codexPath` between a plain `node`
 * probe (resolved the host PATH binary) and `npm run smoke -- codex`
 * (resolved `<repo>/node_modules/.bin/codex` instead). A stale in-repo pin
 * therefore fails smoke/tests while production keeps working, which is
 * exactly the false-negative/false-positive split #39 hit.
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

function resolveSystemAgyPath(): string {
  return resolveLocalBinPath("agy");
}

/**
 * Resolve a user-installed CLI the same way for every lane that needs one:
 * PATH first, then `~/.local/bin` (where both `agy` and `cursor-agent` are
 * installed on this machine). The fallback matters because the PATH this MCP
 * server inherits is sometimes minimal — the hazard acp-client.ts's PATH
 * comment already flags. Returning the bare name when nothing is found keeps
 * the failure as the spawn's own ENOENT rather than a swallowed one here.
 */
function resolveLocalBinPath(binary: string): string {
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, binary)),
    path.join(os.homedir(), ".local", "bin", binary),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here, keep looking */
    }
  }
  return binary;
}

interface LaneCapabilities {
  model: boolean;
  effort: boolean;
  /** Whether the CLI exposes a mid-strictness native sandbox tier (see CodexSandboxMode). */
  sandbox: boolean;
}

const CAPS: Record<LaneName, LaneCapabilities> = {
  codex: { model: true, effort: true, sandbox: true },
  opencode: { model: true, effort: false, sandbox: false },
  grok: { model: true, effort: true, sandbox: false },
  gemini: { model: true, effort: true, sandbox: false },
  // cursor has no reasoning-effort flag at all: the effort tier is baked into
  // the model id (`gpt-5.3-codex-high` vs `-xhigh`), so an effort override has
  // nowhere to go and warns. Its `--sandbox enabled|disabled` is a boolean of
  // its own, not codex-acp's three-tier CodexSandboxMode, so it is not exposed
  // through that option either — the read-only lane sets it unconditionally.
  cursor: { model: true, effort: false, sandbox: false },
};

/**
 * Per-lane environment variables that must come from the vault (OS keychain),
 * never the ambient process environment, and therefore force the spawned
 * command through `tachi vault exec` (see wrapWithVaultExec below).
 * codex, grok and gemini authenticate via their own OAuth login state —
 * Clanker never holds a long-lived secret for them, so all three declare an
 * empty list. opencode is model-dependent (most models it serves are also
 * OAuth-backed through opencode's own credential store); only the GLM lane
 * authenticates with a bare API key, so its requiredEnv is resolved
 * per-request in opencodeRequiredEnv rather than declared statically here.
 */
const REQUIRED_ENV: Record<Exclude<LaneName, "opencode">, string[]> = {
  codex: [],
  grok: [],
  gemini: [],
  // Cursor holds its own login state under ~/.cursor (the observed init event
  // reports `apiKeySource: "login"`), so Clanker never carries a secret for it.
  cursor: [],
};

/** GLM is the only opencode-served model that needs a vault-sourced secret. */
function opencodeRequiredEnv(model: string | undefined): string[] {
  return isGlmModel(model) ? ["ZHIPUAI_API_KEY"] : [];
}

/**
 * Union of the lane/model-derived requirement and whatever the dispatch
 * profile declared (LaneRequestOptions.secrets). The model-derived rule is
 * authoritative on its own: a GLM spawn is wrapped because it is GLM, not
 * because some profile remembered to list the key — so a read-only GLM
 * dispatch through a profile that declares no secrets is still wrapped.
 */
function requiredEnvFor(lane: LaneName, opts: LaneRequestOptions): string[] {
  const base = lane === "opencode" ? opencodeRequiredEnv(opts.model) : REQUIRED_ENV[lane];
  return [...new Set([...base, ...(opts.secrets ?? [])])];
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
  // The resume capability is read from ONE table (constants.ts
  // LANES_WITH_RESUME), by both the manager's correction path and this
  // registry. A ref that reaches a lane which cannot resume must not vanish
  // silently: the caller would be told a correction continued a conversation
  // that in fact started from nothing.
  if (opts.resumeRef && !LANES_WITH_RESUME.has(lane)) {
    warnings.push(`lane '${lane}' cannot resume a backend session; ignoring resumeRef='${opts.resumeRef}'`);
  }

  switch (lane) {
    case "cursor": {
      // Mode IS the read/write boundary for this lane, so it is derived from
      // the welded readOnly and never taken from the caller. The one operator
      // degree of freedom is WHICH read-only mode: `plan` and `ask` are both
      // read-only in cursor-agent's own model, so honoring an override between
      // them cannot widen anything, while a write dispatch stays `write` and a
      // read-only one can never become it.
      const mode = opts.readOnly === true
        ? (process.env.CLANKER_CURSOR_MODE?.trim() === "plan" ? "plan" : "ask")
        : "write";
      env.CLANKER_CURSOR_MODE = mode;
      // Aliases resolve here, in the same place run.ts computes resolved_model
      // from, so telemetry and argv are one computation rather than two.
      env.CLANKER_CURSOR_MODEL = resolveCursorModel(opts.model) || DEFAULT_CURSOR_MODEL;
      env.CLANKER_CURSOR_AGENT_PATH =
        process.env.CLANKER_CURSOR_AGENT_PATH ?? resolveLocalBinPath("cursor-agent");
      // #43: a resume turn is a fresh spawn that continues Cursor's own chat.
      // Only the manager's resume path sets this, and only from an id this same
      // run reported earlier — never from anything a caller can name. The
      // sidecar refuses a flag-shaped value at the argv boundary, which is the
      // one place that boundary exists (same rule as `--model`).
      if (opts.resumeRef) env.CLANKER_CURSOR_RESUME = opts.resumeRef;
      // Only forward an EXPLICIT operator override. The per-mode defaults live
      // solely in cursor-acp.ts; shadowing them with a second default here
      // would mean the sidecar never sees the var unset and its own defaults
      // become dead code on the real dispatch path (#13).
      if (process.env.CLANKER_CURSOR_PRINT_TIMEOUT) {
        env.CLANKER_CURSOR_PRINT_TIMEOUT = process.env.CLANKER_CURSOR_PRINT_TIMEOUT;
      }
      return wrapWithVaultExec(
        // resolveNodeBinary(), not process.execPath: this server can outlive
        // the path it was launched from (#37).
        { command: resolveNodeBinary(), args: [resolveCursorAcpEntry()], env, warnings },
        requiredEnvFor(lane, opts),
      );
    }

    case "gemini": {
      if (opts.readOnly !== true) {
        throw new Error("Clanker: Gemini is reconnaissance-only and cannot run write-capable dispatches");
      }
      requireGeminiWorkspaceSandbox();
      // Load-bearing default: the Captain pins Gemini dispatches to the high
      // tier. gemini-acp.ts carries the same `|| "gemini-3.6-flash-high"`
      // fallback, but on this (the real dispatch) path line ~340 below always
      // sets CLANKER_GEMINI_MODEL, so the sidecar's fallback is dead code here
      // and only fires when the sidecar is run standalone. Keep the two in
      // sync — same shadowing hazard as #13 documents below.
      const model = opts.model?.trim() || "gemini-3.6-flash-high";
      if (!isGeminiModel(model)) {
        throw new Error(`Clanker: Gemini requires a Gemini model id; received '${model}'`);
      }
      const effort = opts.effort?.trim();
      if (effort && effort !== "medium" && effort !== "high") {
        throw new Error(`Clanker: Gemini effort must be 'medium' or 'high'; received '${effort}'`);
      }
      env.CLANKER_AGY_PATH = process.env.CLANKER_AGY_PATH ?? resolveSystemAgyPath();
      env.CLANKER_GEMINI_MODEL = model;
      // Role copy routing: the gemini lane shares one sidecar across the
      // gemini-recon / gemini-research profiles; the sidecar selects its
      // ROLE_PREFIX from this value and falls back to recon when unset.
      if (opts.geminiRole) env.CLANKER_GEMINI_ROLE = opts.geminiRole;
      // Only forward an explicit operator override. The default lives
      // solely in gemini-acp.ts's `|| "10m"` fallback — do not shadow it
      // with a second hardcoded default here, or the sidecar never sees
      // its env var "unset" and its own default becomes dead code on this
      // (the real dispatch) path. See issue #13.
      if (process.env.CLANKER_GEMINI_PRINT_TIMEOUT) {
        env.CLANKER_GEMINI_PRINT_TIMEOUT = process.env.CLANKER_GEMINI_PRINT_TIMEOUT;
      }
      if (effort) env.CLANKER_GEMINI_EFFORT = effort;
      return wrapWithVaultExec(
        // resolveNodeBinary(), not process.execPath: this server can outlive
        // the path it was launched from (#37).
        { command: resolveNodeBinary(), args: [resolveGeminiAcpEntry()], env, warnings },
        requiredEnvFor(lane, opts),
      );
    }

    case "grok": {
      // Grok can authorize tools locally without asking the ACP client. Its
      // user config on this machine is intentionally permissive for
      // interactive work, so Clanker must override that state explicitly.
      // Keep top-level flags before `agent`; the Grok CLI parser does not
      // accept them on the agent subcommand.
      //
      // Pin GROK_HOME explicitly (issue #9). The interactive `grok` command
      // on this machine is a shell function (`HOME=~/.grok-home
      // GROK_HOME=~/.grok command grok`) — execFile spawns the real `grok`
      // binary directly and never sees shell functions, so without this the
      // lane would run under the bare login HOME instead of the interactive
      // GROK_HOME, i.e. a different credential/config/log context than the
      // one the operator actually authenticated. Deliberately NOT touching
      // HOME itself: HOME affects far more than Grok's config resolution,
      // whereas Grok's own binary honors GROK_HOME (verified via `strings`
      // on the installed binary: "GROK_HOME | Override config directory
      // (default: `~/.grok`)") — so pinning just this one var reproduces the
      // interactive context without the wider blast radius of overriding
      // HOME. grok-diagnostics.ts's log tail reads this same resolved path
      // (resolveGrokHome), so the two must stay in sync.
      env.GROK_HOME = resolveGrokHome();
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
      return wrapWithVaultExec({ command: "grok", args, env, warnings }, requiredEnvFor(lane, opts));
    }

    case "opencode": {
      // Fail closed: without an explicit model, the actual model would be
      // selected by OpenCode's interactive config rather than this request.
      // Every caller is routed through here, so the guard also covers
      // read-only workers.
      if (!opts.model?.trim()) {
        throw new Error(
          "opencode lane requires an explicit model id — omitting it would let OpenCode's interactive default choose a different model",
        );
      }
      const args = ["acp"];
      // Shortnames (glm/ds/kimi/free) resolve to full provider/model ids from the
      // single source in constants.ts; full ids pass through unchanged.
      const model = resolveOcModel(opts.model);
      // Second half of the same fail-closed rule, and the ROOT CAUSE behind
      // #54 rather than the alarm for it.
      //
      // OpenCode's namespace has no bare model ids: `~/.cache/opencode/
      // models.json` is keyed provider-first (174 providers, every model under
      // one of them), so `gpt-5.6-sol` names nothing there while
      // `openai/gpt-5.6-sol` exists. Handing OpenCode an id it cannot resolve
      // does not make it fail — it makes it quietly pick something else, which
      // is precisely the swap the check above exists to prevent, arriving
      // through the door the check left open.
      //
      // The telemetry corpus separates the two cleanly (589 runs, read
      // 2026-07-29): of the opencode dispatches whose resolved id carried a
      // provider, 36 of 41 ran the model that was asked for; of the four whose
      // resolved id was bare, ZERO did. The same model in both spellings
      // settles it — `openai/gpt-5.6-luna` was honored (opencode-139d3) while
      // bare `gpt-5.6-luna` silently became `opencode/big-pickle`
      // (opencode-1f0e5). #54's own run is the fourth: bare `gpt-5.6-sol`
      // (run opencode-b3b5c, its opencode-config.json still on disk) came back
      // as `openai/gpt-5.6-terra-fast`.
      //
      // So refuse it here. A dispatch that cannot say which provider serves
      // the model has not named a model, and the honest failure is a refusal
      // at spawn — where the caller can fix the id — not a verdict filed
      // against a model that never ran.
      if (model && !model.includes("/")) {
        throw new Error(
          `opencode lane: model '${model}' names no provider, and OpenCode has no bare model ids — it would ` +
            `silently fall back to another model rather than fail. Use 'provider/${model}' ` +
            `(e.g. 'openai/${model}'); \`opencode models\` lists what this machine can reach.`,
        );
      }
      const profile = opts.profile === "kimi-crew" ? "kimi-crew" : "clanker-worker";
      const config: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        default_agent: profile,
      };
      if (opts.profile !== "kimi-crew") config.agent = { [profile]: opencodeClankerAgent(opts.readOnly === true) };
      if (model) config.model = model;

      const cfgPath = path.join(runDir, "opencode-config.json");
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
      env.OPENCODE_CONFIG = cfgPath;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      if (opts.profile !== "kimi-crew") {
        // The isolated generic worker must not ingest the interactive
        // Claude/Codex skill layer from ~/.claude or ~/.agents. Kimi Crew is
        // intentionally different: its installed child profiles retain their
        // original prompts, skills, and permissions under OpenCode's merge.
        env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
        env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
      }
      return wrapWithVaultExec({ command: "opencode", args, env, warnings }, requiredEnvFor(lane, opts));
    }

    case "codex": {
      // Clanker dispatches are always solo (no delegation, no sub-agent
      // fan-out) — never advertise Codex's own multi-agent collaboration
      // tool into these sessions. See the file header for why this is also
      // a live-incident guard, not just an unused-capability trim.
      const codexConfig: Record<string, unknown> = {
        features: { multi_agent_v2: { enabled: false } },
      };
      // Load-bearing default (not just "set a default"): if model/effort are
      // left unset here, codex-acp falls back to whatever the operator's own
      // `~/.codex/config.toml` says, and that file is outside Clanker's
      // control — an out-of-band edit there silently changes every dispatch
      // with zero signal. Explicit override still wins; only the fallback
      // is new. See DEFAULT_CODEX_MODEL/DEFAULT_CODEX_EFFORT in constants.ts.
      codexConfig.model = opts.model?.trim() || DEFAULT_CODEX_MODEL;
      codexConfig.model_reasoning_effort = opts.effort?.trim() || DEFAULT_CODEX_EFFORT;
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
        // resolveNodeBinary(), not process.execPath: this server can outlive
        // the path it was launched from (#37).
        { command: resolveNodeBinary(), args: [resolveCodexAcpEntry()], env, warnings },
        requiredEnvFor(lane, opts),
      );
    }
  }
}
