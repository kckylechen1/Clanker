# Clanker

Clanker is a thin cross-harness job controller. It starts an ACP-backed job, records progress/results, waits, reports status, cancels with escalation, and conservatively cleans managed worktrees. It does not choose orchestration strategies or hold provider credentials.

## MCP API

Exactly five public tools are exposed: `clanker_start`, `clanker_wait`, `clanker_status`, `clanker_cancel`, and `clanker_list`.

`clanker_start` accepts `lane`, `prompt`, and optional `cwd`, `worktree`, `model`, `effort`, `read_only`, `sandbox`, and `profile`. `profile` is `worker` (default) or `kimi-crew`.

Policy is server-side: a host cannot dispatch itself; Gemini is fixed read-only and rejects worktrees/non-worker profiles; writes require a managed worktree and cannot target the primary checkout; non-Codex writes require an explicit model; direct GLM writes are rejected. `profile=kimi-crew` fixes OpenCode/Kimi/write mode and uses the installed OpenCode profile.

OpenCode authentication belongs to OpenCode's auth store. Clanker never reads or injects API keys and never wraps OpenCode with `tachi vault exec`.

## Kimi Crew setup

Copy the profile once before using `profile=kimi-crew`:

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
