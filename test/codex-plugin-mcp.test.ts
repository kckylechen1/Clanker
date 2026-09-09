import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Codex-direct default cache roots exclude legacy run retention, with explicit overrides preserved", () => {
  const env = { ...process.env };
  delete env.CLANKER_RUNS_ROOT;
  delete env.CLANKER_WORKTREES_ROOT;
  const inspect = (direct: boolean, childEnv = env) => JSON.parse(execFileSync(process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e",
      `${direct ? 'process.argv.push("--codex-direct");' : ''} const m = await import('./src/constants.ts'); console.log(JSON.stringify([m.RUNS_ROOT,m.WORKTREES_ROOT]));`],
    { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.deepEqual(inspect(true), [path.join(os.homedir(), ".cache/clanker-codex/runs"), path.join(os.homedir(), ".cache/clanker-codex/worktrees")]);
  assert.deepEqual(inspect(false), [path.join(os.homedir(), ".cache/clanker/runs"), path.join(os.homedir(), ".cache/clanker/worktrees")]);
  assert.deepEqual(inspect(true, { ...env, CLANKER_RUNS_ROOT: "/explicit/runs", CLANKER_WORKTREES_ROOT: "/explicit/worktrees" }), ["/explicit/runs", "/explicit/worktrees"]);
});

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
    assert.deepEqual(tools.map(t => t.name).sort(), [
      "clanker_start_oc-managed-review", "clanker_start_oc-managed-write", "clanker_models",
      "clanker_wait", "clanker_status", "clanker_cancel", "clanker_list", "clanker_prompt",
    ].sort());
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
