---
description: "Dispatch a task to Clanker: DeepSeek via Opencode ACP."
argument-hint: "[--background|--wait] [--write] [--effort <effort>] <task>"
allowed-tools: Agent
---

Dispatch the task below to **Clanker: DeepSeek** via the `Agent` tool. The fixed model token is `ds`. Read-only calls use `subagent_type: "clanker:oc"`; write calls use `subagent_type: "clanker:writer"` without Sonnet supervision.

Raw request:
$ARGUMENTS

Argument mapping:

- Fixed `model: "ds"`; do not ask the user for a model and do not infer another one.
- `--write` present -> `read_only: false`, a mandatory `worktree`, and `subagent_type: "clanker:writer"`. If the user did not name a branch, generate `clanker/deepseek-<short-timestamp>`. Absent `--write` -> `read_only: true` and `subagent_type: "clanker:oc"`.
- `--effort <effort>` -> `effort`; the backend may return a warning if Opencode ignores it.
- Everything else is the natural-language `prompt`.
- `--background` and `--wait` are Claude execution flags. Do not forward them to the Clanker prompt.

Execution mode:

- If the raw request includes `--wait`, run the selected subagent in the foreground and relay its final result verbatim.
- If the raw request includes `--background`, run the selected subagent as a Claude Code background task with `run_in_background: true`.
- If neither flag is present, default to background.

Background flow:

- Launch exactly one `Agent` tool call with the selected subagent type (`"clanker:oc"` for read-only, `"clanker:writer"` for write) and `run_in_background: true`.
- The task text must be: "Dispatch as Clanker: DeepSeek. lane=opencode. prompt=<task>. read_only=<bool>. worktree=<branch or omit>. model=ds. effort=<effort or omit>. Follow your relay protocol."
- Do not call MCP dispatch tools in the main conversation.
- Do not wait for the subagent or relay a final result in this turn.
- After launching, tell the user: "Clanker: DeepSeek started in the Claude Code background task list."

Foreground flow:

- Launch exactly one `Agent` tool call with the selected subagent type and no background flag.
- Use the same task text as the background flow.
- Relay the subagent's final result verbatim.
