# Clanker

Clanker is a thin cross-harness job controller. It starts an ACP-backed job, records progress/results, waits, reports status, cancels with escalation, and conservatively cleans managed worktrees. It does not choose orchestration strategies or hold provider credentials.

## MCP API

Five lifecycle tools are exposed — `clanker_start`, `clanker_wait`, `clanker_status`, `clanker_cancel`, `clanker_list` — plus one generated `clanker_start_<profile>` tool per row of the dispatch-profile registry (`src/profiles.ts`).

`clanker_start` accepts `profile`, `prompt`, and optional `cwd`, `worktree`, `model` and `effort`. It has no `lane`, `read_only` or `sandbox` parameter: a **dispatch profile** is the whole capability combination under one name — lane, write mode, sandbox, worktree isolation, required vault credentials, supervision, role class and per-profile turn ceiling. Each generated `clanker_start_<profile>` tool exposes only that profile's free parameters, so a seat holding one cannot ask for a capability the profile does not grant.

| profile | lane | writes | worktree | model | notes |
|---|---|---|---|---|---|
| `codex-review` | codex | no | forbidden | lane default | sandbox welded `read-only` |
| `codex-write` | codex | yes | required | lane default | sandbox welded `workspace-write` |
| `oc-review` | opencode | no | forbidden | required | fixed `clanker-worker` profile |
| `oc-write` | opencode | yes | required | required, non-GLM | fixed `clanker-worker` profile |
| `oc-glm-write` | opencode | yes | required | welded `glm` | `ZHIPUAI_API_KEY` via vault; Sonnet supervision |
| `oc-kimi-crew` | opencode | yes | required | welded `kimi` | installed OpenCode `kimi-crew` profile |
| `gemini-recon` | gemini | no | forbidden | lane default | 11-minute turn ceiling |
| `grok-review` | grok | no | forbidden | required | dormant: HTTP 402 |
| `grok-write` | grok | yes | required | required | dormant: HTTP 402 |

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
