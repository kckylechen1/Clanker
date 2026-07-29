/**
 * Real-process acceptance for the startup wiring in src/index.ts: does a
 * process actually running `node --import tsx/esm src/index.ts` reclaim cold
 * run streams and keep the MCP stdio channel clean, or does that only hold in
 * the unit-tested pieces (retention.ts, host.ts) wired together by hand? Every
 * other test in this suite imports LaneManager directly and never exercises
 * main() itself.
 */
import "./isolate.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DAY_MS = 86_400_000;
/**
 * OS-bound: spawning node + tsx and letting a real server reach (or leave) its
 * transport. Mirrors helpers.ts OS_WAIT_BUDGET_MS (#29); this file deliberately
 * imports nothing from helpers so the server it spawns is configured only by
 * the env below.
 */
const OS_BUDGET_MS = 15_000;

test("index.ts startup reclaims a cold run's streams and keeps stdout pure JSON-RPC", async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-startup-sweep-runs-"));
  const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-startup-sweep-worktrees-"));
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-startup-sweep-ledger-"));

  const runDir = path.join(runsRoot, "codex-cold-startup");
  fs.mkdirSync(runDir, { recursive: true });
  const tenDaysAgo = (Date.now() - 10 * DAY_MS) / 1000;
  for (const name of ["events.jsonl", "chunks.log"]) {
    const file = path.join(runDir, name);
    fs.writeFileSync(file, "x".repeat(64));
    fs.utimesSync(file, tenDaysAgo, tenDaysAgo);
  }

  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", path.join(REPO_ROOT, "src", "index.ts"), "--host", "claude"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLANKER_RUNS_ROOT: runsRoot,
        CLANKER_WORKTREES_ROOT: worktreesRoot,
        CLANKER_LEDGER_DIR: ledgerDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const timeoutMs = OS_BUDGET_MS;
    const deadline = Date.now() + timeoutMs;
    while (!stderr.includes("reclaimed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      stderr.includes("reclaimed"),
      `expected "reclaimed" on stderr within ${timeoutMs}ms; stderr so far:\n${stderr}`,
    );

    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false, "cold events.jsonl must be swept");
    assert.equal(fs.existsSync(path.join(runDir, "chunks.log")), false, "cold chunks.log must be swept");

    // The startup banner (src/index.ts:37) and the sweep line (src/index.ts:45)
    // both go to stderr by design, so nothing but MCP JSON-RPC frames should
    // ever land on stdout — this is the wire a real host parses.
    const stdoutLines = stdout.split("\n").filter((line) => line.trim().length > 0);
    for (const line of stdoutLines) {
      assert.doesNotThrow(() => JSON.parse(line), `non-JSON-RPC noise on stdout: ${line}`);
    }
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      const fallback = setTimeout(resolve, 3_000);
      fallback.unref();
    });
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
});

/**
 * #29 coverage gap: src/index.ts installs SIGINT/SIGTERM handlers that run
 * `manager.shutdown()` and then `process.exit(0)`, and nothing tested them. The
 * test above sends SIGTERM only as cleanup, behind a 3s fallback that resolves
 * whether or not the child ever died — so a server that had stopped honouring
 * the signal would leave the suite fully green while every host session leaked
 * a server process holding worktrees and live backends.
 *
 * The discriminator is the exit SHAPE, not merely "it went away": with the
 * handler the process exits 0 with no signal; without it, node's default
 * disposition kills it, which reports exitCode null / signal SIGTERM.
 */
test("index.ts: SIGTERM runs the shutdown handler and exits 0, rather than dying by signal", async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sigterm-runs-"));
  const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sigterm-worktrees-"));
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sigterm-ledger-"));

  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", path.join(REPO_ROOT, "src", "index.ts"), "--host", "codex"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLANKER_RUNS_ROOT: runsRoot,
        CLANKER_WORKTREES_ROOT: worktreesRoot,
        CLANKER_LEDGER_DIR: ledgerDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    // Only signal it once it is actually serving: the banner is written after
    // `server.connect(transport)` (src/index.ts), so it is the one observable
    // proof the handlers are installed and the transport is up.
    const deadline = Date.now() + OS_BUDGET_MS;
    while (!stderr.includes("running on stdio") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(stderr, /clanker-mcp-server v[\d.]+ host=codex running on stdio/,
      `server never announced itself; stderr so far:\n${stderr}`);

    child.kill("SIGTERM");
    // The guard is CLEARED on the winning path: a race like this leaves its
    // loser's timer pending, and a pending timer holds the test runner's event
    // loop open for the full budget after the test has already passed — 15s of
    // dead wall clock per occurrence (measured: it turned this 200ms test into
    // a 15s one, and the same shape costs manager.test.ts 10s).
    let guard!: NodeJS.Timeout;
    const outcome = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        guard = setTimeout(
          () => reject(new Error(`server still alive ${OS_BUDGET_MS}ms after SIGTERM`)),
          OS_BUDGET_MS,
        );
      }),
    ]).finally(() => clearTimeout(guard));
    assert.equal(outcome.signal, null, "the handler must run, not node's default signal disposition");
    assert.equal(outcome.code, 0, "a shutdown that could not complete must not report success");
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
});
