/**
 * #19-F8b — the orb setup must hand Node 24 to the NEXT command.
 *
 * The shipped revision installed Node 24, printed `setup: node v24.18.0` and
 * `setup: ready`, and the next independent command still got v20.9.0: PATH
 * changes die with the child shell, and `.profile`/`.bashrc` are not read by
 * the non-login, non-interactive shells an orb runs commands in. `npm test` on
 * that runtime cancels 21 of 146 cases and typecheck/build die outright — a
 * broken toolchain reported as a green setup.
 *
 * The load-bearing fix is a gate that answers "what will the NEXT command get?"
 * instead of "what does this shell have?". These tests drive that gate for real
 * (`.agents/setup --verify-node-only`) against fabricated PATHs, so they fail on
 * the pre-fix script, which had no such gate at all.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The script under contract. Overridable so the same contract can be pointed at
 * a candidate — e.g. `CLANKER_SETUP_PATH=/tmp/setup.old npm test` re-runs it
 * against the shipped revision, where it must fail.
 */
const SETUP = process.env.CLANKER_SETUP_PATH ?? fileURLToPath(new URL("../.agents/setup", import.meta.url));

/** A directory holding a fake `node` that reports `version`. */
function fakeNodeDir(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clanker-fake-node-${version}-`));
  const bin = path.join(dir, "node");
  // Answers the two things the gate asks: `node -p "process.versions.node"`.
  fs.writeFileSync(bin, `#!/usr/bin/env bash\necho "${version}"\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

/**
 * A bin directory with exactly the tools the gate itself needs and NO node —
 * the "this image ships no node at all" case. Built by symlink rather than by
 * borrowing /usr/bin, because on a Linux orb /usr/bin may itself hold a node
 * and the case under test would evaporate.
 */
function nodelessToolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-no-node-"));
  for (const tool of ["bash", "env", "sed", "cut"]) {
    const resolved = spawnSync("/usr/bin/env", ["which", tool], { encoding: "utf8" }).stdout.trim();
    assert.ok(resolved, `test precondition: '${tool}' must exist to build a node-free PATH`);
    fs.symlinkSync(resolved, path.join(dir, tool));
  }
  return dir;
}

function verifyWithPath(pathValue: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SETUP, "--verify-node-only"], {
    env: { HOME: process.env.HOME ?? os.homedir(), PATH: pathValue },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("#19-F8b: setup refuses when the next command would get a node below the floor", () => {
  const stale = fakeNodeDir("20.9.0");
  try {
    const r = verifyWithPath(`${stale}:/usr/bin:/bin`);
    assert.notEqual(r.status, 0, "a setup that cannot deliver node 24 to the next command must exit non-zero");
    assert.match(r.stderr, /would get node v20\.9\.0/, "the refusal must name the version the next command really gets");
    assert.match(r.stderr, /cancels 21 cases/, "the refusal must say why a stale runtime is worse than no runtime");
    assert.doesNotMatch(r.stdout, /ready/, "a refusing setup must never print a ready line");
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }
});

test("#19-F8b: setup refuses when the next command would find no node at all", () => {
  const nodeless = nodelessToolDir();
  try {
    const r = verifyWithPath(nodeless);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /finds no usable node/);
  } finally {
    fs.rmSync(nodeless, { recursive: true, force: true });
  }
});

test("#19-F8b: setup passes only when a fresh shell on the orb's own PATH resolves node >= 24", () => {
  const fresh = fakeNodeDir("24.18.0");
  try {
    const r = verifyWithPath(`${fresh}:/usr/bin:/bin`);
    assert.equal(r.status, 0, `gate rejected a compliant runtime: ${r.stderr}`);
    assert.match(r.stdout, /later commands get node v24\.18\.0/);
    assert.match(r.stdout, new RegExp(`from ${fresh}/node`), "the gate must report where that node resolved from");
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("#19-F8b: the gate reads the ambient PATH, not the PATH setup builds for itself", () => {
  // The exact failure that shipped: an inherited/exported PATH that points at a
  // good node must NOT let a stale ambient PATH pass. The gate probes with
  // `env -i`, so a node reachable only through this process's environment is
  // invisible to it.
  const stale = fakeNodeDir("20.9.0");
  const good = fakeNodeDir("24.18.0");
  try {
    const result = spawnSync("bash", [SETUP, "--verify-node-only"], {
      env: {
        HOME: process.env.HOME ?? os.homedir(),
        PATH: `${stale}:/usr/bin:/bin`,
        // A "helpful" leftover that must not be consulted.
        NODE_PATH: good,
        NVM_BIN: good,
      },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "a node reachable only via this process's env is not what the next command gets");
    assert.match(result.stderr ?? "", /would get node v20\.9\.0/);
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
    fs.rmSync(good, { recursive: true, force: true });
  }
});

test("#19-F8b: setup no longer leans on shell startup files or nvm's nonexistent 'current' link", () => {
  // Comments are allowed to discuss the retired mechanisms — that is where the
  // incident is recorded. Only executable lines are held to the ban.
  const code = fs
    .readFileSync(SETUP, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  // Both are the mechanisms that produced a green setup and a v20.9.0 next
  // command: rc files that non-login shells never read, and an nvm path that
  // does not exist (there is no versions/node/current symlink).
  assert.doesNotMatch(code, /\.bashrc|\.profile/, "setup must not write shell startup files to pass PATH along");
  assert.doesNotMatch(code, /versions\/node\/current/, "nvm has no 'current' symlink; that PATH entry resolved to nothing");
  assert.match(code, /env -i/, "the gate must probe a fresh shell, not this one");
});
