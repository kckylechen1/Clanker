import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { SERVER_VERSION } from "../src/constants.js";
import { hostLaneBlockedReason, laneNamesForHost, parseHostArgs } from "../src/host.js";
import { LaneManager } from "../src/manager.js";
import { LANE_NAMES } from "../src/types.js";

test("host parser defaults and accepts both CLI forms", () => {
  assert.equal(parseHostArgs([]), "standalone");
  assert.equal(parseHostArgs(["--host", "codex"]), "codex");
  assert.equal(parseHostArgs(["--host=claude"]), "claude");
  assert.throws(() => parseHostArgs(["--host", "bad"]), /invalid --host/);
  assert.throws(() => parseHostArgs(["--host=codex", "--host", "claude"]), /duplicate --host/);
});

test("codex host prohibits only self-dispatch", () => {
  assert.deepEqual(laneNamesForHost("codex"), ["opencode", "grok", "gemini", "cursor"]);
  assert.deepEqual(laneNamesForHost("claude"), ["codex", "opencode", "grok", "gemini", "cursor"]);
  assert.match(hostLaneBlockedReason("codex", "codex") ?? "", /self-dispatch/);
  assert.equal(hostLaneBlockedReason("codex", "grok"), undefined);
  // The cursor lane is nobody's own harness, so no host self-dispatches it —
  // it must be reachable from every host, including the Codex adapter.
  assert.equal(hostLaneBlockedReason("codex", "cursor"), undefined);
  assert.equal(hostLaneBlockedReason("claude", "cursor"), undefined);
  // The codex list is DERIVED (host.ts) — every lane but the host's own, with
  // nothing dropped. A literal list here would go stale silently; this one
  // fails the moment the derivation stops covering the registry.
  assert.deepEqual(
    [...laneNamesForHost("codex")].sort(),
    LANE_NAMES.filter((lane) => lane !== "codex").sort(),
  );
});

test("manager blocks host self-dispatch before backend resolution", async () => {
  let resolves = 0;
  const manager = new LaneManager({ host: "codex", disableReaper: true, resolveSpec() {
    resolves += 1; throw new Error("must not resolve");
  } });
  await assert.rejects(manager.dispatchStart({ lane: "codex", prompt: "no", readOnly: true }), /self-dispatch/);
  assert.equal(resolves, 0);
  await manager.shutdown();
});

test("manager rejects codex lane name as model before backend resolution", async () => {
  let resolves = 0;
  const manager = new LaneManager({ host: "claude", disableReaper: true, resolveSpec() {
    resolves += 1; throw new Error("must not resolve");
  } });
  await assert.rejects(manager.dispatchStart({ lane: "codex", model: " CODEX ", prompt: "no", readOnly: true }), /lane name, not a Codex model id/);
  assert.equal(resolves, 0);
  await manager.shutdown();
});

test("plugin manifests, synchronized skill, marketplace, and bundles retain adapter metadata", () => {
  const manifest = JSON.parse(fs.readFileSync("codex-plugin/.codex-plugin/plugin.json", "utf8"));
  const claudeManifest = JSON.parse(fs.readFileSync("plugin/.claude-plugin/plugin.json", "utf8"));
  const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const mcp = JSON.parse(fs.readFileSync("codex-plugin/.mcp.json", "utf8"));
  const market = JSON.parse(fs.readFileSync(".agents/plugins/marketplace.json", "utf8"));
  assert.equal(manifest.version, SERVER_VERSION);
  assert.equal(claudeManifest.version, manifest.version);
  assert.equal(packageManifest.version, manifest.version);
  assert.deepEqual(manifest.interface.capabilities, ["Interactive", "Read", "Write"]);
  assert.deepEqual(mcp.mcpServers.clanker, { command: "node", args: ["dist/clanker-mcp.mjs", "--host", "codex"], cwd: "." });
  assert.deepEqual(market.plugins[0].source, { source: "local", path: "./codex-plugin" });
  assert.deepEqual(fs.readFileSync("plugin/skills/using-clanker/SKILL.md"), fs.readFileSync("codex-plugin/skills/using-clanker/SKILL.md"));
  assert.deepEqual(fs.readFileSync("plugin/dist/clanker-mcp.mjs"), fs.readFileSync("codex-plugin/dist/clanker-mcp.mjs"));
  assert.equal(spawnSync("git", ["check-ignore", "--quiet", "codex-plugin/dist/clanker-mcp.mjs"]).status, 1);
});
