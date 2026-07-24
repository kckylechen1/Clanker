import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DISPATCH_PROFILES } from "../src/profiles.js";

const seatFor: Record<string, string> = {
  "codex-review": "codex",
  "codex-write": "writer",
  "oc-review": "oc",
  "oc-write": "writer",
  "oc-glm-write": "supervisor",
  "oc-kimi-crew": "crew",
  "gemini-recon": "gemini",
  "grok-review": "grok",
  "grok-write": "writer",
};

test("generic command routes a profile to the seat that owns it", async () => {
  const body = await readFile(new URL("../plugin/commands/clanker.md", import.meta.url), "utf8");
  for (const profile of DISPATCH_PROFILES) {
    assert.match(body, new RegExp(`\`${profile.id}\``), `command must name profile ${profile.id}`);
    assert.match(body, new RegExp(`clanker:${seatFor[profile.id]}`), `command must name the seat for ${profile.id}`);
  }
  assert.doesNotMatch(body, /clanker_dispatch_|clanker_prompt|clanker_close/);
});

test("Kimi Crew command launches the crew seat without inline orchestration", async () => {
  const body = await readFile(new URL("../plugin/commands/kimi-crew.md", import.meta.url), "utf8");
  assert.match(body, /exactly one `Agent\(subagent_type="clanker:crew"\)`/i);
  assert.match(body, /installed OpenCode `kimi-crew` profile owns that work/);
  assert.doesNotMatch(body, /vault|worker-glm|reviewer-deepseek|oracle/);
});

test("Gemini command routes to the read-only recon seat", async () => {
  const body = await readFile(new URL("../plugin/commands/gemini.md", import.meta.url), "utf8");
  assert.match(body, /exactly one `Agent\(subagent_type="clanker:gemini"\)`/i);
  assert.match(body, /server-forced read-only/);
  assert.doesNotMatch(body, /kimi-crew/);
});

test("every seat holds only its own narrow start tool and no retired API", async () => {
  // The capability boundary IS the frontmatter tool list: a read-only relay
  // that could name the generic clanker_start would be able to start a write
  // job, which is exactly the property 0.2.x had and 0.3.0 lost.
  const expected: Record<string, string[]> = {
    codex: ["clanker_start_codex-review"],
    oc: ["clanker_start_oc-review"],
    gemini: ["clanker_start_gemini-recon"],
    grok: ["clanker_start_grok-review"],
    crew: ["clanker_start_oc-kimi-crew"],
    writer: ["clanker_start_codex-write", "clanker_start_oc-write", "clanker_start_grok-write"],
    supervisor: ["clanker_start_oc-glm-write"],
  };
  for (const [seat, tools] of Object.entries(expected)) {
    const body = await readFile(new URL(`../plugin/agents/${seat}.md`, import.meta.url), "utf8");
    const frontmatter = body.split("---")[1] ?? "";
    const named = [...frontmatter.matchAll(/clanker_start[a-z0-9_-]*/g)].map((m) => m[0]).sort();
    assert.deepEqual(named, [...tools].sort(), `${seat}.md must hold exactly its own start tools`);
    assert.doesNotMatch(frontmatter, /clanker_list|clanker_close|clanker_dispatch/);
    assert.match(frontmatter, /clanker_wait/);
    // Only the GLM supervisor may correct or cancel a worker, and only it is Sonnet.
    const mayCorrect = seat === "supervisor";
    assert.equal(/clanker_prompt/.test(frontmatter), mayCorrect, `${seat}.md correction rights`);
    assert.equal(/clanker_cancel/.test(frontmatter), mayCorrect, `${seat}.md cancellation rights`);
    assert.equal(/^model: sonnet$/m.test(frontmatter), mayCorrect, `${seat}.md model tier`);
    // The 0.2.x seat contracts: named-redirect refusal, zero-fabrication
    // delivery of the real id + run dir, and the new per-profile deadline.
    assert.match(body, /CLANKER-FAILURE:/, `${seat}.md must keep the verbatim-failure contract`);
    assert.match(body, /`~\/\.cache\/clanker\/runs\/<id>`/, `${seat}.md must return the real run directory`);
    assert.match(body, /hard turn ceiling is \*\*\d+ minutes\*\*/, `${seat}.md must state its profile deadline`);
  }
});

test("every registry profile is reachable from exactly one seat", async () => {
  const seats = ["codex", "oc", "gemini", "grok", "writer", "supervisor", "crew"];
  const holders = new Map<string, string[]>();
  for (const seat of seats) {
    const frontmatter = (await readFile(new URL(`../plugin/agents/${seat}.md`, import.meta.url), "utf8")).split("---")[1] ?? "";
    for (const profile of DISPATCH_PROFILES) {
      if (frontmatter.includes(`clanker_start_${profile.id},`) || frontmatter.trimEnd().endsWith(`clanker_start_${profile.id}`)) {
        holders.set(profile.id, [...(holders.get(profile.id) ?? []), seat]);
      }
    }
  }
  for (const profile of DISPATCH_PROFILES) {
    assert.deepEqual(
      holders.get(profile.id) ?? [],
      [seatFor[profile.id]],
      `profile ${profile.id} must be held by exactly one seat`,
    );
  }
});

test("packaged skill documents the profile registry and vault-sourced credentials", async () => {
  const body = await readFile(new URL("../plugin/skills/using-clanker/SKILL.md", import.meta.url), "utf8");
  for (const tool of ["clanker_start", "clanker_wait", "clanker_status", "clanker_cancel", "clanker_list"]) {
    assert.match(body, new RegExp(tool));
  }
  for (const profile of DISPATCH_PROFILES) assert.match(body, new RegExp(profile.id));
  assert.match(body, /tachi vault exec/);
  assert.match(body, /Never pass credentials/);
});

test("plugin metadata uses Clanker as the visible name", async () => {
  const manifest = JSON.parse(await readFile(new URL("../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "clanker");
  assert.equal(manifest.displayName, "Clanker");
  assert.ok(manifest.keywords.includes("clanker"));
});
