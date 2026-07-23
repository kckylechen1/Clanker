import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("generic command delegates one job to the unified relay", async () => {
  const body = await readFile(new URL("../plugin/commands/clanker.md", import.meta.url), "utf8");
  assert.match(body, /clanker:clanker/);
  assert.match(body, /exactly one `Agent\(subagent_type="clanker:clanker"\)`/i);
  assert.doesNotMatch(body, /clanker_dispatch_|clanker_prompt|clanker_close/);
});

test("Kimi Crew command launches one unified-profile job without inline orchestration", async () => {
  const body = await readFile(new URL("../plugin/commands/kimi-crew.md", import.meta.url), "utf8");
  assert.match(body, /profile: "kimi-crew"/);
  assert.match(body, /exactly one `Agent\(subagent_type="clanker:clanker"\)`/i);
  assert.match(body, /installed OpenCode `kimi-crew` profile owns that work/);
  assert.doesNotMatch(body, /vault|worker-glm|reviewer-deepseek|oracle/);
});

test("Gemini command routes through the unified relay as read-only worker", async () => {
  const body = await readFile(new URL("../plugin/commands/gemini.md", import.meta.url), "utf8");
  assert.match(body, /clanker:clanker/);
  assert.match(body, /lane: "gemini"/);
  assert.match(body, /server-forced read-only/);
  assert.match(body, /non-worker profile/);
  assert.match(body, /do not request a worktree/);
  assert.doesNotMatch(body, /kimi-crew/);
});

test("generic relay exposes only five lifecycle tools and no retired APIs", async () => {
  const body = await readFile(new URL("../plugin/agents/clanker.md", import.meta.url), "utf8");
  const frontmatter = body.split("---")[1] ?? "";
  for (const tool of ["clanker_start", "clanker_wait", "clanker_status", "clanker_cancel"]) assert.match(frontmatter, new RegExp(tool));
  assert.doesNotMatch(frontmatter, /clanker_list/, "the one-job relay does not need global inventory access");
  assert.doesNotMatch(frontmatter, /clanker_prompt|clanker_close|clanker_dispatch/);
  assert.match(body, /server is authoritative/);
});

test("packaged skill documents unified lifecycle and OpenCode-owned Kimi Crew", async () => {
  const body = await readFile(new URL("../plugin/skills/using-clanker/SKILL.md", import.meta.url), "utf8");
  for (const tool of ["clanker_start", "clanker_wait", "clanker_status", "clanker_cancel", "clanker_list"]) assert.match(body, new RegExp(tool));
  assert.match(body, /profile: "kimi-crew"/);
  assert.match(body, /installed `kimi-crew` OpenCode profile/);
  assert.match(body, /Never pass credentials/);
});

test("plugin metadata uses Clanker as the visible name", async () => {
  const manifest = JSON.parse(await readFile(new URL("../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "clanker");
  assert.equal(manifest.displayName, "Clanker");
  assert.ok(manifest.keywords.includes("clanker"));
});
