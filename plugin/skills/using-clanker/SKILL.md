---
name: using-clanker
description: Start and supervise bounded cross-harness jobs through Clanker's dispatch-profile registry.
---

# Using Clanker

Start a bounded job with the narrow `clanker_start_<profile>` tool your seat holds, then poll its id with `clanker_wait(timeout_ms=55000, quiet=true)` until terminal. Use `clanker_status` for a cheap snapshot, `clanker_cancel` to stop a job, and `clanker_list` for inventory. There is no generic start tool: a job's capabilities are chosen by picking the tool, not by filling in parameters.

**`clanker_list` spans sessions; the control tools do not.** One Clanker server runs per session, and a job outlives the session that started it, so `clanker_list` also reports jobs reconstructed from disk with `owner: "foreign"` plus their `run_dir`. You can read a foreign job's record and verdict; you cannot wait on, correct, or cancel it — that needs the process holding its stdio, and those tools say so by name rather than answering "not found". Never read a refusal, or an empty list, as licence to re-dispatch: an id that is genuinely unknown says `not found` and says where it looked.

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
| `cursor-review` | cursor | no | optional | optional, default `composer-2.5` | n/a (cursor's own read-only mode + sandbox) |
| `cursor-write` | cursor | yes | required | optional, default `composer-2.5` | n/a |
| `grok-review` / `grok-write` | grok | no / yes | optional / required | lane default / required | n/a (dormant: HTTP 402) |

Where a profile's model is optional (`cursor-review` / `cursor-write`), pass one only when the caller named it; omitted, the lane's pinned default runs. Cursor's aliases are lane-local: `composer` → `composer-2.5`, `grok` → `cursor-grok-4.5-high`, `codex53` → `gpt-5.3-codex-high` — they are NOT the opencode shortnames, where `composer` means a different provider's model entirely. Composer 2.5 is a bounded single-layer-scaffolding tier (composer-2.5 lane card, #1368): provenance and identity-critical cores still need a cross-vendor screen.

**Correction turns come in two shapes, and `clanker_prompt` picks the one the job's lane supports.** A supervised job (`oc-glm-write`) continues its still-open ACP session, so its window closes when the idle-TTL reaper does. A `cursor` job is re-spawned against the conversation Cursor itself holds (`--resume`), so it stays correctable after the session closed — and it accepts an optional `model`, which runs the next turn on a different model inside the same conversation (measured: a passphrase stored by `composer-2.5` was recalled by `cursor-grok-4.5-high` resuming the same session). Either shape keeps the job's id, worktree, write boundary and single ledger row, and rewrites `result.md` with the corrected turn's verdict. A correction with nothing to resume is refused by name rather than quietly started as a fresh, memoryless worker.

**A hand-off is continuation, never review.** The resumed model reads the previous turn's whole context and is anchored by its framing, so passing work from one model to another is drafting and polish — not verification. The failure this forecloses is specific: Composer's signature mode is a green test suite over a violated contract (composer-2.5 lane card, #1368), and a reviewer inside the defendant's own session inherits the defendant's account of the evidence. Verification requires a separately dispatched job with a cold context, ideally another vendor.

Pass the profile's free parameters truthfully and do not reproduce routing rules client-side: the manager rejects host self-dispatch, unsafe writes, unsupervised GLM writes, and invalid Gemini requests. A read-only profile whose worktree is optional runs in the working checkout unless you name a branch — name one when the review has to run build or test tooling.

For a Kimi-led implementation/review crew use `clanker_start_oc-kimi-crew` with a managed worktree; the separately installed `kimi-crew` OpenCode profile owns the child agents. Never pass credentials in a prompt or a parameter: a profile that needs a secret (today only `oc-glm-write`, which needs `ZHIPUAI_API_KEY`) has it materialized from the OS keychain by `tachi vault exec` at spawn time, and OpenCode owns its own auth store for everything else.
