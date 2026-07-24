---
name: using-clanker
description: Start and supervise bounded cross-harness jobs through Clanker's unified controller.
---

# Using Clanker

Use `clanker_start` for a bounded job, then poll its id with `clanker_wait(timeout_ms=55000, quiet=true)` until terminal. Use `clanker_status` for a cheap snapshot, `clanker_cancel` to stop a job, and `clanker_list` for inventory.

Pass the requested lane and options truthfully. Do not reproduce routing rules client-side or silently substitute a lane/model: the manager rejects host self-dispatch, unsafe writes, direct GLM writes, and invalid Gemini requests. Writes need a managed `worktree`; non-Codex writes need an explicit `model`.

For a Kimi-led implementation/review crew, set `profile: "kimi-crew"` and provide a managed worktree. The manager fixes OpenCode/Kimi/write mode and relies on the separately installed `kimi-crew` OpenCode profile. Never pass credentials; OpenCode owns authentication.
