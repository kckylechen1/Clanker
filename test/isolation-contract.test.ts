/**
 * The gate on `test/isolate.ts` itself (#29).
 *
 * Two failure modes are covered, because the fallback is worthless if either
 * one is open:
 *
 *   1. A new test file forgets the first import, so it runs against the real
 *      `~/.cache/clanker` the moment someone debugs it with a bare
 *      `node --import tsx/esm --test test/<file>.test.ts`. This is the mode
 *      that actually fired: 34 leaked worktrees under the host cache, polluting
 *      the very surface the orphan scan (#32) and retention read.
 *   2. The redirect silently stops working — ordering regressions are invisible
 *      in a normal `npm test` run, because there the env is already set by the
 *      script and the fallback never executes. So the behaviour is measured in
 *      a CHILD process with the three vars deleted, which is the only place the
 *      fallback path exists.
 *
 * Case 2 imports `src/constants.ts` after `test/isolate.ts` in the child, in
 * the same order a test file does, so it proves the ordering claim (isolation
 * applied before the module that reads env at module scope) rather than just
 * asserting that `process.env` was mutated.
 */
import "./isolate.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ISOLATED_ROOTS } from "./isolate.js";

const TEST_DIR = fileURLToPath(new URL("./", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIRST_IMPORT = 'import "./isolate.js";';

/**
 * Spawning `node --import tsx/esm` pays a cold TypeScript-transform start on
 * top of process creation, so this budget is OS-bound, not scheduler-bound
 * (#29 part B): it must survive a loaded CI box, and a too-tight value here
 * turns into a red build that says nothing about the code.
 */
const CHILD_BUDGET_MS = 60_000;

/** Run a snippet under tsx in a child process with `env` overrides applied. */
function probe(env: Record<string, string | undefined>): { stdout: string; stderr: string } {
  const isolate = pathToFileURL(path.join(TEST_DIR, "isolate.ts")).href;
  const constants = pathToFileURL(path.join(REPO_ROOT, "src", "constants.ts")).href;
  const script =
    `await import(${JSON.stringify(isolate)});\n` +
    `const c = await import(${JSON.stringify(constants)});\n` +
    `console.log("PROBE " + JSON.stringify({ runsEnv: process.env.CLANKER_RUNS_ROOT, ` +
    `worktreesEnv: process.env.CLANKER_WORKTREES_ROOT, ledgerEnv: process.env.CLANKER_LEDGER_DIR, ` +
    `runsConst: c.RUNS_ROOT, worktreesConst: c.WORKTREES_ROOT }));\n`;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) childEnv[k] = v;
  }
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: CHILD_BUDGET_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0, `probe child failed (${r.status}): ${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

function parseProbe(stdout: string): Record<string, string> {
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE "));
  assert.ok(line, `probe printed no PROBE line: ${stdout}`);
  return JSON.parse(line.slice("PROBE ".length));
}

test("#29: every test file's first import is ./isolate.js", () => {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts")).sort();
  assert.ok(files.length > 20, `expected the whole suite, found ${files.length} files`);
  const offenders: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(TEST_DIR, file), "utf8").split("\n");
    const first = lines.find((l) => /^import\s|^import"/.test(l));
    if (first?.trim() !== FIRST_IMPORT) offenders.push(`${file}: first import is ${first ?? "(none)"}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files can write into the host's ~/.cache/clanker when run directly; ` +
      `add \`${FIRST_IMPORT}\` above their first import:\n${offenders.join("\n")}`,
  );
});

test("#29: with the roots unset, isolation redirects into .test-tmp and says so", () => {
  const { stdout, stderr } = probe({
    CLANKER_RUNS_ROOT: undefined,
    CLANKER_WORKTREES_ROOT: undefined,
    CLANKER_LEDGER_DIR: undefined,
  });
  const seen = parseProbe(stdout);
  assert.equal(seen.runsEnv, ISOLATED_ROOTS.CLANKER_RUNS_ROOT);
  assert.equal(seen.worktreesEnv, ISOLATED_ROOTS.CLANKER_WORKTREES_ROOT);
  assert.equal(seen.ledgerEnv, ISOLATED_ROOTS.CLANKER_LEDGER_DIR);
  // The load-bearing half: the constants module, which reads env at module
  // scope, must have observed the redirect — not the host cache.
  assert.equal(seen.worktreesConst, ISOLATED_ROOTS.CLANKER_WORKTREES_ROOT);
  assert.equal(seen.runsConst, ISOLATED_ROOTS.CLANKER_RUNS_ROOT);
  assert.ok(
    !seen.worktreesConst.startsWith(path.join(os.homedir(), ".cache")),
    `worktrees root leaked into the host cache: ${seen.worktreesConst}`,
  );
  // Deviating from the caller-supplied setup is allowed, but never silent.
  assert.match(stderr, /host isolation was not set up by the caller/);
});

test("#29: an explicitly set root is never overridden", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-isolation-"));
  try {
    const { stdout, stderr } = probe({
      CLANKER_RUNS_ROOT: path.join(scratch, "runs"),
      CLANKER_WORKTREES_ROOT: path.join(scratch, "worktrees"),
      CLANKER_LEDGER_DIR: path.join(scratch, "ledger"),
    });
    const seen = parseProbe(stdout);
    assert.equal(seen.runsEnv, path.join(scratch, "runs"));
    assert.equal(seen.worktreesEnv, path.join(scratch, "worktrees"));
    assert.equal(seen.ledgerEnv, path.join(scratch, "ledger"));
    assert.equal(seen.worktreesConst, path.join(scratch, "worktrees"));
    assert.doesNotMatch(stderr, /host isolation was not set up/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("#29: a blank root counts as unset, not as a relative path", () => {
  // src/ledger.ts's #37 D2 lesson: `CLANKER_LEDGER_DIR=""` from an unset shell
  // var would resolve to a relative path under the server's cwd. Blank must
  // take the isolated fallback, same as missing.
  const { stdout } = probe({
    CLANKER_RUNS_ROOT: "  ",
    CLANKER_WORKTREES_ROOT: "",
    CLANKER_LEDGER_DIR: "",
  });
  const seen = parseProbe(stdout);
  assert.equal(seen.worktreesEnv, ISOLATED_ROOTS.CLANKER_WORKTREES_ROOT);
  assert.equal(seen.runsEnv, ISOLATED_ROOTS.CLANKER_RUNS_ROOT);
  assert.equal(seen.ledgerEnv, ISOLATED_ROOTS.CLANKER_LEDGER_DIR);
});
