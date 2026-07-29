/**
 * #37 B1 — a mid-turn subprocess crash's stderr is real diagnostic evidence
 * (acp-client.ts has been accumulating a 4000-char tail the whole time,
 * conn.stderr()), but two of runTurn's three failure branches (the ACP
 * stream closing with no exit info yet, and the hard per-turn timeout) threw
 * without ever reading it — only the exit-with-info branch carried it. A
 * caller debugging a crashed worker got "exited mid-turn (code=1
 * signal=null)" and nothing about WHY.
 *
 * Also covers the redaction this stderr text now goes through before it
 * reaches a caller or disk (issue #8's first item): a secret-shaped value in
 * stderr (API keys, tokens, bearer credentials) must never round-trip into
 * the terminal error verbatim.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { LaneManager } from "../src/manager.js";
import { fakeResolver, until } from "./helpers.js";

function makeManager(): LaneManager {
  return new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: os.tmpdir() });
}

test("B1: a mid-turn crash's stderr evidence reaches the terminal error", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "CRASH now", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).status !== "running");
    const r = m.status(id);
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /exited mid-turn/);
    assert.match(r.error ?? "", /simulated crash: worker unstable/, "stderr evidence must reach the terminal error");
  } finally {
    await m.shutdown();
  }
});

test("B1: a secret-shaped value in stderr is redacted before it reaches the terminal error", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      prompt: "CRASH_SECRET now",
      cwd: os.tmpdir(),
      readOnly: true,
    });
    await until(() => m.status(id).status !== "running");
    const r = m.status(id);
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /\[REDACTED\]/, "the redaction marker must appear in place of the secret");
    assert.doesNotMatch(r.error ?? "", /fake-not-a-real-credential-0000/, "the raw secret value must never reach the caller");
  } finally {
    await m.shutdown();
  }
});
