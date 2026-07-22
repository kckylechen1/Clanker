import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_VERSION } from "../src/constants.js";
import { hostLaneBlockedReason, laneNamesForHost, parseHostArgs } from "../src/host.js";
import { LaneManager } from "../src/manager.js";
import { registerTools } from "../src/tools.js";

test("host parser defaults and accepts both CLI forms", () => {
  assert.equal(parseHostArgs([]), "standalone");
  assert.equal(parseHostArgs(["--host", "codex"]), "codex");
  assert.equal(parseHostArgs(["--host=claude"]), "claude");
  assert.throws(() => parseHostArgs(["--host", "bad"]), /invalid --host/);
  assert.throws(() => parseHostArgs(["--host=codex", "--host", "claude"]), /duplicate --host/);
});

test("codex host lane set and block reason prohibit only self-dispatch", () => {
  assert.deepEqual(laneNamesForHost("codex"), ["opencode", "grok"]);
  assert.deepEqual(laneNamesForHost("claude"), ["codex", "opencode", "grok"]);
  assert.match(hostLaneBlockedReason("codex", "codex") ?? "", /self-dispatch/);
  assert.equal(hostLaneBlockedReason("codex", "grok"), undefined);
});

type Registered = { config: { inputSchema: Record<string, unknown> }; handler: (args: any) => Promise<any> };
function captureTools(manager: any) {
  const tools = new Map<string, Registered>();
  const server = { registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
    tools.set(name, { config, handler });
  } } as unknown as McpServer;
  registerTools(server, manager);
  return tools;
}

test("codex schemas omit codex, omit GLM supervisor tool, and handlers loudly block raw bypass", async () => {
  let calls = 0;
  const tools = captureTools({ host: "codex", async dispatchStart() { calls += 1; return { id: "bad", warnings: [] }; } });
  assert.equal(tools.has("clanker_dispatch_glm_write_start"), false);
  for (const name of ["clanker_dispatch_start", "clanker_dispatch_readonly_start", "clanker_dispatch_write_start", "clanker_dispatch"]) {
    const tool = tools.get(name)!;
    const schema = z.object(tool.config.inputSchema as z.ZodRawShape);
    const base = { lane: "codex", prompt: "no", model: "terra", worktree: "test/blocked" };
    assert.equal(schema.safeParse(base).success, false, `${name} schema must omit codex`);
    const response = await tool.handler(base);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.telemetry.host, "codex");
    assert.equal(payload.telemetry.requested_lane, "codex");
    assert.equal(payload.telemetry.actual_lane, null);
    assert.match(payload.telemetry.blocked_reason, /self-dispatch/);
  }
  const writeSchema = z.object(tools.get("clanker_dispatch_write_start")!.config.inputSchema as z.ZodRawShape);
  assert.equal(
    writeSchema.safeParse({ lane: "opencode", prompt: "write", worktree: "test/external-write" }).success,
    false,
    "codex host exposes only external write lanes, so its schema can require model directly",
  );
  assert.equal(calls, 0);
});

test("Claude retains dedicated GLM tool and manager blocks codex before run creation", async () => {
  assert.equal(captureTools({ host: "claude" }).has("clanker_dispatch_glm_write_start"), true);
  let resolves = 0;
  const manager = new LaneManager({ host: "codex", disableReaper: true, resolveSpec() {
    resolves += 1; throw new Error("must not resolve");
  } });
  await assert.rejects(manager.dispatchStart({ lane: "codex", prompt: "no", readOnly: true }), /self-dispatch/);
  assert.equal(resolves, 0, "host policy must reject before run setup reaches backend resolution");
  await manager.shutdown();
});

test("manager rejects the codex lane name as a model before backend resolution", async () => {
  let resolves = 0;
  const manager = new LaneManager({
    host: "claude",
    disableReaper: true,
    resolveSpec() {
      resolves += 1;
      throw new Error("must not resolve");
    },
  });
  await assert.rejects(
    manager.dispatchStart({ lane: "codex", model: " CODEX ", prompt: "no", readOnly: true }),
    /lane name, not a Codex model id; omit model/,
  );
  assert.equal(resolves, 0, "invalid alias must not reach CODEX_CONFIG construction");
  await manager.shutdown();
});

