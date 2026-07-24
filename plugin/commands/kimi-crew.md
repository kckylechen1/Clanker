---
description: Launch one Kimi Crew job
argument-hint: "<task>"
allowed-tools: Agent
---

Dispatch exactly one `Agent(subagent_type="clanker:crew")` with the task and one generated managed-worktree branch. That seat holds only the `oc-kimi-crew` profile's start tool, which welds OpenCode, Kimi and write mode server-side. Do not define or orchestrate child agents here; the installed OpenCode `kimi-crew` profile owns that work.
