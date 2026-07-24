---
description: Launch one Kimi Crew job
argument-hint: "<task>"
allowed-tools: Agent
---

Dispatch exactly one `Agent(subagent_type="clanker:clanker")` using the unified start shape with `profile: "kimi-crew"`, the task, and one generated managed-worktree branch. Do not define or orchestrate child agents here; the installed OpenCode `kimi-crew` profile owns that work.
