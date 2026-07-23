---
description: "Dispatch read-only reconnaissance to Clanker: Gemini."
argument-hint: "[--background|--wait] [--model <gemini-model>] [--effort medium|high] <research task>"
allowed-tools: Agent
---

Dispatch the request to `Agent(subagent_type="clanker:gemini")`. This command is read-only; reject any request for edits or a `--write` flag.

Parse `$ARGUMENTS`: pass natural-language task text as `prompt`; pass an optional Gemini `--model` and `--effort medium|high` unchanged; reject non-Gemini model ids and omit the flags from the prompt. `--background` and `--wait` control only the outer Agent call. Default to `run_in_background: true`; use foreground only for `--wait`.

The Agent task must say: `Dispatch as Clanker: Gemini. prompt=<task>. model=<explicit model or omit>. effort=<explicit effort or omit>. Follow your relay protocol.` Do not call MCP tools in this conversation. For background launch, reply only: `Clanker: Gemini started in the Claude Code background task list.`
