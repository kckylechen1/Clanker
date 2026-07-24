/**
 * Acceptance demo for the native dispatch-ledger writer (src/ledger.ts).
 *
 * Calls appendLedgerRow() with a fake terminal run (a done/success case and
 * an error case) against a scratch CLANKER_LEDGER_DIR (never the real
 * ~/.agents/dispatch-ledger/) and prints the appended lines so a reviewer
 * can eyeball the exact 13-key shape without touching the real ledger.
 *
 * Usage: CLANKER_LEDGER_DIR=<scratch dir> tsx scripts/ledger-writer-demo.ts
 * (the scratch dir must already be set via env before this module is
 * imported, since ledger.ts reads CLANKER_LEDGER_DIR at import time).
 */
import fs from "node:fs";
import { appendLedgerRow } from "../src/ledger.js";

const ledgerDir = process.env.CLANKER_LEDGER_DIR;
if (!ledgerDir) {
  console.error("Set CLANKER_LEDGER_DIR to a scratch dir before running this demo.");
  process.exit(1);
}

appendLedgerRow({
  id: "codex-39cad",
  lane: "codex",
  cwd: "/tmp/some-worktree",
  model: "gpt-5.6-sol",
  initialPrompt: "Investigate the flaky worktree cleanup test and report back.",
  turnStatus: "done",
});

appendLedgerRow({
  id: "opencode-4f001",
  lane: "opencode",
  cwd: "/tmp/some-other-worktree",
  model: null,
  initialPrompt: "x".repeat(250), // exercises the 200-char prompt_head truncation
  turnStatus: "error",
  error: "y".repeat(250), // exercises the 200-char error_class truncation
});

const lines = fs
  .readFileSync(`${ledgerDir}/ledger.jsonl`, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean);

console.log(`--- appended ${lines.length} row(s) to ${ledgerDir}/ledger.jsonl ---`);
for (const line of lines) {
  const parsed: unknown = JSON.parse(line); // throws if not valid JSON
  const keys = Object.keys(parsed as object).sort();
  const EXPECTED = [
    "agent_type",
    "error_class",
    "label",
    "lesson_ref",
    "model",
    "outcome",
    "prompt_head",
    "repo",
    "review",
    "refix_rounds",
    "session",
    "ts",
    "tool",
  ].sort();
  console.log(line);
  console.log(
    `  parses as JSON: yes | key count: ${keys.length} | exactly the 13 expected keys: ${
      JSON.stringify(keys) === JSON.stringify(EXPECTED)
    }`,
  );
}
