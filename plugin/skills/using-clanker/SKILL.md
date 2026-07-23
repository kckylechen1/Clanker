---
name: using-clanker
description: "Routes bounded coding tasks through Clanker's host-aware Codex, Opencode, Grok, GLM, DeepSeek, Kimi, and Composer lanes. Use for cross-vendor review, external analysis, isolated implementation, or any clanker_dispatch_* lifecycle call."
compatibility: "Requires the Clanker MCP server and its host-filtered dispatch tools."
---

# Using Clanker

Use Clanker as a bounded external-worker lifecycle, not as a generic fallback when native orchestration is available.

## Read the host boundary first

Trust the lane enum and available tools advertised by the running MCP server. Never invent a missing lane or tool.

| Host | Available lanes | GLM write |
|---|---|---|
| Claude | `codex`, `opencode`, `grok` | Route through the packaged Sonnet `clanker:supervisor` |
| Codex | `opencode`, `grok` only | Unavailable; it requires the Claude/Sonnet supervisor |

Under Codex, keep native Sol, Luna, Terra, and 5.5 work on native V1 orchestration. Clanker is for external Opencode or Grok workers there. Never self-dispatch Codex through Clanker.

## Choose the narrowest start tool

### Read-only review, analysis, or research

Use `clanker_dispatch_readonly_start` by default. Supply:

- `lane`
- a bounded `prompt` with acceptance evidence
- `cwd` only when the task must run outside the server's base repository
- real `model` override — required when `lane=opencode` (an omitted model would fall to opencode's own config default outside the vault-exec credential wrap and is rejected); optional for `lane=codex` — plus compatible `effort` overrides

The server forces `read_only=true`; callers cannot turn this tool into a writer.

### Non-GLM implementation

Use `clanker_dispatch_write_start`. Supply:

- `lane`
- a bounded implementation `prompt`
- a unique `worktree` branch name such as `clanker/fix-parser-guard`
- `model` according to the lane rules below

The server forces `read_only=false` and creates the worktree from `origin/main`. Never point a write run at the primary checkout and never merge the worker's branch automatically.

Model rules:

- `lane=codex`: `model` is optional. Omit the field to inherit Codex's configured default. If overriding, pass a real model id. Never pass `model=codex`; `codex` is a lane name.
- `lane=opencode`: an explicit model id or supported model alias is required for this write tool.
- `lane=grok`: an explicit Grok model id is required for this write tool.
- Composer 2.5 and Grok 4.5 are different models. Route `composer` through Opencode; do not relabel it as Grok 4.5.

### GLM implementation

On Claude, route GLM writes with a unique managed `worktree` to the packaged Sonnet `clanker:supervisor`. The supervisor alone calls `clanker_dispatch_glm_write_start`, monitors the worker, and may send one correction or cancel an unrecoverable run.

On Codex, report that GLM writes are unavailable through Clanker. Do not bypass the missing supervisor with a generic dispatch tool, a direct CLI, or another lane.

## Own the lifecycle to terminal state

After any successful start:

1. Keep the returned real `id`.
2. Call `clanker_wait` with that id, `timeout_ms=55000`, and `quiet=true`.
3. If status is `running`, call `clanker_wait` again with the same id.
4. Treat `suspected_stall=true` as a warning, not completion. Keep waiting unless the requester explicitly asks for cancellation or the GLM supervisor determines the run is unrecoverable.
5. Stop only on `done`, `error`, or `cancelled`.

A wait timeout is only the end of one long-poll window. It is never evidence that the worker completed or failed.

Use `clanker_status` only for a cheap snapshot; it does not replace terminal completion ownership. Use `clanker_prompt` for an intentional continuation of an existing seat. Set `correction=true` only from the GLM supervisor. Close a persistent seat with `clanker_close` when its lifecycle is finished.

Prefer the forced read-only/write start tools over generic `clanker_dispatch_start` or blocking `clanker_dispatch`; the forced tools make the safety mode visible in the schema and handler.

## Handle failures loudly

- If a start call fails schema or policy validation, fix the arguments. Do not retry the identical request.
- If `failure_class=CLANKER-INFRA-FAILURE`, report the backend/schema failure and run a canary before another real batch.
- Capacity-transient first-turn failures receive one server-managed retry. Do not layer an immediate caller retry on top.
- Never silently substitute a lane, invent a model, fall back to a direct CLI, or fabricate a result without a real run id.
- A worker's claim that tests passed is evidence to relay, not independent verification by the parent.

## Return terminal evidence

Use this shape when reporting a completed dispatch:

```text
id: <real run id>
status: done | error | cancelled
final_message: <worker's terminal result, when present>
touched_files: <reported paths>
worktree: <retained branch/path for write runs, when present>
warnings_or_error: <warnings, failure_class, or error>
```

Do not return a launch acknowledgement as if it were a completed result.

## Routing examples

- "Have Grok review this diff without edits" → read-only start, `lane=grok`, then wait to terminal.
- "Let Codex implement this using its configured default" on Claude → write start, `lane=codex`, unique `worktree`, omit `model`, then wait.
- "Have DeepSeek implement this" → write start, `lane=opencode`, `model=ds`, unique `worktree`, then wait.
- "Have Composer review this" → read-only start, `lane=opencode`, `model=composer`; do not use `lane=grok`.
- "Have GLM implement this" on Claude → packaged `clanker:supervisor`; on Codex → reject as unavailable through this host.
