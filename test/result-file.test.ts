/**
 * #19-F9 — the run directory must hold a readable verdict.
 *
 * A relay seat that can only report prose is a fabrication surface: on
 * 2026-07-25 one invented an entire review, and a second, after a "verbatim"
 * clause was added, blended the real verdict with invented details. The
 * structural fix is that the deliverable becomes a PATH. These tests hold the
 * file to that job: it must exist on every terminal path, carry the verdict
 * losslessly, and be advertised by clanker_wait only when it is really there.
 *
 * The last test is the discrimination check: with the three write points
 * removed from run.ts, every assertion here must go red.
 */
import "./isolate.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FINAL_MESSAGE_CHAR_BUDGET } from "../src/constants.js";
import { LaneManager, type WaitResult } from "../src/manager.js";
import { RESULT_FILE, RESULT_FINAL_MESSAGE_HEADING } from "../src/run.js";
import { dropMutant, fakeResolver, loadMutantManager, until } from "./helpers.js";

function makeManager(Ctor: typeof LaneManager = LaneManager, opts: { cancelGraceMs?: number } = {}) {
  return new Ctor({
    resolveSpec: fakeResolver,
    disableReaper: true,
    baseRepo: os.tmpdir(),
    cancelGraceMs: opts.cancelGraceMs,
  });
}

async function waitTerminal(m: LaneManager, id: string, timeoutMs = 5_000): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  let last!: WaitResult;
  while (Date.now() < deadline) {
    last = await m.wait(id, 200);
    if (last.status !== "running") return last;
  }
  return last;
}

/** The verbatim tail of result.md: everything after the final_message heading. */
function finalMessageSection(body: string): string {
  const marker = `${RESULT_FINAL_MESSAGE_HEADING}\n\n`;
  const at = body.indexOf(marker);
  assert.notEqual(at, -1, "result.md must carry a final_message section");
  return body.slice(at + marker.length).replace(/\n$/, "");
}

function readResult(runDir: string): string {
  return fs.readFileSync(path.join(runDir, RESULT_FILE), "utf8");
}

test("#19-F9: a done run leaves result.md holding its verbatim final message", async () => {
  const m = makeManager();
  try {
    const verdict = "F9-DONE verdict: two blocking findings, do not merge";
    const { id } = await m.dispatchStart({ lane: "codex", prompt: verdict, cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");

    // The wait payload advertises the artifact by absolute path, so a seat that
    // holds no filesystem tool never has to construct or guess one.
    assert.equal(r.run_dir, path.join(process.env.CLANKER_RUNS_ROOT!, id));
    assert.equal(r.result_path, path.join(r.run_dir, RESULT_FILE));
    assert.equal(r.result_bytes, fs.statSync(r.result_path!).size);
    assert.equal(m.status(id).result_path, r.result_path);

    const body = readResult(r.run_dir);
    assert.equal(finalMessageSection(body), verdict, "result.md must end on the verdict, verbatim");
    assert.equal(finalMessageSection(body), r.final_message);
    assert.match(body, /^- status: done$/m);
    assert.match(body, new RegExp(`^# clanker run ${id}$`, "m"));
    assert.doesNotMatch(body, /^## error$/m, "a clean run must not invent an error section");
  } finally {
    await m.shutdown();
  }
});

test("#19-F9: an errored run leaves result.md carrying the verbatim error", async () => {
  const m = makeManager();
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "CRASH now", cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "error");
    assert.ok(r.result_path, "an errored run still owes the caller a readable verdict file");

    const body = readResult(r.run_dir);
    assert.match(body, /^- status: error$/m);
    assert.match(body, /^## error$/m);
    // clanker_wait may annotate the error with an advisory; the file carries the
    // raw text, so compare on the first line of the raw message.
    const firstLine = r.error!.split("\n")[0];
    assert.ok(body.includes(firstLine), `result.md must contain the terminal error verbatim: ${firstLine}`);
  } finally {
    await m.shutdown();
  }
});

test("#19-F9: a cancelled run leaves result.md stating the cancellation", async () => {
  const m = makeManager(LaneManager, { cancelGraceMs: 2_000 });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "CANCELME", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).tool_calls > 0, 4_000);
    const cancelled = await m.cancel(id);
    assert.equal(cancelled.status, "cancelled");

    const r = await waitTerminal(m, id);
    assert.equal(r.status, "cancelled");
    assert.ok(r.result_path, "a cancelled run must still say so in a file, not only in a tool response");
    const body = readResult(r.run_dir);
    assert.match(body, /^- status: cancelled$/m);
  } finally {
    await m.shutdown();
  }
});

test("#19-F9: result.md is lossless where the wire field is truncated", async () => {
  const m = makeManager();
  try {
    // The wire budget is what makes a long verdict unreadable through the tool
    // response alone; the file must not inherit that clipping.
    const long = "L".repeat(FINAL_MESSAGE_CHAR_BUDGET + 50);
    const { id } = await m.dispatchStart({ lane: "codex", prompt: long, cwd: os.tmpdir(), readOnly: true });
    const r = await waitTerminal(m, id);
    assert.equal(r.status, "done");
    assert.equal(r.final_message!.length, FINAL_MESSAGE_CHAR_BUDGET, "the wire field is still capped");
    assert.ok(r.final_message!.endsWith("…"));
    assert.equal(finalMessageSection(readResult(r.run_dir)), long, "result.md must hold the untruncated verdict");
  } finally {
    await m.shutdown();
  }
});

test("#19-F9: with the three write points removed, every terminal path loses result.md", async () => {
  const name = "f9-no-result-file";
  const { LaneManager: MutantManager } = await loadMutantManager(name, [
    { file: "run.ts", find: `this.markTerminal("done");\n    this.writeResultFileOnce();`, replace: `this.markTerminal("done");` },
    { file: "run.ts", find: `this.markTerminal("error");\n    this.writeResultFileOnce();`, replace: `this.markTerminal("error");` },
    { file: "run.ts", find: `this.markTerminal("cancelled");\n    this.writeResultFileOnce();`, replace: `this.markTerminal("cancelled");` },
  ]);
  const m = makeManager(MutantManager, { cancelGraceMs: 2_000 });
  try {
    const done = await m.dispatchStart({ lane: "codex", prompt: "F9-mutant done", cwd: os.tmpdir(), readOnly: true });
    const doneResult = await waitTerminal(m, done.id);
    assert.equal(doneResult.status, "done");

    const failed = await m.dispatchStart({ lane: "codex", prompt: "CRASH now", cwd: os.tmpdir(), readOnly: true });
    const failedResult = await waitTerminal(m, failed.id);
    assert.equal(failedResult.status, "error");

    const cancelling = await m.dispatchStart({ lane: "codex", prompt: "CANCELME", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(cancelling.id).tool_calls > 0, 4_000);
    await m.cancel(cancelling.id);
    const cancelledResult = await waitTerminal(m, cancelling.id);
    assert.equal(cancelledResult.status, "cancelled");

    for (const r of [doneResult, failedResult, cancelledResult]) {
      assert.equal(
        fs.existsSync(path.join(r.run_dir, RESULT_FILE)),
        false,
        `mutant still wrote result.md for a ${r.status} run — the assertions above would pass on a build with no writer`,
      );
      assert.equal(r.result_path, undefined, "a missing file must never be advertised as a path");
      assert.equal(r.result_bytes, undefined);
    }
  } finally {
    await m.shutdown();
    dropMutant(name);
  }
});
