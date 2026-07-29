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
| `cursor-review` | `clanker:cursor` |
| `grok-review` | `clanker:grok` (dormant: HTTP 402) |
| `codex-write` / `oc-write` / `cursor-write` / `grok-write` | `clanker:writer` |
| `oc-glm-write` | `clanker:supervisor` |
| `oc-kimi-crew` | `clanker:crew` |

Pass only the free parameters that profile accepts: always `prompt`, plus `cwd`/`effort`, plus `worktree` — mandatory for every write profile, and **also accepted by a read-only profile whose isolation is optional** (`codex-review`, `oc-review`, `grok-review`, `cursor-review`): name one when the review has to run build or test tooling, omit it to read the working checkout in place. Plus `model` where the profile requires an explicit one or accepts an optional one (the `codex-*` and `cursor-*` pairs take an optional model and otherwise run their pinned default — Clanker's own pin, not the harness's config file). Never ask for a lane, a read-only flag, a sandbox, or a welded model — those parameters do not exist on the seat's tool.
