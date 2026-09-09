# Clanker for Codex

A personal Codex plugin using the existing Clanker ACP runtime. Codex directly controls OpenCode workers backed by cloud or self-hosted models. No Claude/Sonnet supervisor is required.

The two new start tools are `clanker_start_oc-managed-review` (read-only, optional worktree) and `clanker_start_oc-managed-write` (mandatory isolated worktree). Both require an explicit model and permit one follow-up turn. `clanker_models` discovers configured OpenCode provider/model IDs with bounded pagination. Existing lifecycle tools handle wait/status/prompt/cancel/list.

The host remains `codex`: self-dispatch to the Codex ACP lane and Claude-only Sonnet profiles remain excluded. Existing Claude profiles retain their behavior. Managed-profile authority is minted by the registry and cannot be supplied as a request field.

## Installation

Requires Node >=24, OpenCode with configured providers, Git for write worktrees, and Tachi Vault for current GLM routes. Bundles are self-contained and need no npm install at plugin runtime.

Build this repository with `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`, and `npm run bundle`. Install the `clanker-codex/` artifact through Codex's personal marketplace. Start a new Codex thread to load its tools. Source and installed-package protocol tests must pass before treating it as connected.

Read `skills/using-clanker-codex/SKILL.md` for the workflow and `references/self-hosted.md` below that skill for future DGX setup. The endpoints are configured in OpenCode, not Clanker. No credentials are packaged, and no DGX service is contacted during installation.

## Lifecycle and limits

Worker tools execute locally; DGX machines would serve inference only. One follow-up is enforced by the server for managed profiles regardless of the `correction` flag. The live session expires after the existing ten-minute idle TTL (unless the operator configured another TTL). Wait/status includes `continuation` with availability, refusal reason, remaining follow-ups and expiry. Closed sessions cannot be resumed through this route; cross-process discovery is not cross-process control.

The user/lead decides acceptance by inspecting actual artifacts. A terminal worker message is not independent verification. The plugin skill defaults to at most two concurrent external workers; this is dispatcher guidance, not a server-enforced quota.

Rollback: uninstall `clanker-codex` through Codex. This does not remove OpenCode providers, credentials or retained worktrees. Handle outstanding workers and their artifacts before uninstalling.
