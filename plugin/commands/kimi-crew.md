---
description: "Launch Kimi Crew: one Kimi-led OpenCode session."
argument-hint: "[--background|--wait] <task>"
allowed-tools: Agent
---

Launch exactly one `Agent` relay for **Clanker: Kimi Crew**.

Raw request:
$ARGUMENTS

Contract:

- Accept only `--background`, `--wait`, and the natural-language task. Do not forward either flag into the task.
- Generate exactly one branch named `clanker/kimi-crew-<short-timestamp>` for the managed worktree.
- Launch exactly one `Agent` with `subagent_type: "clanker:kimi-crew"`. Its task text must contain only the prompt and generated worktree branch and instruct it to follow its relay protocol.
- If `--wait` is present, run the Agent in the foreground and return its real result verbatim.
- If `--background` is present, or neither flag is present, use `run_in_background: true`; do not wait, and report that Clanker: Kimi Crew started in the Claude Code background task list.
- Do not call MCP tools in this command and do not launch any other relay or child model.
