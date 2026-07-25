# Clanker

Clanker is a thin cross-harness job controller. It starts an ACP-backed job, records progress/results, waits, reports status, cancels with escalation, and conservatively cleans managed worktrees. It does not choose orchestration strategies or hold provider credentials.

## MCP API

Four lifecycle tools are exposed — `clanker_wait`, `clanker_status`, `clanker_cancel`, `clanker_list` — plus one generated `clanker_start_<profile>` tool per row of the dispatch-profile registry (`src/profiles.ts`). Those generated tools are the **only** way to start a job.

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
| `grok-review` | grok | no | optional | lane default | n/a | dormant: HTTP 402 |
| `grok-write` | grok | yes | required | required | n/a | dormant: HTTP 402 |

A read-only profile with `isolation: optional` runs in the working checkout by default and inside a managed worktree when you name one — the recipe for a review that must actually run build/test tooling.

Policy stays server-side: a host cannot dispatch itself; Gemini is fixed read-only and rejects worktrees; writes require a managed worktree cut from the target repo and cannot target the primary checkout; non-Codex writes require an explicit model; a GLM write is possible only through the supervised `oc-glm-write` profile.

Credentials are never parameters. OpenCode's own auth store owns everything OAuth-backed; the one bare API key in play, GLM's `ZHIPUAI_API_KEY`, is materialized from the OS keychain at spawn time by rewriting the spawn command to `tachi vault exec --keychain --require ZHIPUAI_API_KEY -- <original command>`, so it never lives in Clanker's or the ambient shell's environment.

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
