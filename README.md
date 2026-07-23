# Clanker

Universal stdio MCP runtime with separate thin Claude Code and Codex adapters for running external coding agents over ACP. Host identity is injected explicitly with `--host claude|codex`; standalone startup defaults to `standalone` and preserves all lanes.

Clanker exposes these slash commands:

| Command | Backend |
|---|---|
| `/clanker:codex <task>` | Codex ACP |
| `/clanker:gemini <task>` | Clanker: Gemini read-only reconnaissance and grounded research |
| `/clanker:grok <task>` | Grok ACP (`grok-4.5` by default; Composer 2.5 is a separate model) |
| `/clanker:glm <task>` | Opencode with GLM |
| `/clanker:deepseek <task>` | Opencode with DeepSeek |
| `/clanker:kimi <task>` | Opencode with Kimi |
| `/clanker:free <task>` | Opencode free model |
| `/clanker:oc <provider/model> <task>` | Advanced Opencode model override (`composer` and `grok45` remain distinct aliases) |
| `/clanker:kimi-crew <task>` | Kimi Crew: one Kimi-led OpenCode session using existing OpenCode agents |

Default mode is background: the Claude `Agent` task owns the visible bottom task row, while the MCP server owns the ACP backend process. Use `--wait` to run foreground. Read-only commands use mechanically read-only lane relays. Non-GLM writes use `clanker:writer`; GLM writes alone use Sonnet `clanker:supervisor`. Every write runs in a mandatory managed worktree.

`/clanker:kimi-crew` is deliberately thin: Clanker starts and monitors one Kimi/OpenCode ACP session. OpenCode's existing global profiles perform GLM implementation (`worker-glm`), DeepSeek cold review (`reviewer-deepseek`), and optional Sol/oracle analysis. Kimi leads, inspects the repository, and verifies results; Clanker does not own a deterministic workflow or copy those profiles into this repository. Direct GLM writes still use the Sonnet supervisor; inside Kimi Crew, Kimi is the intentional supervisor for its GLM worker.

`/clanker:gemini` is workspace-read-only research. It always runs in plan mode inside a sandbox, cannot enter a Clanker write path, and uses the locally authenticated Gemini CLI state. The lane currently requires macOS `/usr/bin/sandbox-exec` and fails closed elsewhere; the sidecar denies writes beneath the inspected workspace while allowing Antigravity to maintain its own conversation and plan scratch outside that workspace. `agy` is an internal executor detail, not the product name or a credential surface. The default model is `gemini-3.6-flash-medium`; model and effort may be overridden.

## Layout

```text
.
├── .claude-plugin/marketplace.json
├── .agents/plugins/marketplace.json
├── plugin/
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json
│   ├── agents/
│   ├── commands/
│   ├── skills/using-clanker/SKILL.md
│   └── dist/clanker-mcp.mjs
├── codex-plugin/
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── skills/using-clanker/SKILL.md
│   └── dist/clanker-mcp.mjs
├── src/
├── test/
├── scripts/
└── package.json
```

## Install adapters

```bash
claude plugin marketplace add /Users/kckylechen/Projects/Clanker
claude plugin install clanker@clanker
```

Then restart Claude Code or run `/reload-plugins`.

Install the separate Codex adapter from the same repository marketplace:

```bash
codex plugin marketplace add /Users/kckylechen/Projects/Clanker
codex plugin add clanker@clanker
```

Start a new Codex session after installation. The Codex MCP starts with `cwd: "."` and `--host codex` (Codex does not interpolate `${PLUGIN_ROOT}`). Under Codex, Clanker exposes `opencode`, `grok`, and the external read-only `gemini` lane: the `codex` lane is absent from schemas and is hard-blocked before run creation. The dedicated GLM-write tool is also absent because GLM writes require the Claude/Sonnet supervisor; generic GLM writes remain loud errors. Native Sol/Luna/Terra/5.5 orchestration stays native V1.

