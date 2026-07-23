import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const commands = [
  { file: "codex.md", subagent: "clanker:codex", writeAgents: ["clanker:writer"], started: "Clanker: Codex started" },
  { file: "grok.md", subagent: "clanker:grok", writeAgents: ["clanker:writer"], started: "Clanker: Grok started" },
  {
    file: "oc.md",
    subagent: "clanker:oc",
    writeAgents: ["clanker:supervisor", "clanker:writer"],
    started: "Clanker: Opencode started",
  },
] as const;

const fixedModelCommands = [
  { file: "glm.md", label: "GLM", model: "glm", writeAgent: "clanker:supervisor" },
  { file: "deepseek.md", label: "DeepSeek", model: "ds", writeAgent: "clanker:writer" },
  { file: "kimi.md", label: "Kimi", model: "kimi", writeAgent: "clanker:writer" },
  { file: "free.md", label: "Free", model: "free", writeAgent: "clanker:writer" },
] as const;

for (const command of commands) {
  test(`${command.file} keeps Claude Agent as the visible background task owner`, async () => {
    const body = await readFile(new URL(`../plugin/commands/${command.file}`, import.meta.url), "utf8");
    const backgroundSection = body.split("Background flow:")[1]?.split("Foreground flow:")[0] ?? "";
    const writeMapping = body.split("\n").find((line) => line.startsWith("- `--write` present")) ?? "";

    assert.match(body, /argument-hint: .*--background\|--wait/);
    assert.match(body, new RegExp(`subagent_type: "${command.subagent}"`));
    assert.match(writeMapping, /read_only: false/);
    assert.match(writeMapping, /mandatory `worktree`/);
    for (const writeAgent of command.writeAgents) {
      assert.match(writeMapping, new RegExp(`subagent_type: "${writeAgent}"`));
    }
    assert.match(writeMapping, /read_only: true/);
    assert.match(writeMapping, new RegExp(`subagent_type: "${command.subagent}"`));
    assert.match(body, /If neither flag is present, default to background/);
    assert.match(body, /run_in_background: true/);
    assert.match(body, /Do not call MCP dispatch tools in the main conversation/);
    assert.match(body, /Do not wait for the subagent or relay a final result in this turn/);
    assert.match(body, new RegExp(`${command.started} in the Claude Code background task list`));
    assert.match(body, /If the raw request includes `--wait`, run the selected subagent/);
    assert.doesNotMatch(body, /Background by default/);
    assert.match(backgroundSection, /Do not wait for the subagent or relay a final result in this turn/);
  });
}

for (const command of fixedModelCommands) {
  test(`${command.file} exposes Clanker: ${command.label} as a fixed Opencode model`, async () => {
    const body = await readFile(new URL(`../plugin/commands/${command.file}`, import.meta.url), "utf8");
    const writeMapping = body.split("\n").find((line) => line.startsWith("- `--write` present")) ?? "";

    assert.match(body, new RegExp(`Clanker: ${command.label}`));
    assert.match(body, /subagent_type: "clanker:oc"/);
    assert.match(body, new RegExp(`subagent_type: "${command.writeAgent}"`));
    assert.match(writeMapping, /read_only: false/);
    assert.match(writeMapping, /mandatory `worktree`/);
    assert.match(writeMapping, new RegExp(`subagent_type: "${command.writeAgent}"`));
    assert.match(writeMapping, /read_only: true/);
    assert.match(writeMapping, /subagent_type: "clanker:oc"/);
    assert.match(body, new RegExp(`Fixed \`model: "${command.model}"\``));
    assert.match(body, new RegExp(`model=${command.model}`));
    assert.match(body, new RegExp(`Clanker: ${command.label} started in the Claude Code background task list`));
    assert.match(body, /If neither flag is present, default to background/);
    assert.match(body, /Do not call MCP dispatch tools in the main conversation/);
  });
}

for (const relay of ["codex", "grok", "oc"] as const) {
  test(`${relay} relay exposes only the server-forced read-only start tool`, async () => {
    const body = await readFile(new URL(`../plugin/agents/${relay}.md`, import.meta.url), "utf8");
    const frontmatter = body.split("---")[1] ?? "";

    assert.match(frontmatter, /clanker_dispatch_readonly_start/);
    assert.doesNotMatch(frontmatter, /__clanker_dispatch_start(?:,|\s|$)/);
    assert.match(body, /server always forces `readOnly: true`/);
    assert.match(body, /You cannot start a write worker/);
    assert.match(body, /REJECTED-NEEDS-WRITER/);
    assert.match(body, /Agent\(subagent_type="clanker:writer"\)/);
    assert.match(body, /timeout_ms=55000/);
    assert.match(body, /quiet=true/);
  });
}

