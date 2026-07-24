# Clanker plugin

The plugin exposes one seat per dispatch profile family — `agents/codex.md`, `agents/oc.md`, `agents/gemini.md`, `agents/grok.md`, `agents/writer.md`, `agents/supervisor.md`, `agents/crew.md` — and three commands: `/clanker:clanker`, `/clanker:kimi-crew`, and read-only `/clanker:gemini`.

Each seat holds only the narrow `clanker_start_<profile>` tool(s) it is allowed to use. Those tools have no `lane`, `read_only` or `sandbox` parameter and no `model` parameter where the profile welds one, so a seat cannot ask for a capability its profile does not grant — the read-only relays are mechanically read-only, not read-only by instruction. Server-side policy in `LaneManager` stays authoritative underneath.

Every relay starts once, polls with `clanker_wait`, and returns the terminal result verbatim. Only `agents/supervisor.md` (Sonnet, the `oc-glm-write` profile) additionally holds `clanker_prompt`/`clanker_cancel`. No seat duplicates host, model, write, or worktree policy.

For Kimi Crew, first copy `../opencode/agents/kimi-crew.md` to `~/.config/opencode/agents/kimi-crew.md` as documented in the repository README.
