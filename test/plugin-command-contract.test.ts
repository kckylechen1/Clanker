import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DISPATCH_PROFILES } from "../src/profiles.js";
import type { LaneManager } from "../src/manager.js";
import { registerTools } from "../src/tools.js";

const ALL_SEATS = ["codex", "oc", "gemini", "grok", "cursor", "crew", "writer", "supervisor", "watch"];

/** Tool names the server really registers for `host`, read off registerTools itself. */
function registeredTools(host: string): Set<string> {
  const names = new Set<string>();
  const server = { registerTool(name: string) { names.add(name); } } as unknown as McpServer;
  registerTools(server, { host } as LaneManager);
  return names;
}

const seatFor: Record<string, string> = {
  "codex-review": "codex",
  "codex-write": "writer",
  "oc-review": "oc",
  "oc-write": "writer",
  "oc-glm-write": "supervisor",
  "oc-kimi-crew": "crew",
  "gemini-recon": "gemini",
  "gemini-research": "gemini",
  "cursor-review": "cursor",
  "cursor-write": "writer",
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
    gemini: ["clanker_start_gemini-recon", "clanker_start_gemini-research"],
    grok: ["clanker_start_grok-review"],
    cursor: ["clanker_start_cursor-review"],
    crew: ["clanker_start_oc-kimi-crew"],
    writer: [
      "clanker_start_codex-write",
      "clanker_start_oc-write",
      "clanker_start_grok-write",
      "clanker_start_cursor-write",
    ],
    supervisor: ["clanker_start_oc-glm-write"],
  };
  for (const [seat, tools] of Object.entries(expected)) {
    const body = await readFile(new URL(`../plugin/agents/${seat}.md`, import.meta.url), "utf8");
    const frontmatter = body.split("---")[1] ?? "";
    const named = [...frontmatter.matchAll(/clanker_start[a-z0-9_-]*/g)].map((m) => m[0]).sort();
    assert.deepEqual(named, [...tools].sort(), `${seat}.md must hold exactly its own start tools`);
    assert.doesNotMatch(frontmatter, /clanker_list|clanker_close|clanker_dispatch/);
    assert.match(frontmatter, /clanker_wait/);
    // Only the GLM supervisor may cancel a worker, and only it is Sonnet.
    const maySupervise = seat === "supervisor";
    assert.equal(/clanker_prompt/.test(frontmatter), maySupervise, `${seat}.md correction rights`);
    assert.equal(/clanker_cancel/.test(frontmatter), maySupervise, `${seat}.md cancellation rights`);
    assert.equal(/^model: sonnet$/m.test(frontmatter), maySupervise, `${seat}.md model tier`);
    // The 0.2.x seat contracts: named-redirect refusal, zero-fabrication
    // delivery, and the per-profile deadline.
    assert.match(body, /CLANKER-FAILURE:/, `${seat}.md must keep the verbatim-failure contract`);
    assert.match(body, /hard turn ceiling is \*\*\d+ minutes\*\*/, `${seat}.md must state its profile deadline`);

    // #19-F10. A contract that bans fabrication while ordering the seat to
    // reproduce `final_message` asks a language model for the one thing it
    // cannot do; twice in one day a relay answered with real verdict blended
    // into invented detail. The delivery is therefore a PATH the server minted,
    // and restating the verdict is forbidden outright.
    assert.match(body, /`run_dir`/, `${seat}.md must deliver the server-minted run_dir`);
    assert.match(body, /`result_path`/, `${seat}.md must deliver the server-minted result.md path`);
    assert.match(
      body,
      /never construct, shorten, or guess a path/i,
      `${seat}.md must forbid composing a path instead of copying the returned one`,
    );
    assert.match(body, /\*\*Never restate `final_message`\*\*/, `${seat}.md must forbid restating the verdict`);
    assert.match(
      body,
      /CLANKER-NO-RESULT:/,
      `${seat}.md must have a "I did not get a verdict" path that is not a composed summary`,
    );
    // The retired shape: the verdict as a returned field, and a run directory
    // the seat typed out from a template instead of copying from the payload.
    assert.doesNotMatch(
      body,
      /result fields `final_message`|status, final_message|`~\/\.cache\/clanker\/runs\/<id>`/,
      `${seat}.md still asks for the retired restate-the-result delivery`,
    );
  }
});

