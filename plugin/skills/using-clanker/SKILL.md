---
name: using-clanker
description: Start and supervise bounded cross-harness jobs through Clanker's dispatch-profile registry.
---

# Using Clanker

Start a bounded job with `clanker_start` (naming a profile) or with the narrow `clanker_start_<profile>` tool your seat holds, then poll its id with `clanker_wait(timeout_ms=55000, quiet=true)` until terminal. Use `clanker_status` for a cheap snapshot, `clanker_cancel` to stop a job, and `clanker_list` for inventory.

A **dispatch profile** is the whole capability combination under one name: lane, write mode, sandbox, worktree isolation, required credentials, supervision, and per-profile turn ceiling. Callers choose a profile; they never choose those dimensions individually, and the welded ones are not parameters on the tool at all.

| profile | lane | writes | worktree | model |
|---|---|---|---|---|
| `codex-review` | codex | no | forbidden | lane default |
| `codex-write` | codex | yes | required | lane default |
| `oc-review` | opencode | no | forbidden | required |
| `oc-write` | opencode | yes | required | required, non-GLM |
| `oc-glm-write` | opencode | yes | required | welded `glm`, Sonnet-supervised |
| `oc-kimi-crew` | opencode | yes | required | welded `kimi` |
| `gemini-recon` | gemini | no | forbidden | lane default |
| `grok-review` / `grok-write` | grok | no / yes | forbidden / required | required (dormant: HTTP 402) |

Pass the profile's free parameters truthfully and do not reproduce routing rules client-side: the manager rejects host self-dispatch, unsafe writes, unsupervised GLM writes, and invalid Gemini requests.

For a Kimi-led implementation/review crew use `profile: "oc-kimi-crew"` with a managed worktree; the separately installed `kimi-crew` OpenCode profile owns the child agents. Never pass credentials in a prompt or a parameter: a profile that needs a secret (today only `oc-glm-write`, which needs `ZHIPUAI_API_KEY`) has it materialized from the OS keychain by `tachi vault exec` at spawn time, and OpenCode owns its own auth store for everything else.
