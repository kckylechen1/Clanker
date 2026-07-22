---
description: "Dispatch a task to the Clanker: Codex (ACP) via a Claude-owned Agent task."
argument-hint: "[--background|--wait] [--write] [--model <model>] [--effort <effort>] [--read-only] <task>"
allowed-tools: Agent
---

Dispatch the task below to the **Clanker: Codex** via the `Agent` tool. Choose the Agent only after parsing the request: read-only calls use the mechanically read-only relay (`subagent_type: "clanker:codex"`); write calls use the packaged supervisor (`subagent_type: "clanker:supervisor"`). Both own the start-and-wait lifecycle and return the backend's final message + result fields.

Raw request:
$ARGUMENTS

Argument mapping (resolve these, then pass explicit parameters to the subagent):

- `--write` present → `read_only: false`, a mandatory `worktree`, and `subagent_type: "clanker:supervisor"` so the supervised write path owns correction/cancellation. If the user did not name a branch, generate a default `worktree` like `clanker/codex-<short-timestamp>`. Absent `--write` (or `--read-only` present) → `read_only: true` and `subagent_type: "clanker:codex"` (safe relay default; no worktree needed).
- `--model <model>` → `model` (passed through verbatim; codex maps it via CODEX_CONFIG). For `--write` with no model, use `gpt-5.6-terra`; with no effort, use `medium`. Read-only calls may omit both and retain the Codex default.
- `--effort <effort>` → `effort` (codex reasoning effort).
- Everything that is not a recognized flag is the natural-language `prompt`. Do not forward the flags themselves as prompt text.
- `--background` and `--wait` are Claude execution flags. Do not forward them to the Clanker prompt, and do not treat them as part of the natural-language task text.

Execution mode:

- If the raw request includes `--wait`, run the selected subagent in the foreground and relay its final result verbatim.
- If the raw request includes `--background`, run the selected subagent as a Claude Code background task with `run_in_background: true`.
- If neither flag is present, default to background. The whole point of this command is that Claude Code owns the visible Clanker task row; the MCP server only owns the ACP backend.

Background flow:

- Launch exactly one `Agent` tool call with the selected subagent type (`"clanker:codex"` for read-only, `"clanker:supervisor"` for write) and `run_in_background: true`.
- The task text must be: "Dispatch as this Clanker. lane=codex. prompt=<task>. read_only=<bool>. worktree=<branch or omit>. model=<explicit model, gpt-5.6-terra for write, or omit for read-only>. effort=<explicit effort, medium for write, or omit for read-only>. Follow your relay/supervisor protocol."
- Do not call MCP dispatch tools in the main conversation.
- Do not wait for the subagent or relay a final result in this turn.
- After launching, tell the user: "Clanker: Codex started in the Claude Code background task list."

Foreground flow:

- Launch exactly one `Agent` tool call with the selected subagent type and no background flag.
- Use the same task text as the background flow.
- Relay the subagent's final result verbatim.
