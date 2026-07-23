# Clanker plugin

The plugin exposes one generic relay (`agents/clanker.md`) and three commands: `/clanker:clanker`, `/clanker:kimi-crew`, and read-only `/clanker:gemini`. Every command reaches the unified `clanker_start` API; server-side policy is authoritative.

The relay starts once, polls with `clanker_wait`, and returns the terminal result verbatim. It does not duplicate host, model, write, or worktree policy.

For Kimi Crew, first copy `../opencode/agents/kimi-crew.md` to `~/.config/opencode/agents/kimi-crew.md` as documented in the repository README.
