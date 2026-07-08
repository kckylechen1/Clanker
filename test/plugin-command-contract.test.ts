import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const commands = [
  { file: "codex.md", subagent: "clanker:codex", started: "Clanker: Codex started" },
  { file: "grok.md", subagent: "clanker:grok", started: "Clanker: Grok started" },
  { file: "oc.md", subagent: "clanker:oc", started: "Clanker: Opencode started" },
] as const;

const fixedModelCommands = [
  { file: "glm.md", label: "GLM", model: "glm" },
  { file: "deepseek.md", label: "DeepSeek", model: "ds" },
  { file: "kimi.md", label: "Kimi", model: "kimi" },
  { file: "free.md", label: "Free", model: "free" },
] as const;

for (const command of commands) {
  test(`${command.file} keeps Claude Agent as the visible background task owner`, async () => {
    const body = await readFile(new URL(`../plugin/commands/${command.file}`, import.meta.url), "utf8");
    const backgroundSection = body.split("Background flow:")[1]?.split("Foreground flow:")[0] ?? "";

    assert.match(body, /argument-hint: .*--background\|--wait/);
    assert.match(body, new RegExp(`subagent_type: "${command.subagent}"`));
    assert.match(body, /If neither flag is present, default to background/);
    assert.match(body, /run_in_background: true/);
    assert.match(body, /Do not call MCP dispatch tools in the main conversation/);
    assert.match(body, /Do not wait for the subagent or relay a final result in this turn/);
    assert.match(body, new RegExp(`${command.started} in the Claude Code background task list`));
    assert.match(body, /If the raw request includes `--wait`, run the `clanker:/);
    assert.doesNotMatch(body, /Background by default/);
    assert.match(backgroundSection, /Do not wait for the subagent or relay a final result in this turn/);
  });
}

for (const command of fixedModelCommands) {
  test(`${command.file} exposes Clanker: ${command.label} as a fixed Opencode model`, async () => {
    const body = await readFile(new URL(`../plugin/commands/${command.file}`, import.meta.url), "utf8");

    assert.match(body, new RegExp(`Clanker: ${command.label}`));
    assert.match(body, /subagent_type: "clanker:oc"/);
    assert.match(body, new RegExp(`Fixed \`model: "${command.model}"\``));
    assert.match(body, new RegExp(`model=${command.model}`));
    assert.match(body, new RegExp(`Clanker: ${command.label} started in the Claude Code background task list`));
    assert.match(body, /If neither flag is present, default to background/);
    assert.match(body, /Do not call MCP dispatch tools in the main conversation/);
  });
}

test("README documents the Claude-owned lifecycle instead of shell-style completion", async () => {
  const body = await readFile(new URL("../plugin/README.md", import.meta.url), "utf8");

  assert.match(body, /The Claude `Agent` call is the visible lifecycle owner/);
  assert.match(body, /Claude-owned background Clanker task by default/);
  assert.match(body, /task is visible under Claude Code, no shell notification dependency/);
  assert.match(body, /\/clanker:glm/);
  assert.doesNotMatch(body, /ACP turn, blocking, cannot detach/);
});

test("plugin metadata uses Clanker as the user-visible name", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    displayName: string;
    description: string;
    keywords: string[];
  };
  const marketplace = JSON.parse(
    await readFile(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    description: string;
    plugins: Array<{ name: string; description: string }>;
  };

  assert.equal(manifest.name, "clanker");
  assert.equal(manifest.displayName, "Clanker");
  assert.match(manifest.description, /Clanker tasks/);
  assert.ok(manifest.keywords.includes("clanker"));
  assert.ok(manifest.keywords.includes("glm"));
  assert.equal(marketplace.name, "clanker");
  assert.match(marketplace.description, /Clanker/);
  assert.equal(marketplace.plugins[0].name, "clanker");
  assert.match(marketplace.plugins[0].description, /Clanker tasks/);
});