The active Claude config should point here:

```json
"enabledPlugins": {
  "clanker@clanker": true
},
"extraKnownMarketplaces": {
  "clanker": {
    "source": {
      "source": "directory",
      "path": "/Users/kckylechen/Projects/Clanker"
    }
  }
}
```

## Development

```bash
npm ci
npm run bundle
npm test
npm run typecheck
```

`npm run bundle` writes byte-identical MCP bundles to `plugin/dist/clanker-mcp.mjs` and
`codex-plugin/dist/clanker-mcp.mjs`, plus byte-identical self-contained
`dist/codex-acp.mjs` and `dist/gemini-acp.mjs` sidecars. The sidecars keep those lanes runnable after either plugin
manager copies only its adapter directory into the install cache without repository `node_modules`.

### Smoke — canary a lane before a real batch

```bash
npm run smoke                       # full regression battery: all 4 lanes, "Reply DONE"
npm run smoke -- codex              # single-lane canary: one 1-turn "Reply PONG" dispatch
npm run smoke -- codex gpt-5.6-sol  # canary a model override on that lane (e.g. the sol path)
```

Run the single-lane canary before dispatching a real batch to a lane — it catches a dead/misconfigured
lane (auth expired, CLI missing, backend rejecting the request shape) in ~20-30s instead of discovering
it after burning a real dispatch.

## Runtime Config

| Env | Default | Meaning |
|---|---|---|
| `CLANKER_STALL_THRESHOLD_MS` | `300000` | Silence before a running turn is flagged as suspected stalled. |
| `CLANKER_TURN_TIMEOUT_MS` | `2700000` | Hard per-turn ceiling before the subprocess is killed and the turn becomes `error`. |
| `CLANKER_HANDSHAKE_TIMEOUT_MS` | `30000` | ACP initialize + session/new timeout. |
| `CLANKER_CANCEL_GRACE_MS` | `5000` | Cooperative ACP cancellation grace before forced process termination. |
| `CLANKER_PROCESS_TERM_GRACE_MS` | `2000` | SIGTERM grace before SIGKILL escalation. |
| `CLANKER_CAPACITY_RETRY_BACKOFF_MS` | `30000` | Backoff before the single automatic retry of a capacity-transient first-turn failure ("model at capacity" / overloaded / 5xx). Never applies to a CLANKER-INFRA-FAILURE-tagged failure. |
| `CLANKER_SESSION_TTL_MS` | `600000` | Idle session TTL before reaping. |
| `CLANKER_WAIT_DEFAULT_MS` / `CLANKER_WAIT_MAX_MS` | `30000` / `55000` | `clanker_wait` long-poll default and cap. |
| `CLANKER_PROGRESS_EXPERIMENTAL` | unset | `=1` enables MCP progress notifications. |
| `CLANKER_MCP_BASE_REPO` | server cwd | Base repo for managed worktrees. |
| `CLANKER_RUNS_ROOT` / `CLANKER_WORKTREES_ROOT` | `~/.cache/clanker/{runs,worktrees}` | Artifact and managed worktree roots. |

Each run atomically persists protocol/config-only `telemetry.json` in its run directory. Terminal
`clanker_wait` and `clanker_status` expose the same compact telemetry; prompts, messages, thoughts,
secrets, and arbitrary ACP `_meta` are never recorded as telemetry. `prompt_usage` is turn-local and
resets when a new turn begins. `session_usage` is the latest ACP session context (`used` tokens out of
`size`) and cumulative session cost; it persists across turns together with observed model/effort.
Telemetry also records `host`, `requested_lane`, and `actual_lane`. Successful runs never substitute lanes, so requested and actual are equal. A normal MCP request for a host-blocked lane fails against the filtered lane schema before dispatch. The handler still returns `actual_lane: null` plus a loud `blocked_reason` if a stale or in-process caller bypasses schema validation, and the manager independently rejects the lane before run creation. Neither refusal path records the prompt.
