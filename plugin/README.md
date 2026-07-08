# Clanker — Claude Code plugin

Bundles the Clanker dispatch surface over ACP:

- **MCP server `clanker`** — declared in [`.mcp.json`](.mcp.json), launched as
  `node ${CLAUDE_PLUGIN_ROOT}/dist/clanker-mcp.mjs`. `dist/clanker-mcp.mjs` is a
  **self-contained esbuild bundle** of the server + its SDK deps. It is committed
  because plugin install copies the plugin directory to a cache and a plugin cannot
  reference files outside itself (so the server cannot live one level up). Regenerate
  it with `npm run bundle` from `/Users/kckylechen/Projects/Clanker` after changing `src/`.
- **Clankers** `codex` / `grok` / `oc` ([`agents/`](agents)) — haiku,
  zero-discretion long-poll relays. Each starts one `clanker_dispatch_start` and loops
  `clanker_wait` until the turn completes, returning only `final_message` + result fields.
  Their UI rows read `clanker:codex` / `clanker:grok` / `clanker:oc`.
- **Commands** `/clanker:codex`, `/clanker:grok`, `/clanker:glm`, `/clanker:deepseek`,
  `/clanker:kimi`, `/clanker:oc` ([`commands/`](commands)) —
  argument mapping preserved from the current habits (`--write` → `read_only:false`,
  `--background` / default mode → outer Agent `run_in_background`, oc model shortnames
  → full ids). The Claude `Agent` call is the visible lifecycle owner: it holds the
  Clanker task row while the MCP server only owns the ACP backend.

## Install (adjudicator runs these; the implementer does not touch user config)

The MCP bundle is committed, so no build step is required to install. From the repo,
with `<REPO>` the absolute repo root:

```bash
# 1. Register this repo's local marketplace (marketplace root = this project,
#    which contains .claude-plugin/marketplace.json listing the `clanker` plugin at ./plugin).
claude plugin marketplace add /Users/kckylechen/Projects/Clanker

# 2. Install the plugin from it.
claude plugin install clanker@clanker
```

Then restart Claude Code (or `/reload-plugins`) so the `clanker` MCP server and the
`/clanker:*` commands load. Approve the `clanker` MCP server when prompted (same per-server
approval as a project `.mcp.json`).

To uninstall later: `claude plugin uninstall clanker@clanker` and
`claude plugin marketplace remove clanker`.

**If you changed `src/`** first run `npm install && npm run bundle` in
`/Users/kckylechen/Projects/Clanker`, then `claude plugin marketplace update clanker` (or reinstall).

## Migration table (old → new)

| Old entrypoint | New entrypoint | Notes |
|---|---|---|
| `/codex:dispatch <task>` | `/clanker:codex <task>` | Claude-owned background Clanker task by default; use `--wait` to block |
| `/grok:dispatch <task>` | `/clanker:grok <task>` | |
| `/oc-dispatch glm <task>` | `/clanker:glm <task>` | fixed GLM Clanker |
| `/oc-dispatch ds <task>` | `/clanker:deepseek <task>` | fixed DeepSeek Clanker |
| `/oc-dispatch kimi <task>` | `/clanker:kimi <task>` | fixed Kimi Clanker |
| `/oc-dispatch <provider/model> <task>` | `/clanker:oc <provider/model> <task>` | advanced generic Clanker: Opencode |
| `~/bin/lane-run codex\|grok\|oc <prompt-file>` | `clanker_dispatch` / `clanker_dispatch_start` MCP tools (via the ignition agents) | typed call, no shell quoting |
| codex-companion (background poll) | Claude background Clanker wrapping `clanker_dispatch_start` + `clanker_wait` | task is visible under Claude Code, no shell notification dependency |

**The old plugins and `~/bin/lane-run` are left untouched during the observation
window.** They are retired only at Step 4 (spec §9), after this plugin has been
dogfooded for a week. Both sets of entrypoints can coexist meanwhile.

## Read-only and write isolation (the real safety boundary)

`read_only: true` (the default for `/clanker:*` without `--write`) is enforced at the
client layer: the server's `session/request_permission` handler declines any permissioned
operation (it never auto-selects an `allow*` option under read-only), and the client
`fs/write_text_file` handler refuses writes unconditionally. **codex** additionally runs
with its native `INITIAL_AGENT_MODE=read-only`; **grok** and **opencode** have **no native
read-only ACP mode**, so for them read-only is only the client-side gate.

Because native read-only is not uniform, **the real isolation boundary for writes is the
worktree**: a `--write` dispatch (`read_only: false`) is *required* to run in a
server-created git worktree cut from `origin/main`, and the server rejects a write whose
`cwd` resolves inside the primary checkout. Writes never touch the main working tree.

## Caveat: MCP tool names in agent frontmatter

The Clanker agents restrict `tools:` to `mcp__plugin_clanker_clanker__clanker_dispatch_start` and
`mcp__plugin_clanker_clanker__clanker_wait` (the `mcp__plugin_<plugin>_<server>__<tool>` convention).
If your Claude Code version namespaces plugin MCP tools differently, the agents would
have no tools; verify the exact names after install (`/plugin` inventory or the tool
picker) and adjust `agents/*.md` if needed. The zero-discretion body contract (no Bash,
no backgrounding, relay-only) holds regardless.