test("no seat names a clanker tool the server does not register", async () => {
  // The gate that would have caught the phantom. `supervisor.md` declared
  // `clanker_prompt` and step 4 told it to correct a drifting worker with it —
  // but `registerTools` has registered no such tool since 69988a3 turned Clanker
  // into a one-shot job controller. The seat's single steering verb did not
  // exist, and the contract test of the day ASSERTED it must be declared, so the
  // drift was welded in rather than caught. A tool name that resolves to nothing
  // is silently dropped by the host, which means the failure surfaces only as a
  // seat improvising at the exact moment it was supposed to intervene.
  //
  // Derived from registerTools, never from a hand-kept list: a gate that keeps
  // its own copy of the tool surface is the same class of bug one level up.
  const available = registeredTools("claude");
  for (const seat of ALL_SEATS) {
    const body = await readFile(new URL(`../plugin/agents/${seat}.md`, import.meta.url), "utf8");
    const frontmatter = body.split("---")[1] ?? "";
    const named = [...frontmatter.matchAll(/mcp__plugin_clanker_clanker__(clanker_[a-z0-9_-]+)/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `${seat}.md declares no clanker tools at all`);
    for (const tool of named) {
      assert.ok(
        available.has(tool),
        `${seat}.md declares '${tool}', which the server never registers ` +
          `(registered: ${[...available].sort().join(", ")})`,
      );
    }
    // And the prose must not instruct a call the frontmatter cannot make.
    for (const tool of [...body.matchAll(/`(clanker_[a-z0-9_-]+)\(/g)].map((m) => m[1])) {
      assert.ok(available.has(tool), `${seat}.md tells the seat to call '${tool}', which does not exist`);
    }
  }
});

test("every seat reports the model that actually ran", async () => {
  // observed_model is on the terminal clanker_wait result already (manager.ts
  // buildWaitResult sets `telemetry` on terminal), so no seat needs an extra
  // tool to see it — what was missing is any instruction to hand it back. That
  // gap is what let an out-of-band ~/.codex/config.toml edit move every
  // dispatch onto a different model with zero signal to the dispatcher
  // (af0dea5): the fact reached the relay and died there.
  for (const seat of ALL_SEATS) {
    const body = await readFile(new URL(`../plugin/agents/${seat}.md`, import.meta.url), "utf8");
    // Anchored to the DELIVERY LIST, not to the word appearing anywhere: the
    // first version of this assertion matched the explanatory sentence too, so
    // deleting the field from the list left the test green. A gate satisfied by
    // prose about a field is not a gate on the field.
    assert.match(
      body,
      /`plan_final`, `telemetry\.observed_model`/,
      `${seat}.md must list telemetry.observed_model among the fields it returns — the model that actually ran`,
    );
  }
});

test("the README profile table and the registry agree, in both directions", async () => {
  // README's table is the first thing anyone reads about what a dispatch can
  // be, and it silently fell one row behind the registry: `gemini-research`
  // shipped in #23 and never appeared, so the documented surface was 9 profiles
  // against a real 10. Nothing compared them, because every other gate in the
  // repo compares code to code.
  //
  // Both directions matter. A missing row hides a capability; a leftover row
  // advertises one that no longer exists, which is worse — a caller picks it and
  // the tool is simply not there.
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...readme.matchAll(/^\| `([a-z0-9-]+)` \| /gm)].map((m) => m[1]);
  assert.deepEqual(
    [...rows].sort(),
    DISPATCH_PROFILES.map((p) => p.id).sort(),
    "README's profile table must list exactly the registry's profiles",
  );
});

test("every registry profile is reachable from exactly one seat", async () => {
  const seats = ["codex", "oc", "gemini", "grok", "cursor", "writer", "supervisor", "crew"];
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
  // #19-F10: the other half of "relays never restate the verdict" is telling
  // the dispatcher where to read it instead.
  assert.match(body, /`result_path`/);
  assert.match(body, /result\.md/);
  assert.match(body, /CLANKER-NO-RESULT:/);
});

test("the packaged skill is byte-identical in both plugin adapters", async () => {
  // codex-plugin/skills is a generated copy (scripts/sync-plugin-skills.mjs).
  // An edit to the source that never gets bundled ships two different contracts
  // under one name — the Codex adapter would still teach the retired shape.
  //
  // Not redundant with host.test.ts's SKILL.md comparison: that assertion sits
  // BEHIND a version assertion which is currently red, so it never executes —
  // a guard parked behind a failing assertion is not a guard. This one also
  // covers evals.json, which the other check does not look at.
  for (const file of ["SKILL.md", "evals/evals.json"]) {
    const source = await readFile(new URL(`../plugin/skills/using-clanker/${file}`, import.meta.url), "utf8");
    const generated = await readFile(new URL(`../codex-plugin/skills/using-clanker/${file}`, import.meta.url), "utf8");
    assert.equal(generated, source, `codex-plugin copy of ${file} is stale; run 'npm run bundle:skills'`);
  }
});

test("plugin metadata uses Clanker as the visible name", async () => {
  const manifest = JSON.parse(await readFile(new URL("../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "clanker");
  assert.equal(manifest.displayName, "Clanker");
  assert.ok(manifest.keywords.includes("clanker"));
});
