---
description: Launch read-only Gemini reconnaissance
argument-hint: "<research task>"
allowed-tools: Agent
---

Dispatch exactly one `Agent(subagent_type="clanker:gemini")` with the research request. That seat holds the `gemini-recon` and `gemini-research` start tools — both server-forced read-only; there is no lane, read_only, sandbox, model or worktree parameter to pass, so do not request a worktree or a non-worker profile. Quick codebase survey → `gemini-recon`; anything that needs live web sources with citations → `gemini-research`.
