/**
 * Real-process acceptance for the startup wiring in src/index.ts: does a
 * process actually running `node --import tsx/esm src/index.ts` reclaim cold
 * run streams and keep the MCP stdio channel clean, or does that only hold in
 * the unit-tested pieces (retention.ts, host.ts) wired together by hand? Every
 * other test in this suite imports LaneManager directly and never exercises
 * main() itself.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DAY_MS = 86_400_000;

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
    const timeoutMs = 15_000;
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
