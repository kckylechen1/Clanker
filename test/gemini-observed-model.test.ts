/**
 * The gemini lane used to report `observed_model: null` on every dispatch.
 *
 * That field is not decoration. `run.ts:observeConfigOptions` fills it from the
 * ACP `configOptions` a lane reports, and comparing it against `resolved_model`
 * is how a vendor silently swapping models gets caught — an opencode run once
 * claimed `kimi` while actually serving `opencode/big-pickle`, and the mismatch
 * in those two fields is the only reason anyone found out. Gemini had no such
 * tripwire: agy is spawned as an opaque `--print` child, so if the sidecar
 * reports nothing, no other layer can supply the truth.
 *
 * These assertions check both halves of the fix together: that the sidecar
 * reports a model at all, and that what it reports is the same value it puts on
 * agy's command line. Reporting the wrong thing confidently would be worse than
 * reporting nothing.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneConnection } from "../src/acp-client.js";

const workspaceSandboxAvailable = (() => {
  if (process.platform !== "darwin") return false;
  try {
    fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

function fakeAgy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-fake-agy-obs-"));
  const executable = path.join(dir, "agy");
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CLANKER_AGY_CAPTURE"\necho grounded-result\n`, { mode: 0o755 });
  return executable;
}

function sidecarSpec(agy: string, capture: string, env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: ["--import", path.resolve("node_modules/tsx/dist/esm/index.mjs"), path.resolve("src/gemini-acp.ts")],
    env: { CLANKER_AGY_PATH: agy, CLANKER_AGY_CAPTURE: capture, ...env },
    warnings: [],
  };
}

/** Runs one turn and returns both what the session advertised and what agy was actually invoked with. */
async function reportedAndActual(env: Record<string, string> = {}) {
  const capture = path.join(os.tmpdir(), `clanker-agy-obs-${process.pid}-${process.hrtime.bigint()}`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-obs-workspace-"));
  const conn = await LaneConnection.connect({ spec: sidecarSpec(fakeAgy(), capture, env), cwd, readOnly: true });
  try {
    const turn = conn.session.prompt("find evidence");
    turn.catch(() => {});
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
    }
    await turn;
    const options = conn.session.newSessionResponse.configOptions ?? [];
    const pick = (category: string): string | undefined => {
      const found = options.find((option) => option.category === category);
      return found === undefined ? undefined : String(found.currentValue);
    };
    return { reportedModel: pick("model"), reportedEffort: pick("thought_level"), argv: fs.readFileSync(capture, "utf8") };
  } finally {
    conn.close();
  }
}

test("gemini reports an observed model, and it is the one agy was actually launched with", { skip: !workspaceSandboxAvailable }, async () => {
  const { reportedModel, argv } = await reportedAndActual();
  assert.equal(reportedModel, "gemini-3.6-flash-high", "the lane default must be reported, not left null");
  // The whole point: telemetry agreeing with argv, not with a second guess at it.
  assert.match(argv, /^--model$/m);
  assert.match(argv, new RegExp(`^${reportedModel}$`, "m"), "reported model must appear on agy's command line");
});

test("an operator override moves both the reported model and the command line together", { skip: !workspaceSandboxAvailable }, async () => {
  const { reportedModel, argv } = await reportedAndActual({ CLANKER_GEMINI_MODEL: "gemini-3.1-pro-high" });
  assert.equal(reportedModel, "gemini-3.1-pro-high");
  assert.match(argv, /^gemini-3\.1-pro-high$/m);
  assert.doesNotMatch(argv, /^gemini-3\.6-flash-high$/m, "the default must not survive an explicit override");
});

test("effort is reported only when one was actually set", { skip: !workspaceSandboxAvailable }, async () => {
  const withEffort = await reportedAndActual({ CLANKER_GEMINI_EFFORT: "high" });
  assert.equal(withEffort.reportedEffort, "high");
  assert.match(withEffort.argv, /^--effort$/m);

  // Unset means unset: inventing a "medium" here would be a fabricated reading,
  // indistinguishable from an agy default we never chose.
  const without = await reportedAndActual();
  assert.equal(without.reportedEffort, undefined, "no effort set means nothing reported");
  assert.doesNotMatch(without.argv, /^--effort$/m);
});
