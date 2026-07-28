/**
 * src/ledger.ts:67 freezes the LedgerRow shape with a comment, not a test:
 * "Exactly the 13 keys downstream query.py greps for; do not add/remove/rename."
 * A comment does not fail a build — only an assertion against a real produced
 * row does. The 13 names below are written out by hand (not imported from
 * buildLedgerRow) because a contract test that reads its own contract from the
 * implementation it is meant to pin can never catch a rename.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LaneManager } from "../src/manager.js";
import { fakeResolver } from "./helpers.js";

const LEDGER_13_KEYS = [
  "ts",
  "session",
  "repo",
  "tool",
  "agent_type",
  "model",
  "label",
  "prompt_head",
  "outcome",
  "review",
  "refix_rounds",
  "error_class",
  "lesson_ref",
].sort();

function ledgerRowsFor(id: string): Record<string, unknown>[] {
  const file = path.join(process.env.CLANKER_LEDGER_DIR ?? "", "ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    // The row's id field is `label` (ledger.ts buildLedgerRow), not `id`.
    .filter((row) => row.label === id);
}

test("a real ledger row has exactly the 13 keys the frozen contract names, no more no less", async () => {
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: os.tmpdir() });
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "ledger-contract-check",
      cwd: os.tmpdir(),
      readOnly: true,
    });
    const deadline = Date.now() + 6_000;
    let rows: Record<string, unknown>[] = [];
    while (rows.length === 0 && Date.now() < deadline) {
      rows = ledgerRowsFor(id);
      if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(rows.length, 1, `expected exactly one ledger row for '${id}', found ${rows.length}`);
    assert.deepEqual(Object.keys(rows[0]).sort(), LEDGER_13_KEYS);
  } finally {
    await m.shutdown();
  }
});
