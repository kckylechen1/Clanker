---
description: Start a Clanker job by naming a dispatch profile
argument-hint: "<profile> <task> [cwd/worktree/model/effort]"
allowed-tools: Agent
---

Dispatch exactly one `Agent(subagent_type=...)`: the seat that owns the requested profile. The profile — not a bag of parameters — decides lane, write mode, sandbox, isolation, credentials and deadline. Do not apply routing policy client-side; Clanker enforces it.

| profile | seat |
|---|---|
| `codex-review` | `clanker:codex` |
| `oc-review` | `clanker:oc` |
| `gemini-recon` / `gemini-research` | `clanker:gemini` |
| `grok-review` | `clanker:grok` (dormant: HTTP 402) |
| `codex-write` / `oc-write` / `grok-write` | `clanker:writer` |
| `oc-glm-write` | `clanker:supervisor` |
| `oc-kimi-crew` | `clanker:crew` |

Pass only the free parameters that profile accepts: always `prompt`, plus `cwd`/`effort`, plus `worktree` for write profiles and `model` where the profile requires an explicit one. Never ask for a lane, a read-only flag, a sandbox, or a welded model — those parameters do not exist on the seat's tool.
