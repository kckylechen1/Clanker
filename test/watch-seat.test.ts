/**
 * The watch seat is the one relay with NO start tool: it takes a job id the
 * caller already has and long-polls it to terminal, so an orphaned dispatch can
 * be adopted without the polling cost landing back on the lead's context.
 *
 * `plugin-command-contract.test.ts`'s "every seat holds only its own narrow
 * start tool" walks a hardcoded whitelist of seats that *hold* a start tool, so
 * a zero-start seat is invisible to it — green there means "not looked at", not
 * "checked and fine". These assertions are that seat's own capability fence:
 * the property #19/#20 restored (capability is the tool surface, not a
 * parameter) has to hold for a seat the older test cannot see.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const seatFile = new URL("../plugin/agents/watch.md", import.meta.url);

async function frontmatterOf(url: URL): Promise<string> {
  return (await readFile(url, "utf8")).split("---")[1] ?? "";
}

test("watch seat holds no start tool at all — it can never begin a dispatch", async () => {
  const frontmatter = await frontmatterOf(seatFile);
  const named = [...frontmatter.matchAll(/clanker_start[a-z0-9_-]*/g)].map((m) => m[0]);
  assert.deepEqual(named, [], "watch.md must name zero start tools; adopting a job is not starting one");
  assert.doesNotMatch(frontmatter, /clanker_dispatch/, "no retired dispatch API either");
});

test("watch seat cannot correct or cancel — only the GLM supervisor may steer a live worker", async () => {
  const frontmatter = await frontmatterOf(seatFile);
  assert.doesNotMatch(frontmatter, /clanker_prompt/, "watch.md must hold no correction right");
  assert.doesNotMatch(frontmatter, /clanker_cancel/, "watch.md must hold no cancellation right");
});

test("watch seat holds exactly the three read-only lifecycle tools, and runs on haiku", async () => {
  const frontmatter = await frontmatterOf(seatFile);
  assert.match(frontmatter, /clanker_wait/, "it long-polls");
  assert.match(frontmatter, /clanker_status/, "it may read status");
  // clanker_list is what lets it hand back the in-flight board when the caller
  // has no id — the one seat allowed to see it, because it cannot act on it.
  assert.match(frontmatter, /clanker_list/, "it may enumerate in-flight jobs for the caller to choose from");
  assert.match(frontmatter, /^model: haiku$/m, "watching is mechanical; the sonnet tier is the supervisor's");
});

test("watch seat carries the zero-fabrication delivery contract verbatim", async () => {
  const body = await readFile(seatFile, "utf8");
  // Identical wording to the other relays on purpose: a watcher that summarises
  // final_message is a watcher that can invent one. The caller opens the file.
  assert.match(body, /Never restate `final_message`/);
  assert.match(body, /CLANKER-NO-RESULT:/);
  assert.match(body, /result_path/);
});

test("watch seat refuses to pick a job for the caller", async () => {
  const body = await readFile(seatFile, "utf8");
  assert.match(body, /REJECTED-NO-JOB-ID:/, "no id supplied is a refusal, not a guess");
  // It may show the board; choosing from it is the caller's act.
  assert.match(body, /never (choose|select|pick)/i, "it must state that it never selects a job itself");
});
