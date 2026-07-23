---
description: Launch read-only Gemini reconnaissance
argument-hint: "<research task>"
allowed-tools: Agent
---

Dispatch exactly one `Agent(subagent_type="clanker:clanker")` with `lane: "gemini"` and the request. Gemini is server-forced read-only; do not request a worktree or non-worker profile.
