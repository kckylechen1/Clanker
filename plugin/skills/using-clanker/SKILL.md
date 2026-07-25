---
name: using-clanker
description: Start and supervise bounded cross-harness jobs through Clanker's dispatch-profile registry.
---

# Using Clanker

Start a bounded job with the narrow `clanker_start_<profile>` tool your seat holds, then poll its id with `clanker_wait(timeout_ms=55000, quiet=true)` until terminal. Use `clanker_status` for a cheap snapshot, `clanker_cancel` to stop a job, and `clanker_list` for inventory. There is no generic start tool: a job's capabilities are chosen by picking the tool, not by filling in parameters.

**Read the verdict from the file, never from a relay's prose.** A terminal wait returns `run_dir` and, once the artifact is on disk, `result_path` — the absolute path of `result.md`, which holds the run's status, its error if any, and the untruncated final message. Relay seats deliver those paths and are forbidden to restate `final_message`; if a terminal run has no `result_path` a seat must answer `CLANKER-NO-RESULT:` instead of composing a summary. Open the file yourself.

A **dispatch profile** is the whole capability combination under one name: lane, write mode, sandbox, worktree isolation, required credentials, supervision, and per-profile turn ceiling. Callers choose a profile by name; the welded dimensions are not parameters on the tool at all.

| profile | lane | writes | worktree | model | sandbox |
|---|---|---|---|---|---|
| `codex-review` | codex | no | optional | lane default | welded `read-only` |
| `codex-write` | codex | yes | required | lane default | selectable, default `workspace-write` |
| `oc-review` | opencode | no | optional | required | n/a |
| `oc-write` | opencode | yes | required | required, non-GLM | n/a |
| `oc-glm-write` | opencode | yes | required | welded `glm`, Sonnet-supervised | n/a |
| `oc-kimi-crew` | opencode | yes | required | welded `kimi` | n/a |
| `gemini-recon` / `gemini-research` | gemini | no | forbidden | lane default | n/a |
| `grok-review` / `grok-write` | grok | no / yes | optional / required | lane default / required | n/a (dormant: HTTP 402) |

Pass the profile's free parameters truthfully and do not reproduce routing rules client-side: the manager rejects host self-dispatch, unsafe writes, unsupervised GLM writes, and invalid Gemini requests. A read-only profile whose worktree is optional runs in the working checkout unless you name a branch — name one when the review has to run build or test tooling.

For a Kimi-led implementation/review crew use `clanker_start_oc-kimi-crew` with a managed worktree; the separately installed `kimi-crew` OpenCode profile owns the child agents. Never pass credentials in a prompt or a parameter: a profile that needs a secret (today only `oc-glm-write`, which needs `ZHIPUAI_API_KEY`) has it materialized from the OS keychain by `tachi vault exec` at spawn time, and OpenCode owns its own auth store for everything else.
