# Clanker plugin

The plugin exposes one seat per dispatch profile family — `agents/codex.md`, `agents/oc.md`, `agents/gemini.md`, `agents/grok.md`, `agents/writer.md`, `agents/supervisor.md`, `agents/crew.md` — and three commands: `/clanker:clanker`, `/clanker:kimi-crew`, and read-only `/clanker:gemini`.

Each seat holds only the narrow `clanker_start_<profile>` tool(s) it is allowed to use. Those tools have no `lane`, `read_only` or `sandbox` parameter and no `model` parameter where the profile welds one, so a seat cannot ask for a capability its profile does not grant — the read-only relays are mechanically read-only, not read-only by instruction. Server-side policy in `LaneManager` stays authoritative underneath.

Every relay starts once, polls with `clanker_wait`, and then delivers **pointers, not prose**: `id`, `run_dir`, `result_path`, `status`, `touched_files`, `plan_final`. No seat may restate `final_message` — "reproduce this text verbatim" is precisely the instruction a language model cannot honor, so the verdict is handed over as a path (`result_path` → `result.md`) and the caller reads the bytes. A terminal run with no `result_path` gets `CLANKER-NO-RESULT:` and a full stop, never an invented summary. Only `agents/supervisor.md` (Sonnet, the `oc-glm-write` profile) additionally holds `clanker_prompt`/`clanker_cancel`. No seat duplicates host, model, write, or worktree policy.

For Kimi Crew, first copy `../opencode/agents/kimi-crew.md` to `~/.config/opencode/agents/kimi-crew.md` as documented in the repository README.
