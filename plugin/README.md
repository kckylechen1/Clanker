# Clanker — Claude Code plugin

Bundles the Clanker dispatch surface over ACP:

- **MCP server `clanker`** — declared in [`.mcp.json`](.mcp.json), launched as
  `node ${CLAUDE_PLUGIN_ROOT}/dist/clanker-mcp.mjs`. `dist/clanker-mcp.mjs` is a
  **self-contained esbuild bundle** of the server + its SDK deps, and the sibling
  `dist/codex-acp.mjs` is the self-contained Codex ACP subprocess. Both are committed
  because plugin install copies the plugin directory to a cache and a plugin cannot
  reference files outside itself (so the server cannot live one level up). Regenerate
  it with `npm run bundle` from `/Users/kckylechen/Projects/Clanker` after changing `src/`.
  The manifest passes `--host claude` explicitly, preserving all Claude lane and GLM-supervisor behavior.
- **Clankers** `codex` / `grok` / `oc` ([`agents/`](agents)) — haiku,
  zero-discretion read-only long-poll relays. Their only start tool is
  `clanker_dispatch_readonly_start`, whose schema has no write override and whose handler
  always forces `readOnly:true`. They loop `clanker_wait` until the turn completes and return
  only `final_message` + result fields. Their UI rows read `clanker:codex` / `clanker:grok` /
  `clanker:oc`.
- **Clanker writer** `clanker:writer` — packaged haiku zero-discretion relay for non-GLM
  isolated writes. Its only start tool forces write mode, requires a managed worktree, and
  rejects the GLM model even when addressed by its full provider id. Codex writes may omit
  `model` to inherit the configured Codex default; Opencode/Grok writes still require one.
- **GLM supervisor** `clanker:supervisor` — packaged sonnet lifecycle controller only for
  GLM writes. Its dedicated start tool fixes the lane and model server-side. It can start,
  wait, correct, or cancel GLM, but has no file, shell, test, or git tools.
- **Skill** `using-clanker` — one host-aware dispatch and lifecycle protocol, synchronized
  into both adapters at bundle time. It keeps Codex self-dispatch and GLM supervision
  boundaries explicit while teaching agents when a model must be supplied or omitted.
- **Commands** `/clanker:codex`, `/clanker:grok`, `/clanker:glm`, `/clanker:deepseek`,
  `/clanker:kimi`, `/clanker:free`, `/clanker:oc`, `/clanker:kimi-crew` ([`commands/`](commands)) —
  argument mapping preserved from the current habits. Read-only calls use the lane relay;
  non-GLM writes use `clanker:writer`, while GLM writes alone use the Sonnet
  `clanker:supervisor`; both write paths require a managed worktree. `--background` /
  default mode maps to the outer Agent's
  `run_in_background`; oc model shortnames resolve server-side. The Claude `Agent` call is
  the visible lifecycle owner: it holds the Clanker task row while the MCP server only owns
  the ACP backend.

`/clanker:kimi-crew` launches one Kimi-led OpenCode session and monitors it to completion. OpenCode
uses the already-installed `worker-glm` for implementation, `reviewer-deepseek` for cold review,
and optional `oracle` (Sol) when warranted. Clanker does not orchestrate those children or claim
a deterministic workflow. Clanker constrains Kimi's task delegation to those named agents but does
not downscope its normal OpenCode tools or permissions. Direct GLM writes remain Sonnet-supervised,
while the Crew's GLM worker is intentionally led by Kimi.

All generic MCP start/dispatch paths reject Opencode GLM writes too; the dedicated
`clanker_dispatch_glm_write_start` path is the only server-supported GLM write entrypoint.

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

The separate Codex adapter lives at `../codex-plugin` and is advertised by
`../.agents/plugins/marketplace.json`. Register this repository with
`codex plugin marketplace add /Users/kckylechen/Projects/Clanker`, then install it with
`codex plugin add clanker@clanker`; do not reuse this Claude manifest. Codex starts the same runtime
with `--host codex`, which excludes self-dispatch and the Claude/Sonnet-only GLM write supervisor tool.

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
| `~/bin/lane-run codex\|grok\|oc <prompt-file>` | `/clanker:*` | retired; do not fall back to direct CLI dispatch |
| codex-companion (background poll) | Claude background Clanker wrapping `clanker_dispatch_start` + `clanker_wait` | task is visible under Claude Code, no shell notification dependency |