test("packaged supervisor is restricted to GLM write supervision", async () => {
  const body = await readFile(new URL("../plugin/agents/supervisor.md", import.meta.url), "utf8");
  const frontmatter = body.split("---")[1] ?? "";

  assert.match(frontmatter, /name: supervisor/);
  assert.match(frontmatter, /clanker_dispatch_glm_write_start/);
  assert.doesNotMatch(frontmatter, /__clanker_dispatch_write_start/);
  assert.match(frontmatter, /clanker_wait/);
  assert.match(frontmatter, /clanker_prompt/);
  assert.match(frontmatter, /clanker_cancel/);
  assert.doesNotMatch(frontmatter, /Bash|Edit|Write|Read/);
  assert.match(body, /Accept only `lane=opencode`, `model=glm`, `read_only=false`/);
  assert.match(body, /Do not supervise Terra, Grok, Composer, DeepSeek, Kimi, free, or review runs/);
});

test("packaged writer handles non-GLM writes without correction authority", async () => {
  const body = await readFile(new URL("../plugin/agents/writer.md", import.meta.url), "utf8");
  const frontmatter = body.split("---")[1] ?? "";

  assert.match(frontmatter, /name: writer/);
  assert.match(frontmatter, /clanker_dispatch_write_start/);
  assert.doesNotMatch(frontmatter, /clanker_dispatch_glm_write_start/);
  assert.match(frontmatter, /clanker_wait/);
  assert.doesNotMatch(frontmatter, /clanker_prompt|clanker_cancel|Bash|Edit/);
  assert.match(body, /Reject the Opencode GLM alias `model=glm` and its full id/);
  assert.match(body, /model is optional only for `lane=codex`/i);
  assert.match(body, /for Codex with no model, omit the field entirely/);
  assert.match(body, /timeout_ms=55000/);
});

test("crew command and relay launch exactly one fixed Kimi/OpenCode session", async () => {
  const command = await readFile(new URL("../plugin/commands/kimi-crew.md", import.meta.url), "utf8");
  assert.match(command, /argument-hint: "\[--background\|--wait\] <task>"/);
  assert.match(command, /subagent_type: "clanker:kimi-crew"/);
  assert.match(command, /clanker\/kimi-crew-<short-timestamp>/);
  assert.match(command, /Launch exactly one `Agent`/);
  assert.match(command, /neither flag is present.*run_in_background: true/s);
  assert.doesNotMatch(command, /--write|--model|--read-only|--cwd|--seat/);

  const relay = await readFile(new URL("../plugin/agents/kimi-crew.md", import.meta.url), "utf8");
  const frontmatter = relay.split("---")[1] ?? "";
  assert.match(frontmatter, /clanker_dispatch_kimi_crew_start/);
  assert.match(frontmatter, /clanker_wait/);
  assert.doesNotMatch(frontmatter, /clanker_prompt|clanker_cancel|clanker_dispatch_write_start|Bash|Edit|Write|Read/);
  assert.match(relay, /exactly once/);
  assert.match(relay, /timeout_ms=55000/);
  assert.match(relay, /quiet=true/);
  assert.match(relay, /Return the real terminal result/);
  assert.match(relay, /Do not orchestrate models/);
});

test("packaged skill documents Kimi Crew as an OpenCode-owned workflow", async () => {
  const skill = await readFile(new URL("../plugin/skills/using-clanker/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /### Kimi Crew/);
  assert.match(skill, /clanker_dispatch_kimi_crew_start/);
  assert.match(skill, /one write-capable OpenCode session/);
  assert.match(skill, /does not downscope its other normal OpenCode tools or permissions/);
  assert.match(skill, /prompts, models, skills, permissions/);
  assert.match(skill, /Kimi intentionally leads its GLM worker/);
});

test("codex command omits unspecified model and effort instead of inventing aliases or overrides", async () => {
  const body = await readFile(new URL("../plugin/commands/codex.md", import.meta.url), "utf8");
  assert.match(body, /omit those fields for both read-only and write calls/);
  assert.match(body, /Never use the lane name `codex` as a model alias/);
  assert.doesNotMatch(body, /gpt-5\.6-terra for write|medium for write/);
});

test("README documents the Claude-owned lifecycle instead of shell-style completion", async () => {
  const body = await readFile(new URL("../plugin/README.md", import.meta.url), "utf8");

  assert.match(body, /The Claude `Agent` call is\s+the visible lifecycle owner/);
  assert.match(body, /non-GLM writes use `clanker:writer`/);
  assert.match(body, /GLM writes alone use the Sonnet\s+`clanker:supervisor`/);
  assert.match(body, /Claude-owned background Clanker task by default/);
  assert.match(body, /task is visible under Claude Code, no shell notification dependency/);
  assert.match(body, /\/clanker:glm/);
  assert.doesNotMatch(body, /ACP turn, blocking, cannot detach/);
});

test("Gemini command and relay are read-only Clanker-owned research surfaces", async () => {
  const command = await readFile(new URL("../plugin/commands/gemini.md", import.meta.url), "utf8");
  const relay = await readFile(new URL("../plugin/agents/gemini.md", import.meta.url), "utf8");
  assert.match(command, /subagent_type="clanker:gemini"/);
  assert.doesNotMatch(command, /--write.*present|clanker:writer/);
  assert.match(relay, /clanker_dispatch_gemini_research_start/);
  assert.doesNotMatch(relay, /clanker_dispatch_write_start|Bash|Edit|Write/);
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
