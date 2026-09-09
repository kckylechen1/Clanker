import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packaged Codex plugin negotiates MCP, discovers routes, rejects invalid input and closes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-plugin-wire-"));
  const executable = path.join(root, "opencode");
  fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("dgx-a/coder\\ndgx-b/reviewer\\nkimi-for-coding/k3");\n', { mode: 0o700 });
  const artifact = path.resolve("clanker-codex/dist/clanker-mcp.mjs");
  const transport = new StdioClientTransport({ command: process.execPath, args: [artifact, "--host", "codex", "--codex-direct"], cwd: root,
    env: { PATH: `${root}${path.delimiter}${process.env.PATH}`, CLANKER_RUNS_ROOT: path.join(root, "runs"),
      CLANKER_WORKTREES_ROOT: path.join(root, "worktrees"), CLANKER_LEDGER_DIR: path.join(root, "ledger") }, stderr: "pipe" });
  const client = new Client({ name: "clanker-plugin-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === "clanker_start_oc-managed-write"));
    assert.ok(tools.some(t => t.name === "clanker_start_oc-managed-review"));
    assert.equal(tools.some(t => t.name === "clanker_start_oc-glm-write"), false);
    assert.equal(tools.some(t => t.name === "clanker_start_codex-write"), false);
    const first = await client.callTool({ name: "clanker_models", arguments: { limit: 1 } });
    assert.deepEqual(first.structuredContent, { models: ["dgx-a/coder"], total: 3, next_offset: 1, availability: "configured_only" });
    const last = await client.callTool({ name: "clanker_models", arguments: { offset: 1, limit: 2 } });
    assert.deepEqual(last.structuredContent, { models: ["dgx-b/reviewer", "kimi-for-coding/k3"], total: 3, next_offset: null, availability: "configured_only" });
    const empty = await client.callTool({ name: "clanker_models", arguments: { provider: "absent" } });
    assert.deepEqual(empty.structuredContent, { models: [], total: 0, next_offset: null, availability: "configured_only" });
    const invalid = await client.callTool({ name: "clanker_models", arguments: { provider: "--execute", limit: 0 } });
    assert.equal(invalid.isError, true);
    const missing = await client.callTool({ name: "clanker_start_oc-managed-write", arguments: { model: "dgx-a/coder", prompt: "no worktree" } });
    assert.equal(missing.isError, true);
    fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.error("fake-sensitive-diagnostic");process.exit(1);\n');
    const failure = await client.callTool({ name: "clanker_models", arguments: {} });
    assert.equal(failure.isError, true);
    assert.equal(JSON.stringify(failure).includes("fake-sensitive-diagnostic"), false);
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
