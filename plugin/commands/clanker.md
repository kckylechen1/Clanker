---
description: Start a Clanker job through the unified controller
argument-hint: "<lane> <task> [model/worktree/read-only options]"
---

Dispatch exactly one `Agent(subagent_type="clanker:clanker")`. Pass the requested lane, task, and explicit options. Do not apply host-routing policy client-side; Clanker enforces it.
