---
name: using-clanker-codex
description: Dispatch and manage external coding workers from Codex through Clanker, using OpenCode cloud or self-hosted model providers. Use when the user asks to use their other model credits, Clanker, or DGX-hosted models for a bounded task.
---

# Clanker for Codex

Codex owns task decomposition, correction, artifact inspection, and acceptance. Clanker starts an external OpenCode worker; it is not a native Codex subagent and does not change the parent model. No Sonnet relay is required. Use only when external delegation is authorized by the user or governing workflow.

## Dispatch

1. Discover the live tool schema. Call `clanker_models` with an optional provider filter; paginate with `next_offset`. These are configured model IDs, not proof of reachable endpoints or available credits. Pass an exact `provider/model` ID, particularly for private servers. Do not silently change model or provider after a failure.
2. Freeze a bounded task: target repository, permitted edits, forbidden paths, acceptance evidence and stop conditions. Read-only work uses `clanker_start_oc-managed-review`; implementation uses `clanker_start_oc-managed-write`, with a unique mandatory `worktree` branch. Pass absolute `cwd` and an explicit `base` commit when reproducibility matters. Use `doNotTouch` for frozen paths. Never run writes in the primary checkout.
3. Start once and keep the returned run ID. A lost tool response is not permission to launch a duplicate. Check `clanker_list` and `clanker_status` before any recovery decision. Never supply `issue` unless the user explicitly authorized posting to that issue: that field sends an external GitHub comment.
4. Long-poll with `clanker_wait(id, timeout_ms=55000, quiet=true)`. Do useful independent work between waits. A stall warning is not a terminal failure. Native-agent slot counts do not constrain these external processes; dispatch at most two concurrent workers by default unless the user chooses a different limit.

## Inspect and correct

A completed turn is not an accepted delivery. Open the returned `result_path`, inspect the actual diff and relevant evidence, and compare `telemetry.resolved_model` with `telemetry.observed_model`. Missing observed identity means unknown; a mismatch must be reported. Do not treat a worker's claim that tests passed as independent evidence.

Managed profiles keep a live ACP session after the first turn. `continuation` in wait/status reports `can_prompt`, `reason`, `follow_ups_remaining`, and `expires_at`. When `can_prompt` is true, `clanker_prompt` can send ONE follow-up in that session. This server-side limit counts every follow-up, even if `correction=false`. Use `correction=true` for a repair. Read-only and write boundaries remain fixed. The model cannot be switched during an OpenCode live session.

There is no mid-flight steering in this adapter. Wait for the current turn to finish, or cancel it. A closed/expired session cannot be continued by guessing a session ID or silently starting over. Use `clanker_cancel` to release an idle session after inspecting its artifacts; preserve and report any retained worktree, then finish the repository's normal delivery path.

Independent review needs a separately started cold context against the exact candidate commit. Continuing an implementer's conversation is implementation, never independent review.

## Failure and ownership

Errors, provider refusals, absent result files and incomplete tests are not success. Report the real run ID and evidence paths. Do not summarize a missing result into an invented verdict.

Run control belongs to the MCP server process that started it. A different session can discover foreign records but cannot assume it owns the worker's live connection. Follow the server's explicit refusal/degraded status; do not kill unrelated processes or redispatch because the active session has no local record.

Authentication stays in OpenCode's existing provider store. GLM routes currently require `tachi vault exec --keychain` and `ZHIPUAI_API_KEY`; do not read or copy credentials into prompts, results or plugin files.

For future DGX servers, read [Self-hosted inference](references/self-hosted.md). Do not SSH into or deploy models on either machine unless explicitly asked.
