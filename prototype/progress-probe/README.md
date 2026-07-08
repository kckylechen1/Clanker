# progress-probe — Step 0 prototype

The smallest MCP server that streams `notifications/progress`. Its only job is to
let the **leader** decide, by direct observation, whether Claude Code bubbles a
**nested subagent's** MCP progress up to the **bottom task line**. If it does,
channel one of the Clanker spec (plan → `notifications/progress` → live checkbox on
the task row) is free. If it does not, channel two (inbox/cockpit) carries the load.

**This prototype does not decide the outcome.** The verdict is `PENDING-LEADER-TEST`.

## The tool

`probe_progress(steps=5, interval_ms=1000)` emits `steps` progress notifications,
one every `interval_ms`, each with a checkbox-style `message`:

```
[1/5] ⋯step1 step2 step3 step4 step5
[2/5] ✓step1 ⋯step2 step3 step4 step5
...
[5/5] ✓step1 ✓step2 ✓step3 ✓step4 ✓step5
```

## Setup

```bash
cd Projects/Clanker/prototype/progress-probe
npm install
```

## Register it (leader runs this)

`claude mcp add` needs an absolute path. From this directory:

```bash
claude mcp add progress-probe -s local -- node "$(pwd)/index.mjs"
```

(To remove afterwards: `claude mcp remove progress-probe`.)

## The test (leader runs this)

The point is **nested** progress — a subagent, not the main thread — because that
is how the Clanker relay agents run. So:

1. Restart Claude Code (or `/reload-plugins`) so it picks up the new MCP server, and
   confirm the `probe_progress` tool is listed.
2. From the main thread, launch a subagent **in the background** whose whole job is to
   call the tool once, e.g.:

   > Use the Agent tool, run_in_background, subagent_type "general-purpose", with this
   > prompt: "Call the `probe_progress` MCP tool with steps=8, interval_ms=1500. Report
   > the tool's final text when it returns. Do nothing else."

3. While it runs, **watch the bottom task line** for that background subagent.

## What to observe → verdict

- **If the bottom task line shows the changing `[k/8] ✓… ⋯…` progress text** while the
  subagent runs → channel one bubbles through nested subagents. Mark the spec's
  channel-one bet **CONFIRMED**; the Clanker server's `CLANKER_PROGRESS_EXPERIMENTAL=1`
  path becomes the default projection.
- **If the task line only shows a generic spinner / token count** (no progress text) →
  channel one does **not** bubble nested progress. Keep it experimental-only and lean on
  channel two (inbox) in Step 2.
- Either way, also note whether the progress notifications **reset the tool-call
  timeout** (the subagent should not hit a 10-minute wall even with long intervals).

Record the observed behavior against issue #698. Until then: **`PENDING-LEADER-TEST`**.
