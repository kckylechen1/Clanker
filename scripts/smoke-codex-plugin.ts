/** Explicit paid smoke: only temporary fixture data is sent to the selected model. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [pluginPath, model, mode = "read"] = process.argv.slice(2);
if (!pluginPath || !model?.includes("/") || !["read", "write"].includes(mode)) {
  throw new Error("usage: smoke-codex-plugin.ts <plugin-path> <provider/model> [read|write]");
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clanker-live-smoke-")));
const fixture = path.join(root, "fixture");
fs.mkdirSync(fixture);
const token = crypto.randomUUID();
fs.writeFileSync(path.join(fixture, "challenge.txt"), token);
const git = (args: string[]) => execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
git(["init", "-b", "main"]);
git(["add", "challenge.txt"]);
git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"]);
const client = new Client({ name: "clanker-live-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.resolve(pluginPath, "dist/clanker-mcp.mjs"), "--host", "codex", "--codex-direct"], cwd: fixture,
  env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    CLANKER_RUNS_ROOT: path.join(root, "runs"), CLANKER_WORKTREES_ROOT: path.join(root, "worktrees"),
    CLANKER_LEDGER_DIR: path.join(root, "ledger"), CLANKER_TURN_TIMEOUT_MS: "180000" }, stderr: "pipe" });
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 65_000 });
  if (r.isError) throw new Error(`tool ${name} refused: ${JSON.stringify(r.content)}`);
  if (r.structuredContent) return r.structuredContent as Record<string, any>;
  return JSON.parse((r.content as { type: string; text: string }[]).find(c => c.type === "text")!.text);
}
async function wait(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call("clanker_wait", { id, timeout_ms: 55000, quiet: true });
    if (r.status !== "running" && r.continuation?.reason !== "turn_finishing") return r;
    if (r.continuation?.reason === "turn_finishing") await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("smoke wait budget exhausted");
}
let id: string | undefined;
try {
  await client.connect(transport);
  const catalog = await call("clanker_models", { provider: model.split("/")[0] });
  assert.ok(catalog.models.includes(model), "requested model must appear in configured catalog");
  const write = mode === "write";
  ({ id } = await call(write ? "clanker_start_oc-managed-write" : "clanker_start_oc-managed-review", {
    cwd: fixture, model, ...(write ? { worktree: `smoke-${Date.now()}`, base: "HEAD" } : {}),
    prompt: "Read challenge.txt using a file tool. " + (write ? "Write its exact contents to proof.txt. Do not commit. " : "Do not modify any files. ") +
      "Reply with only the exact file contents. No delegation or network tools. This is a temporary test fixture.",
  }));
  assert.ok(id);
  const first = await wait(id);
  assert.equal(first.status, "done", `first turn failed: ${first.failure_class ?? "unknown"}`);
  assert.ok(fs.readFileSync(first.result_path, "utf8").includes(token), "first result must contain the unseen file challenge");
  assert.equal(first.continuation.can_prompt, true);
  if (write) {
    const view = await call("clanker_status", { id });
    assert.equal(fs.readFileSync(path.join(view.worktree, "proof.txt"), "utf8").trim(), token);
    assert.equal(fs.existsSync(path.join(fixture, "proof.txt")), false);
  }
  await call("clanker_prompt", { id, correction: true,
    prompt: "Recall the exact contents of challenge.txt from our previous turn and reply with those contents followed by FOLLOWUP_OK. Do not edit files." });
  const second = await wait(id);
  assert.equal(second.status, "done");
  const result = fs.readFileSync(second.result_path, "utf8");
  assert.ok(result.includes(token) && result.includes("FOLLOWUP_OK"));
  assert.equal(second.continuation.can_prompt, false);
  assert.equal(second.telemetry.turns, 2);
  assert.ok(second.telemetry.observed_model, "observed model identity must be available");
  assert.equal((second.warnings ?? []).some((s: string) => s.includes("CLANKER-BACKEND-MODEL")), false);
  console.log(JSON.stringify({ result: "PASS", model, observed_model: second.telemetry.observed_model,
    mode, turns: second.telemetry.turns, run_id: id, evidence: second.result_path }));
} finally {
  if (id) await call("clanker_cancel", { id }).catch(() => {});
  await client.close();
  // Keep fixture evidence in tmp; the plugin never writes a real repository.
  console.error(`Smoke artifacts: ${root}`);
}
