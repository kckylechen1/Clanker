---
description: "Dispatch a task to the Clanker: Opencode (ACP) via a Claude-owned Agent task."
argument-hint: "[glm|ds|kimi|free|composer|grok45|<provider/model>] [--background|--wait] [--write] [--effort <effort>] <task>"
allowed-tools: Agent
---

Dispatch the task below to the **Clanker: Opencode** via the `Agent` tool. Choose the Agent only after parsing the request: read-only calls use the mechanically read-only relay (`subagent_type: "clanker:oc"`); write calls use the packaged supervisor (`subagent_type: "clanker:supervisor"`). Both own the start-and-wait lifecycle and return the backend's final message + result fields.

Raw request:
$ARGUMENTS

Argument mapping (resolve these, then pass explicit parameters to the subagent):

- **Model token** (first token if it is a shortname, or a `--model` value): pass it through as `model` **unchanged** — the server resolves shortnames from the single source in `src/constants.ts` (`OC_MODEL_ALIASES`). For reference, the current map is `glm → zhipuai-coding-plan/glm-5.2`, `ds → deepseek/deepseek-v4-pro`, `kimi → kimi-for-coding/k2p7`, `free → opencode/deepseek-v4-flash-free`, `composer → xai/grok-composer-2.5-fast`, `grok45 → xai/grok-4.5`; a value containing `/` is a full id. If no model token is given, default to `glm`.
- `--write` present → `read_only: false`, a mandatory `worktree`, and `subagent_type: "clanker:supervisor"` so the supervised write path owns correction/cancellation. If the user did not name a branch, generate a default `worktree` like `clanker/oc-<short-timestamp>`. Absent `--write` (or `--read-only` present) → `read_only: true` and `subagent_type: "clanker:oc"` (safe relay default; no worktree needed).
- `--effort <effort>` → `effort`. Note: the opencode ACP lane does not support a reasoning-effort override; the lane returns a warning and ignores it (surfaced verbatim).
- Everything that is not a recognized flag or the model token is the natural-language `prompt`. Do not forward the flags themselves as prompt text.
- `--background` and `--wait` are Claude execution flags. Do not forward them to the Clanker prompt, and do not treat them as part of the natural-language task text.

Execution mode:

- If the raw request includes `--wait`, run the selected subagent in the foreground and relay its final result verbatim.
- If the raw request includes `--background`, run the selected subagent as a Claude Code background task with `run_in_background: true`.
- If neither flag is present, default to background. The whole point of this command is that Claude Code owns the visible Clanker task row; the MCP server only owns the ACP backend.

Background flow:

- Launch exactly one `Agent` tool call with the selected subagent type (`"clanker:oc"` for read-only, `"clanker:supervisor"` for write) and `run_in_background: true`.
- The task text must be: "Dispatch as this Clanker. lane=opencode. prompt=<task>. read_only=<bool>. worktree=<branch or omit>. model=<token, e.g. glm or zhipuai-coding-plan/glm-5.2>. effort=<effort or omit>. Follow your relay/supervisor protocol."
- Do not call MCP dispatch tools in the main conversation.
- Do not wait for the subagent or relay a final result in this turn.
- After launching, tell the user: "Clanker: Opencode started in the Claude Code background task list."

Foreground flow:

- Launch exactly one `Agent` tool call with the selected subagent type and no background flag.
- Use the same task text as the background flow.
- Relay the subagent's final result verbatim.
