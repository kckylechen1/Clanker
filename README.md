# Clanker

Claude Code plugin + stdio MCP server for running external coding agents as Claude-owned background tasks.

Clanker exposes these slash commands:

| Command | Backend |
|---|---|
| `/clanker:codex <task>` | Codex ACP |
| `/clanker:grok <task>` | Grok ACP |
| `/clanker:glm <task>` | Opencode with GLM |
| `/clanker:deepseek <task>` | Opencode with DeepSeek |
| `/clanker:kimi <task>` | Opencode with Kimi |
| `/clanker:free <task>` | Opencode free model |
| `/clanker:oc <provider/model> <task>` | Advanced Opencode model override |

Default mode is background: the Claude `Agent` task owns the visible bottom task row, while the MCP server owns the ACP backend process. Use `--wait` to run foreground.

## Layout

```text
.
├── .claude-plugin/marketplace.json
├── plugin/
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json
│   ├── agents/
│   ├── commands/
│   └── dist/clanker-mcp.mjs
├── src/
├── test/
├── scripts/
└── package.json
```

## Install

```bash
claude plugin marketplace add /Users/kckylechen/Projects/Clanker
claude plugin install clanker@clanker
```

Then restart Claude Code or run `/reload-plugins`.

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

`npm run bundle` writes `plugin/dist/clanker-mcp.mjs`, the self-contained server bundle Claude loads from its plugin cache.

### Smoke — canary a lane before a real batch

```bash
npm run smoke                       # full regression battery: all 3 lanes, "Reply DONE"
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
| `CLANKER_CAPACITY_RETRY_BACKOFF_MS` | `30000` | Backoff before the single automatic retry of a capacity-transient first-turn failure ("model at capacity" / overloaded / 5xx). Never applies to a CLANKER-INFRA-FAILURE-tagged failure. |
| `CLANKER_SESSION_TTL_MS` | `600000` | Idle session TTL before reaping. |
| `CLANKER_WAIT_DEFAULT_MS` / `CLANKER_WAIT_MAX_MS` | `30000` / `55000` | `clanker_wait` long-poll default and cap. |
| `CLANKER_PROGRESS_EXPERIMENTAL` | unset | `=1` enables MCP progress notifications. |
| `CLANKER_MCP_BASE_REPO` | server cwd | Base repo for managed worktrees. |
| `CLANKER_RUNS_ROOT` / `CLANKER_WORKTREES_ROOT` | `~/.cache/clanker/{runs,worktrees}` | Artifact and managed worktree roots. |
