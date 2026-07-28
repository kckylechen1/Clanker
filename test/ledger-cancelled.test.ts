/**
 * #37 D1 — a cancelled run's ledger row used to be indistinguishable from a
 * clean "done" row: `buildLedgerRow` only special-cased `turnStatus ===
 * "error"`, so both "done" and "cancelled" left `outcome: null, error_class:
 * null`. The 13-key ledger contract is a soft grep contract consumed
 * downstream (query.py) — no new key is added; `error_class` carries the
 * literal string "cancelled" instead, and `outcome` stays null (reserved for
 * a human/terminal-review backfill).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { fakeResolver, until } from "./helpers.js";

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
    .filter((row) => row.label === id);
}

test("D1: a cancelled run's ledger row carries error_class 'cancelled', still exactly the 13-key contract", async () => {
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: os.tmpdir() });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "CANCELME", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).tool_calls > 0, 4_000);
    const cancelled = await m.cancel(id);
    assert.equal(cancelled.status, "cancelled");

    const deadline = Date.now() + 5_000;
    let rows: Record<string, unknown>[] = [];
    while (rows.length === 0 && Date.now() < deadline) {
      rows = ledgerRowsFor(id);
      if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(rows.length, 1, `expected exactly one ledger row for '${id}', found ${rows.length}`);
    assert.deepEqual(Object.keys(rows[0]).sort(), LEDGER_13_KEYS);
    assert.equal(rows[0].error_class, "cancelled");
    assert.equal(rows[0].outcome, null, "outcome stays null — reserved for a terminal-review backfill, not this writer");
  } finally {
    await m.shutdown();
  }
});
