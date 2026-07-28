# Clanker

Clanker is a thin cross-harness job controller. It starts an ACP-backed job, records progress/results, waits, reports status, cancels with escalation, and conservatively cleans managed worktrees. It does not choose orchestration strategies or hold provider credentials.

## MCP API

Five lifecycle tools are exposed — `clanker_wait`, `clanker_status`, `clanker_cancel`, `clanker_list`, `clanker_prompt` — plus one generated `clanker_start_<profile>` tool per row of the dispatch-profile registry (`src/profiles.ts`). Those generated tools are the **only** way to start a job.

`clanker_prompt` is the supervised correction turn, and it is deliberately narrow. Supervision here is **turn-by-turn, not mid-flight**: ACP cannot redirect a prompt already in progress, so a correction is a new turn issued after the previous one came back terminal. A supervised run therefore keeps its session — and its worktree — open past that terminal turn, and the idle-TTL reaper closes both once the window expires. The correction is refused unless the run was minted from a profile whose `supervision` is `sonnet`: the check is against the registry row, not against which tool the caller holds, so a seat file that drifts into declaring the tool still cannot steer an unsupervised worker. A corrected run keeps its id, its worktree and its **single** ledger row, while `result.md` is rewritten so the verdict on disk is the corrected one rather than the output the correction was issued to replace.

A **dispatch profile** is the whole capability combination under one name: lane, write mode, sandbox, worktree isolation, required vault credentials, supervision, role class and per-profile turn ceiling. Each generated tool exposes only that profile's free parameters, so a seat holding one cannot ask for a capability the profile does not grant.

There is deliberately **no generic `clanker_start(profile, ...)`**. A universal entrance that can reach every profile makes the narrow tools decoration: with one present, a `host=codex` server — which is not supposed to offer the supervised GLM shape at all — still started it. Host filtering is therefore complete: a profile whose lane the host cannot drive, and any supervised profile on `host=codex`, is never registered.

| profile | lane | writes | worktree | model | sandbox | notes |
|---|---|---|---|---|---|---|
| `codex-review` | codex | no | optional | lane default | welded `read-only` | welded so the native sandbox can't route around `read_only` |
| `codex-write` | codex | yes | required | lane default | caller-selectable, default `workspace-write` | |
| `oc-review` | opencode | no | optional | required | n/a | fixed `clanker-worker` profile |
| `oc-write` | opencode | yes | required | required, non-GLM | n/a | fixed `clanker-worker` profile |
| `oc-glm-write` | opencode | yes | required | welded `glm` | n/a | `ZHIPUAI_API_KEY` via vault; Sonnet supervision |
| `oc-kimi-crew` | opencode | yes | required | welded `kimi` | n/a | installed OpenCode `kimi-crew` profile |
| `gemini-recon` | gemini | no | forbidden | lane default | n/a | the lane rejects worktrees; 11-minute turn ceiling |
| `gemini-research` | gemini | no | forbidden | lane default | n/a | online research; every conclusion carries its source URL, anything unsourced is reported unverified |
| `cursor-review` | cursor | no | optional | optional, default `composer-2.5` | n/a | cursor-agent's own read-only mode + sandbox under the welded `read_only`; 15-minute turn ceiling |
| `cursor-write` | cursor | yes | required | optional, default `composer-2.5` | n/a | Composer 2.5 is a bounded single-layer-scaffolding tier — cross-vendor screen still required for provenance/identity cores |
| `grok-review` | grok | no | optional | lane default | n/a | dormant: HTTP 402 |
| `grok-write` | grok | yes | required | required | n/a | dormant: HTTP 402 |

A read-only profile with `isolation: optional` runs in the working checkout by default and inside a managed worktree when you name one — the recipe for a review that must actually run build/test tooling.

Policy stays server-side: a host cannot dispatch itself; Gemini is fixed read-only and rejects worktrees; writes require a managed worktree cut from the target repo and cannot target the primary checkout; non-Codex writes require an explicit model; a GLM write is possible only through the supervised `oc-glm-write` profile.

Credentials are never parameters. OpenCode's own auth store owns everything OAuth-backed; the one bare API key in play, GLM's `ZHIPUAI_API_KEY`, is materialized from the OS keychain at spawn time by rewriting the spawn command to `tachi vault exec --keychain --require ZHIPUAI_API_KEY -- <original command>`, so it never lives in Clanker's or the ambient shell's environment.

## Runs owned by another process

A host spawns one Clanker server per session, and each server holds its jobs in memory — so a job started in session A used to be invisible to session B. That would be a nuisance if jobs died with their session; they do not, and not dying is the whole reason to dispatch through Clanker. The result was the inversion of what the registry is for: **the job outlives the only record that it exists**, and `clanker_list` answered `[]` — not "I cannot see", just "nothing".

`clanker_list` therefore also reports runs reconstructed from `telemetry.json` on disk, tagged `owner: "foreign"` and carrying `run_dir`, `result_path` and `observed_model`. Foreign entries are never reported as `working`: with no event stream this process cannot tell working from wedged, and a board that guesses is worse than one that abstains. Terminal foreign runs are omitted — the question a scan asks is what is still in flight.

Visibility is recoverable from disk; **control is not**. `clanker_wait`, `clanker_cancel` and `clanker_prompt` need the process holding the worker's stdio, so they refuse a foreign id by name — `run '<id>' belongs to a different Clanker server process and is still in flight … Do NOT re-dispatch on the assumption that it never started` — instead of the old `run '<id>' not found`. That sentence was the same for an id that never existed and an id running elsewhere, and the documented recovery for a dropped relay re-dispatches when the tools come back empty; one frozen contract, two live workers, both opening a PR. An id with no record anywhere still says not found, and says where it looked.

## Run artifacts

Every job owns a directory under `CLANKER_RUNS_ROOT` (default `~/.cache/clanker/runs/<id>`), returned as `run_dir` by `clanker_wait`/`clanker_status` so no caller has to construct the path:

| file | contents |
|---|---|
| `events.jsonl` | every raw ACP event, append-only |
| `chunks.log` | agent thought/message fragments (the reasoning stream never enters a tool response) |
| `telemetry.json` | the live telemetry projection, rewritten atomically |
| `result.md` | **the terminal verdict**: status, lane, error (if any) and the untruncated final message |

`result.md` is written exactly once, from the same terminal transition as the dispatch-ledger row. It exists so a verdict can be **handed over as a path** instead of retold: a relay seat reports `result_path` and the dispatcher reads the bytes itself. `clanker_wait` sets `result_path`/`result_bytes` only when the file is really there and non-empty — its absence on a terminal run is a seat's cue to report `CLANKER-NO-RESULT:` rather than compose a summary. Unlike the `final_message` field on the wire (capped at `CLANKER_FINAL_MESSAGE_CHAR_BUDGET`), the file is lossless.

## Kimi Crew setup

Copy the profile once before using `profile=oc-kimi-crew`:

```sh
mkdir -p ~/.config/opencode/agents
cp opencode/agents/kimi-crew.md ~/.config/opencode/agents/kimi-crew.md
```

Clanker supplies only `default_agent: "kimi-crew"`; the installed profile and existing child profiles own prompts, skills, and delegation permissions.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run bundle
```
