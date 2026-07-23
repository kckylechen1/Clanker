import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneConnection } from "../src/acp-client.js";
import { buildSpawnSpec } from "../src/backends.js";
import { LaneManager } from "../src/manager.js";
import { fakeResolver } from "./helpers.js";

const workspaceSandboxAvailable = (() => {
  if (process.platform !== "darwin") return false;
  try {
    fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

function fakeAgy(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-fake-agy-"));
  const executable = path.join(dir, "agy");
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CLANKER_AGY_CAPTURE"\n${body}\n`, { mode: 0o755 });
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(predicate(), true, `condition not met within ${timeoutMs}ms`);
}

async function prompt(spec: ReturnType<typeof sidecarSpec>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-workspace-"));
  const conn = await LaneConnection.connect({ spec, cwd, readOnly: true });
  try {
    const turn = conn.session.prompt("find evidence");
    turn.catch(() => {});
    let final = "";
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
      if (update.update.sessionUpdate === "agent_message_chunk" && update.update.content.type === "text") {
        final += update.update.content.text;
      }
    }
    await turn;
    return final;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; sidecar stderr: ${conn.stderr()}`);
  } finally {
    conn.close();
  }
}

test("Gemini backend is read-only, defaults model, and passes effort through sidecar env", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-spec-"));
  if (!workspaceSandboxAvailable) {
    assert.throws(
      () => buildSpawnSpec("gemini", { readOnly: true }, runDir),
      /requires macOS sandbox-exec|requires executable \/usr\/bin\/sandbox-exec/,
    );
    return;
  }
  const spec = buildSpawnSpec("gemini", { readOnly: true, effort: "high" }, runDir);
  assert.equal(spec.command, process.execPath);
  assert.match(spec.args[0], /gemini-acp\.m?js$/);
  assert.equal(spec.env.CLANKER_GEMINI_MODEL, "gemini-3.6-flash-medium");
  assert.equal(spec.env.CLANKER_GEMINI_EFFORT, "high");
  assert.equal(Object.keys(spec.env).some((key) => /API_KEY/.test(key)), false);
  assert.throws(() => buildSpawnSpec("gemini", { readOnly: false }, runDir), /reconnaissance-only/);
  assert.throws(
    () => buildSpawnSpec("gemini", { readOnly: true, model: "claude-sonnet-4-6" }, runDir),
    /requires a Gemini model id/,
  );
  assert.throws(
    () => buildSpawnSpec("gemini", { readOnly: true, effort: "low" }, runDir),
    /effort must be 'medium' or 'high'/,
  );
});

test("Gemini ACP sidecar projects stdout and forces plan, sandbox, print, and timeout", { skip: !workspaceSandboxAvailable }, async () => {
  const capture = path.join(os.tmpdir(), `clanker-agy-args-${process.pid}`);
  const output = await prompt(sidecarSpec(
    fakeAgy(`
if [ -n "\${GEMINI_API_KEY:-}\${GOOGLE_API_KEY:-}\${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  echo inherited-credential-leak >&2
  exit 9
fi
echo grounded-result`),
    capture,
    {
      GEMINI_API_KEY: "must-not-reach-agy",
      GOOGLE_API_KEY: "must-not-reach-agy",
      GOOGLE_APPLICATION_CREDENTIALS: "/must/not/reach/agy.json",
    },
  ));
  assert.equal(output, "grounded-result");
  const args = fs.readFileSync(capture, "utf8");
  assert.match(args, /--mode\nplan\n/);
  assert.match(args, /--sandbox\n/);
  assert.match(args, /--print-timeout\n3m\n/);
  assert.match(args, /--print\n/);
  assert.match(args, /conclusions, source URLs or repository evidence, uncertainties, and the recommended next lane/);
  assert.match(args, /Do not modify workspace files or run destructive commands/);
});

test("Gemini ACP sidecar fails loudly on nonzero and empty output", { skip: !workspaceSandboxAvailable }, async () => {
  for (const [body, expected] of [["echo boom >&2; exit 7", /exit 7.*boom/], ["exit 0", /empty output/]] as const) {
    const capture = path.join(os.tmpdir(), `clanker-agy-fail-${process.pid}-${Math.random()}`);
    await assert.rejects(prompt(sidecarSpec(fakeAgy(body), capture)), expected);
  }
});

test("Gemini ACP sidecar denies writes beneath the inspected workspace on macOS", { skip: !workspaceSandboxAvailable }, async () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-main-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: main }).status, 0);
  fs.writeFileSync(path.join(main, "tracked.txt"), "seed\n");
  assert.equal(spawnSync("git", ["add", "tracked.txt"], { cwd: main }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Clanker Test", "-c", "user.email=clanker@example.test", "commit", "-qm", "seed"], { cwd: main }).status, 0);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-worktree-parent-"));
  fs.rmdirSync(workspace);
  assert.equal(spawnSync("git", ["worktree", "add", "-q", "-b", `clanker-gemini-test-${process.pid}-${Date.now()}`, workspace], { cwd: main }).status, 0);
  const subdirectory = path.join(workspace, "nested");
  fs.mkdirSync(subdirectory);
  const capture = path.join(os.tmpdir(), `clanker-agy-deny-args-${process.pid}`);
  const workspaceTarget = path.join(workspace, "must-not-exist.txt");
  const primaryWorktreeTarget = path.join(main, "must-not-exist.txt");
  const commonGitTarget = path.join(main, ".git", "must-not-exist.txt");
  const agy = fakeAgy(`
echo forbidden > "$CLANKER_AGY_WORKSPACE_TARGET" 2>/dev/null || true
echo forbidden > "$CLANKER_AGY_PRIMARY_WORKTREE_TARGET" 2>/dev/null || true
echo forbidden > "$CLANKER_AGY_COMMON_GIT_TARGET" 2>/dev/null || true
echo workspace-protected`);
  const conn = await LaneConnection.connect({
    spec: sidecarSpec(agy, capture, {
      CLANKER_AGY_WORKSPACE_TARGET: workspaceTarget,
      CLANKER_AGY_PRIMARY_WORKTREE_TARGET: primaryWorktreeTarget,
      CLANKER_AGY_COMMON_GIT_TARGET: commonGitTarget,
    }),
    cwd: subdirectory,
    readOnly: true,
  });
  try {
    const turn = conn.session.prompt("test workspace boundary");
    turn.catch(() => {});
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
    }
    assert.equal((await turn).stopReason, "end_turn");
    assert.equal(fs.existsSync(workspaceTarget), false);
    assert.equal(fs.existsSync(primaryWorktreeTarget), false);
    assert.equal(fs.existsSync(commonGitTarget), false);
  } finally {
    conn.close();
    spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: main });
    fs.rmSync(workspace, { force: true, recursive: true });
    fs.rmSync(main, { force: true, recursive: true });
  }
});

test("Gemini ACP cancellation terminates agy and returns cancelled", { skip: !workspaceSandboxAvailable }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-cancel-workspace-"));
  const capture = path.join(os.tmpdir(), `clanker-agy-cancel-args-${process.pid}`);
  const pidFile = path.join(os.tmpdir(), `clanker-agy-cancel-pid-${process.pid}`);
  fs.rmSync(capture, { force: true });
  fs.rmSync(pidFile, { force: true });
  const agy = fakeAgy(`echo $$ > "$CLANKER_AGY_PID_FILE"\ntrap 'exit 143' TERM\nsleep 30`);
  const conn = await LaneConnection.connect({
    spec: sidecarSpec(agy, capture, { CLANKER_AGY_PID_FILE: pidFile }),
    cwd: workspace,
    readOnly: true,
  });
  try {
    const turn = conn.session.prompt("long research");
    turn.catch(() => {});
    await waitUntil(() => fs.existsSync(pidFile));
    const agyPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    await conn.cancel();
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
    }
    assert.equal((await turn).stopReason, "cancelled");
    await waitUntil(() => {
      try {
        process.kill(-agyPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    conn.close();
  }
});

test("Gemini manager rejects managed worktrees and persistent seats before backend resolution", async () => {
  let resolutions = 0;
  const manager = new LaneManager({
    disableReaper: true,
    resolveSpec() {
      resolutions += 1;
      throw new Error("must not resolve");
    },
  });
  try {
    await assert.rejects(
      manager.dispatchStart({ lane: "gemini", prompt: "research", readOnly: true, worktree: "never-created" }),
      /does not create or use managed worktrees/,
    );
    await assert.rejects(
      manager.dispatchStart({ lane: "gemini", prompt: "research", readOnly: true, seat: true }),
      /do not support persistent seats/,
    );
    assert.equal(resolutions, 0);
  } finally {
    await manager.shutdown();
  }
});

test("Gemini does not claim pre-existing dirty workspace files as touched", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-dirty-repo-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "pre-existing.txt"), "dirty before dispatch\n");
  const manager = new LaneManager({ disableReaper: true, baseRepo: repo, resolveSpec: fakeResolver });
  try {
    const { id } = await manager.dispatchStart({ lane: "gemini", prompt: "inspect", cwd: repo, readOnly: true });
    let result;
    do { result = await manager.wait(id, 1_000); } while (result.status === "running");
    assert.equal(result.status, "done");
    assert.deepEqual(result.touched_files, []);
  } finally {
    await manager.shutdown();
  }
});