## Read-only and write isolation (the real safety boundary)

`read_only: true` (the default for `/clanker:*` without `--write`) is forced by the
relay-only start tool and enforced again at the client layer: the server's
`session/request_permission` handler declines any permissioned
operation (it never auto-selects an `allow*` option under read-only), and the client
`fs/write_text_file` handler refuses writes unconditionally. **codex** additionally runs
with its native `INITIAL_AGENT_MODE=read-only`. **grok** is launched with its native
`--sandbox read-only`, `--permission-mode default`, `--no-subagents`, and `--no-leader`
controls so it cannot inherit an interactive `always-approve` or shared-leader setting;
write runs use Grok's `workspace` sandbox inside the managed worktree. **opencode** uses
Clanker's fixed worker permission profile, which denies edits and shell in read-only mode.

`/clanker:grok` pins `grok-4.5` when no model is supplied. Composer 2.5 is a distinct
model, not another name for Grok 4.5: route it through the Opencode lane as
`/clanker:oc composer ...` (`xai/grok-composer-2.5-fast`). The separate `grok45`
Opencode alias resolves to `xai/grok-4.5`.

Because native read-only is not uniform, **the real isolation boundary for writes is the
worktree**: a `--write` dispatch (`read_only: false`) is *required* to run in a
server-created git worktree cut from `origin/main`, and the server rejects a write whose
`cwd` resolves inside the primary checkout. Writes never touch the main working tree.

### Review seats that need to actually run tests: `sandbox: "workspace-write"`

`INITIAL_AGENT_MODE=read-only` (codex's native mode under `read_only: true`) blocks *all*
writes at the OS-sandbox level — including build/test-cache writes a review seat needs for
`cargo test` / `go test` to run at all, which is why such runs have historically ended up
Not-checked. Write-capable Codex now defaults to `workspace-write`; `danger-full-access`
drops the sandbox and requires an explicit `sandbox: "danger-full-access"` override.

`clanker_dispatch`'s `sandbox` param (codex-only) exposes the middle tier codex-acp itself
supports: `sandbox: "workspace-write"` boxes writes to the session cwd + tmp, independent of
`read_only`. **Recommended review-seat recipe: `worktree: <branch>` (isolation boundary) +
`sandbox: "workspace-write"` (writes allowed, but boxed to that worktree)** — test tooling
can now write its caches, and the worktree — not this repo's main checkout — contains the
blast radius. `read_only: true` can still be set alongside it; it independently gates this
client's own file-write RPC handler and permission auto-decline, a second belt.

`clanker_cancel` waits for cooperative ACP termination and escalates to process termination
after `CLANKER_CANCEL_GRACE_MS`, returning only after terminal cancellation (or a loud error).
Each run atomically stores protocol/config-only telemetry in its run directory as `telemetry.json`.
`prompt_usage` is turn-local and resets at each turn; `session_usage` is the latest session context
and cumulative session cost and persists across turns with observed model/effort.

## Caveat: MCP tool names in agent frontmatter

The read-only relay agents restrict `tools:` to
`mcp__plugin_clanker_clanker__clanker_dispatch_readonly_start` and
`mcp__plugin_clanker_clanker__clanker_wait`; the writer gets the forced-write start + wait,
while the GLM supervisor gets its dedicated GLM forced-write start + wait/prompt/cancel lifecycle tools
(the `mcp__plugin_<plugin>_<server>__<tool>` convention).
If your Claude Code version namespaces plugin MCP tools differently, the agents would
have no tools; verify the exact names after install (`/plugin` inventory or the tool
picker) and adjust `agents/*.md` if needed. The zero-discretion body contract (no Bash,
no backgrounding, relay-only) holds regardless.
