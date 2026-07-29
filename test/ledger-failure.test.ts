/**
 * The ledger writer's FAILURE paths (#29 coverage gap).
 *
 * `appendLedgerRow` is fail-silent by contract (ledger.ts): a ledger write must
 * never fail or delay terminal handling of a real dispatch, so every error is
 * swallowed into `hook_errors.log`, and a double failure — the append AND its
 * own fallback — goes to stderr (#37 D3), the only diagnostic channel a stdio
 * MCP server has.
 *
 * Until this file the suite only ever exercised the happy path
 * (ledger-contract, ledger-cancelled), which means "fail-silent" was tested
 * exactly as far as "silent" and not at all as far as "recorded". The two are
 * not the same thing, and the difference is whether an operator whose ledger
 * stopped receiving rows can find out why.
 *
 * How the module is re-entered: `ledger.ts` resolves LEDGER_DIR from the env at
 * MODULE SCOPE, so a fresh directory needs a fresh evaluation. Importing the
 * same file under a distinct query string gives one, and is honest about what
 * it is testing — the real module, not a copy with the constant patched out.
 */
import "./isolate.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type LedgerModule = typeof import("../src/ledger.js");

const ROW = {
  id: "codex-ledgerfail",
  lane: "codex",
  cwd: "/tmp",
  model: null,
  initialPrompt: "a dispatch whose ledger write is doomed",
  turnStatus: "error",
  error: "boom",
} as const;

/** Load a fresh `ledger.ts` bound to `dir`, restoring the env afterwards. */
async function ledgerBoundTo(dir: string, tag: string): Promise<LedgerModule> {
  const previous = process.env.CLANKER_LEDGER_DIR;
  process.env.CLANKER_LEDGER_DIR = dir;
  try {
    return (await import(`../src/ledger.js?ledger-failure=${tag}`)) as LedgerModule;
  } finally {
    if (previous === undefined) delete process.env.CLANKER_LEDGER_DIR;
    else process.env.CLANKER_LEDGER_DIR = previous;
  }
}

test("#29: an unwritable ledger file is recorded in hook_errors.log, and never thrown at the caller", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-ledger-fail-"));
  // ledger.jsonl exists as a DIRECTORY: mkdir of LEDGER_DIR still succeeds, so
  // the failure lands exactly on the append, which is the shape a full disk or
  // a permissions change produces.
  fs.mkdirSync(path.join(dir, "ledger.jsonl"));
  const ledger = await ledgerBoundTo(dir, "append");

  // The contract is that terminal handling is not disturbed: no throw.
  assert.doesNotThrow(() => ledger.appendLedgerRow({ ...ROW }));

  const errors = fs.readFileSync(path.join(dir, "hook_errors.log"), "utf8");
  assert.match(errors, /native-ledger-writer append failed for run 'codex-ledgerfail'/);
  assert.match(errors, /EISDIR|illegal operation on a directory/i);
  // Silent would mean an operator whose rows stopped arriving has nothing to
  // read; the row's own id has to be in the record. One failure, one record —
  // the record itself spans several lines because it carries the stack.
  assert.equal(errors.split("native-ledger-writer append failed").length - 1, 1, "one failure, one record");
  assert.match(errors, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] /, "the record is timestamped");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("#37 D3 / #29: when the fallback log ALSO fails, the double failure reaches stderr", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-ledger-doublefail-"));
  // LEDGER_DIR is a regular FILE, so mkdirSync fails for the row AND for
  // hook_errors.log — total silence here is what hid a real double failure.
  const asFile = path.join(parent, "not-a-directory");
  fs.writeFileSync(asFile, "occupied");
  const ledger = await ledgerBoundTo(asFile, "double");

  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  try {
    assert.doesNotThrow(() => ledger.appendLedgerRow({ ...ROW }));
  } finally {
    console.error = original;
  }

  assert.equal(messages.length, 1, `expected exactly one stderr line, got ${JSON.stringify(messages)}`);
  assert.match(messages[0], /ledger write AND hook_errors\.log fallback both failed/);
  assert.match(messages[0], /codex-ledgerfail/);
  assert.equal(fs.readFileSync(asFile, "utf8"), "occupied", "the writer must not clobber what is in its way");
  fs.rmSync(parent, { recursive: true, force: true });
});

test("#29: a healthy dir gets the row and no hook_errors.log at all", async () => {
  // The control: the two tests above prove the error paths report, this one
  // proves they are not firing on the normal path (a fail-silent writer that
  // logged an error every time would pass both of them).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-ledger-ok-"));
  const ledger = await ledgerBoundTo(dir, "ok");

  ledger.appendLedgerRow({ ...ROW });

  const rows = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  assert.equal((JSON.parse(rows[0]) as { label: string }).label, "codex-ledgerfail");
  assert.equal(fs.existsSync(path.join(dir, "hook_errors.log")), false, "no error channel on the happy path");
  fs.rmSync(dir, { recursive: true, force: true });
});
