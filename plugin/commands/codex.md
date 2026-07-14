---
description: "Dispatch a task to the Clanker: Codex (ACP) via a Claude-owned Agent task."
argument-hint: "[--background|--wait] [--write] [--model <model>] [--effort <effort>] [--read-only] <task>"
allowed-tools: Agent
---

Dispatch the task below to the **Clanker: Codex** by invoking the `clanker:codex` subagent via the `Agent` tool (`subagent_type: "clanker:codex"`). The subagent is a zero-discretion relay: it calls `clanker_dispatch_start` once and long-polls `clanker_wait` until the turn completes, its transcript showing the progress digests. Its final message (final_message + result fields) is what you relay to the user.

Raw request:
$ARGUMENTS

Argument mapping (resolve these, then pass explicit parameters to the subagent):

- `--write` present → `read_only: false` **and a `worktree` is mandatory** (the server rejects a write without one — writes must be isolated from the primary checkout). If the user did not name a branch, generate a default `worktree` like `clanker/codex-<short-timestamp>`. Absent `--write` (or `--read-only` present) → `read_only: true` (safe default; the Clanker cannot modify files, no worktree needed).
- `--model <model>` → `model` (passed through verbatim; codex maps it via CODEX_CONFIG).
- `--effort <effort>` → `effort` (codex reasoning effort).
- Everything that is not a recognized flag is the natural-language `prompt`. Do not forward the flags themselves as prompt text.
- `--background` and `--wait` are Claude execution flags. Do not forward them to the Clanker prompt, and do not treat them as part of the natural-language task text.

Execution mode:

- If the raw request includes `--wait`, run the `clanker:codex` subagent in the foreground and relay its final result verbatim.
- If the raw request includes `--background`, run the `clanker:codex` subagent as a Claude Code background task with `run_in_background: true`.
- If neither flag is present, default to background. The whole point of this command is that Claude Code owns the visible Clanker task row; the MCP server only owns the ACP backend.

Background flow:

- Launch exactly one `Agent` tool call with `subagent_type: "clanker:codex"` and `run_in_background: true`.
- The task text must be: "Dispatch as this Clanker. prompt=<task>. read_only=<bool>. worktree=<branch or omit>. model=<model or omit>. effort=<effort or omit>. Follow your relay protocol."
- Do not call MCP dispatch tools in the main conversation.
- Do not wait for the subagent or relay a final result in this turn.
- After launching, tell the user: "Clanker: Codex started in the Claude Code background task list."

Foreground flow:

- Launch exactly one `Agent` tool call with `subagent_type: "clanker:codex"` and no background flag.
- Use the same task text as the background flow.
- Relay the subagent's final result verbatim.
