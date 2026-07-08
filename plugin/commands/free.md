---
description: Dispatch a task to Clanker: Free via Opencode ACP.
argument-hint: "[--background|--wait] [--write] [--effort <effort>] <task>"
allowed-tools: Agent
---

Dispatch the task below to **Clanker: Free** by invoking the `clanker:oc` subagent via the `Agent` tool (`subagent_type: "clanker:oc"`). The fixed model token is `free`.

Raw request:
$ARGUMENTS

Argument mapping:

- Fixed `model: "free"`; do not ask the user for a model and do not infer another one.
- `--write` present -> `read_only: false` and a `worktree` is mandatory. If the user did not name a branch, generate `clanker/free-<short-timestamp>`. Absent `--write` -> `read_only: true`.
- `--effort <effort>` -> `effort`; the backend may return a warning if Opencode ignores it.
- Everything else is the natural-language `prompt`.
- `--background` and `--wait` are Claude execution flags. Do not forward them to the Clanker prompt.

Execution mode:

- If the raw request includes `--wait`, run `clanker:oc` in the foreground and relay its final result verbatim.
- If the raw request includes `--background`, run `clanker:oc` as a Claude Code background task with `run_in_background: true`.
- If neither flag is present, default to background.

Background flow:

- Launch exactly one `Agent` tool call with `subagent_type: "clanker:oc"` and `run_in_background: true`.
- The task text must be: "Dispatch as Clanker: Free. prompt=<task>. read_only=<bool>. worktree=<branch or omit>. model=free. effort=<effort or omit>. Follow your relay protocol."
- Do not call MCP dispatch tools in the main conversation.
- Do not wait for the subagent or relay a final result in this turn.
- After launching, tell the user: "Clanker: Free started in the Claude Code background task list."

Foreground flow:

- Launch exactly one `Agent` tool call with `subagent_type: "clanker:oc"` and no background flag.
- Use the same task text as the background flow.
- Relay the subagent's final result verbatim.
