---
description: Launch read-only Gemini reconnaissance
argument-hint: "<research task>"
allowed-tools: Agent
---

Dispatch exactly one `Agent(subagent_type="clanker:gemini")` with the research request. That seat holds only the `gemini-recon` profile's start tool, which is server-forced read-only; there is no lane, read_only, sandbox, model or worktree parameter to pass, so do not request a worktree or a non-worker profile.
