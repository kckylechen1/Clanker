---
description: "Dispatch a task to Clanker: GLM under a Sonnet supervisor via Opencode ACP."
argument-hint: "[--background|--wait] [--write] [--effort <effort>] <task>"
allowed-tools: Agent
---

Dispatch the task below to **Clanker: GLM** by invoking the Sonnet supervisor through the `Agent` tool (`subagent_type: "clanker:glm-supervisor"`). The supervisor owns the visible Claude task row and directly controls one persistent GLM ACP seat.

Raw request:
$ARGUMENTS

Argument mapping:

- The supervisor fixes the worker to `lane: "opencode"`, `model: "glm"`, `seat: true`; do not ask for or pass a different worker model.
- `--write` present -> `read_only: false` and a `worktree` is mandatory. If the user did not name a branch, generate `clanker/glm-<short-timestamp>`. Absent `--write` -> `read_only: true`.
- `--effort <effort>` -> `effort`; the backend may return a warning if Opencode ignores it.
- Everything else is the natural-language `prompt`.
- `--background` and `--wait` are Claude execution flags. Do not forward them to the Clanker prompt.

Execution mode:

- If the raw request includes `--wait`, run `clanker:glm-supervisor` in the foreground and relay its final result verbatim.
- If the raw request includes `--background`, run `clanker:glm-supervisor` as a Claude Code background task with `run_in_background: true`.
- If neither flag is present, default to background.

Background flow:

- Launch exactly one `Agent` tool call with `subagent_type: "clanker:glm-supervisor"` and `run_in_background: true`.
- The task text must be: "Supervise this frozen Clanker: GLM contract. prompt=<task>. read_only=<bool>. worktree=<branch or omit>. effort=<effort or omit>. Acceptance criteria are the prompt as written; do not widen scope. Follow your supervision protocol."
- Do not call MCP dispatch tools in the main conversation.
- Do not wait for the subagent or relay a final result in this turn.
- After launching, tell the user: "Clanker: GLM started in the Claude Code background task list."

Foreground flow:

- Launch exactly one `Agent` tool call with `subagent_type: "clanker:glm-supervisor"` and no background flag.
- Use the same task text as the background flow.
- Relay the subagent's final result verbatim.
