/**
 * #37: a long-lived server's `process.execPath` can be deleted underneath it
 * (homebrew revision bump moves the same version into a new Cellar directory),
 * after which every sidecar spawn is ENOENT. resolveNodeBinary must notice,
 * SAY SO, and keep serving on PATH's node instead of failing every dispatch.
 *
 * The tests below drive the pure entry point `resolveNodeBinaryFrom`, because
 * the running node's own path cannot be made to disappear — and a drift guard
 * exercised only on the happy path is not a guard. The mutant at the bottom
 * proves these assertions really observe the fallback.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATH_NODE, resolveNodeBinary, resolveNodeBinaryFrom } from "../src/node-binary.js";
import { dropMutant, loadMutantModule } from "./helpers.js";

type NodeBinaryModule = typeof import("../src/node-binary.js");

/** Run `fn` with console.error captured instead of printed. */
function captureStderr<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), lines };
  } finally {
    console.error = original;
  }
}

const MISSING = path.join(os.tmpdir(), "clanker-node-that-was-bumped-away", "bin", "node");

test("the healthy case: the server's own binary, used silently", () => {
  const { value, lines } = captureStderr(() => resolveNodeBinary());
  assert.ok(path.isAbsolute(value), `expected an absolute path, got '${value}'`);
  assert.ok(fs.existsSync(value), `resolveNodeBinary must return a binary that exists: '${value}'`);
  assert.deepEqual(lines, [], "no drift, no noise — stderr is for the degraded path");
});

test("the drifted case: falls back to PATH's node and says why", () => {
  assert.equal(fs.existsSync(MISSING), false, "test fixture must name a path that really is absent");
  const { value, lines } = captureStderr(() => resolveNodeBinaryFrom(MISSING));
  assert.equal(value, PATH_NODE, "a vanished execPath must degrade to the bare name execvp resolves through PATH");
  assert.equal(lines.length, 1, `the fallback must be audible exactly once per resolve, got: ${JSON.stringify(lines)}`);
  const said = lines[0];
  assert.match(said, /#37/);
  assert.ok(said.includes(MISSING), "the message must name the path that vanished, or it is undebuggable");
  assert.match(said, /PATH/);
  // Whatever the probe found, the message has to state the runtime relationship
  // rather than leave a silent swap implied.
  assert.match(said, /same major|MAJOR VERSION MISMATCH|Could not run/);
});

test("the drifted case reports THIS server's version, so a silent runtime swap can be caught", () => {
  const { lines } = captureStderr(() => resolveNodeBinaryFrom(MISSING));
  assert.ok(
    lines[0].includes(process.version),
    `the message must name the server's own runtime (${process.version}) for comparison: ${lines[0]}`,
  );
});

test("mutant: without the existence check the dead path is handed straight to spawn (proves the tests above)", async () => {
  const name = "node-binary-no-existence-check";
  const mutated = await loadMutantModule<NodeBinaryModule>(
    name,
    [
      {
        // The pre-#37 behaviour: use the recorded path, whatever its state.
        file: "node-binary.ts",
        find: "  if (fs.existsSync(recorded)) return recorded;",
        replace: "  return recorded;",
      },
    ],
    "node-binary.ts",
  );
  try {
    const { value, lines } = captureStderr(() => mutated.resolveNodeBinaryFrom(MISSING));
    assert.equal(value, MISSING, "the mutant hands back the vanished path — exactly the 2026-07-28 ENOENT");
    assert.deepEqual(lines, [], "and it does so silently, which is why the incident cost an afternoon");
  } finally {
    dropMutant(name);
  }
});