test("write tool surfaces the manager's codex model-alias rejection", async () => {
  let resolves = 0;
  const manager = new LaneManager({
    host: "claude",
    disableReaper: true,
    resolveSpec() {
      resolves += 1;
      throw new Error("must not resolve");
    },
  });
  const writeTool = captureTools(manager).get("clanker_dispatch_write_start")!;
  const response = await writeTool.handler({
    lane: "codex",
    model: "codex",
    prompt: "no",
    worktree: "test/invalid-codex-model",
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /lane name, not a Codex model id; omit model/);
  assert.equal(resolves, 0, "write tool must not leak a lane-name alias into backend config");
  await manager.shutdown();
});

test("plugin manifests, synchronized skill, marketplace, and bundles follow the adapter contract", () => {
  const manifest = JSON.parse(fs.readFileSync("codex-plugin/.codex-plugin/plugin.json", "utf8"));
  const claudeManifest = JSON.parse(fs.readFileSync("plugin/.claude-plugin/plugin.json", "utf8"));
  const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const mcp = JSON.parse(fs.readFileSync("codex-plugin/.mcp.json", "utf8"));
  const market = JSON.parse(fs.readFileSync(".agents/plugins/marketplace.json", "utf8"));
  const claudeSkill = fs.readFileSync("plugin/skills/using-clanker/SKILL.md");
  const codexSkill = fs.readFileSync("codex-plugin/skills/using-clanker/SKILL.md");
  const claudeEvals = fs.readFileSync("plugin/skills/using-clanker/evals/evals.json");
  const codexEvals = fs.readFileSync("codex-plugin/skills/using-clanker/evals/evals.json");
  const skill = claudeSkill.toString("utf8");
  assert.equal(manifest.name, "clanker");
  assert.equal(manifest.version, "0.2.5");
  assert.equal(claudeManifest.version, manifest.version);
  assert.equal(packageManifest.version, manifest.version);
  assert.equal(SERVER_VERSION, manifest.version);
  assert.equal(packageManifest.scripts["bundle:skills"], "node scripts/sync-plugin-skills.mjs");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.apps, undefined);
  assert.deepEqual(manifest.interface.capabilities, ["Interactive", "Read", "Write"]);
  assert.deepEqual(mcp.mcpServers.clanker, {
    command: "node", args: ["dist/clanker-mcp.mjs", "--host", "codex"], cwd: ".",
  });
  assert.deepEqual(market.plugins[0].source, { source: "local", path: "./codex-plugin" });
  assert.deepEqual(market.plugins[0].policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
  assert.deepEqual(codexSkill, claudeSkill);
  assert.deepEqual(codexEvals, claudeEvals);
  assert.equal(fs.existsSync("codex-plugin/skills/dispatching-clankers/SKILL.md"), false);
  assert.match(skill, /^---\nname: using-clanker\n/);
  assert.match(skill, /native Sol, Luna, Terra, and 5\.5 work on native V1/);
  assert.match(skill, /`lane=codex`: `model` is optional/);
  assert.match(skill, /Never pass `model=codex`/);
  assert.match(skill, /explicit model id or supported model alias is required/);
  assert.match(skill, /Sonnet `clanker:supervisor`/);
  assert.match(skill, /Call `clanker_wait`/);
  assert.match(skill, /Never silently substitute a lane/);
  assert.match(skill, /fall back to a direct CLI/);
  assert.doesNotMatch(JSON.stringify(mcp), /\$\{(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}/);
  assert.equal(fs.existsSync("codex-plugin/dist/clanker-mcp.mjs"), true);
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "codex-plugin/dist/clanker-mcp.mjs"]);
  assert.equal(ignored.status, 1, "Codex bundle must be force-included so a git checkout remains installable");
  assert.deepEqual(
    fs.readFileSync("plugin/dist/clanker-mcp.mjs"),
    fs.readFileSync("codex-plugin/dist/clanker-mcp.mjs"),
  );
  for (const sidecar of ["plugin/dist/codex-acp.mjs", "codex-plugin/dist/codex-acp.mjs"]) {
    assert.equal(fs.existsSync(sidecar), true, `${sidecar} must be included in the installable plugin`);
    const sidecarIgnored = spawnSync("git", ["check-ignore", "--quiet", sidecar]);
    assert.equal(sidecarIgnored.status, 1, `${sidecar} must be force-included in git`);
  }
  assert.deepEqual(
    fs.readFileSync("plugin/dist/codex-acp.mjs"),
    fs.readFileSync("codex-plugin/dist/codex-acp.mjs"),
  );
});
