import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneConnection } from "../src/acp-client.js";
import { buildSpawnSpec } from "../src/backends.js";
import { LaneManager } from "../src/manager.js";
import { fakeResolver, fakeSpec } from "./helpers.js";

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
  assert.equal(spec.env.CLANKER_GEMINI_MODEL, "gemini-3.6-flash-high");
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

test("dispatchProfile routes the gemini role from the profile id into the spawn spec", async () => {
  const seen: (string | undefined)[] = [];
  const m = new LaneManager({
    resolveSpec: (_lane, opts, _runDir) => {
      seen.push(opts.geminiRole);
      return fakeSpec();
    },
    disableReaper: true,
    baseRepo: os.tmpdir(),
  });
  try {
    const a = await m.dispatchProfile({ profile: "gemini-research", prompt: "research", cwd: os.tmpdir() });
    const b = await m.dispatchProfile({ profile: "gemini-recon", prompt: "survey", cwd: os.tmpdir() });
    assert.deepEqual(seen, ["gemini-research", "gemini-recon"]);
    await waitUntil(() => m.status(a.id).status !== "running" && m.status(b.id).status !== "running", 4_000);
  } finally {
    await m.shutdown();
  }
});

test("Gemini spec forwards CLANKER_GEMINI_ROLE only when the dispatch carries one", { skip: !workspaceSandboxAvailable }, () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-spec-role-"));
  const plain = buildSpawnSpec("gemini", { readOnly: true }, runDir);
  assert.equal("CLANKER_GEMINI_ROLE" in plain.env, false);
  const research = buildSpawnSpec("gemini", { readOnly: true, geminiRole: "gemini-research" }, runDir);
  assert.equal(research.env.CLANKER_GEMINI_ROLE, "gemini-research");
});

test("Gemini ACP sidecar picks the research role copy on CLANKER_GEMINI_ROLE=gemini-research, recon otherwise", { skip: !workspaceSandboxAvailable }, async () => {
  const researchCapture = path.join(os.tmpdir(), `clanker-agy-role-research-${process.pid}`);
  await prompt(sidecarSpec(fakeAgy("echo grounded-result"), researchCapture, { CLANKER_GEMINI_ROLE: "gemini-research" }));
  const researchArgs = fs.readFileSync(researchCapture, "utf8");
  assert.match(researchArgs, /read-only online research lane/);
  assert.match(researchArgs, /every conclusion must carry its source URL/);
  assert.match(researchArgs, /Do not modify workspace files or run destructive commands/);

  for (const env of [{}, { CLANKER_GEMINI_ROLE: "gemini-recon" }, { CLANKER_GEMINI_ROLE: "bogus" }] as Record<string, string>[]) {
    const capture = path.join(os.tmpdir(), `clanker-agy-role-recon-${process.pid}-${Math.random()}`);
    await prompt(sidecarSpec(fakeAgy("echo grounded-result"), capture, env));
    const args = fs.readFileSync(capture, "utf8");
    assert.match(args, /read-only reconnaissance lane/);
    assert.match(args, /conclusions, source URLs or repository evidence, uncertainties, and the recommended next lane/);
    assert.match(args, /Do not modify workspace files or run destructive commands/);
  }
});

test("Gemini spec forwards only an explicit CLANKER_GEMINI_PRINT_TIMEOUT override, never a hardcoded default", { skip: !workspaceSandboxAvailable }, () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-spec-timeout-"));
  const original = process.env.CLANKER_GEMINI_PRINT_TIMEOUT;
  try {
    delete process.env.CLANKER_GEMINI_PRINT_TIMEOUT;
    // The default must live solely in gemini-acp.ts's own fallback; the
    // production spawn path (buildSpawnSpec -> acp-client's env spread)
    // must not shadow it with a second hardcoded default, or the sidecar
    // never sees the var "unset" and its default becomes dead code.
    const spec = buildSpawnSpec("gemini", { readOnly: true }, runDir);
    assert.equal("CLANKER_GEMINI_PRINT_TIMEOUT" in spec.env, false);

    process.env.CLANKER_GEMINI_PRINT_TIMEOUT = "20m";
    const overridden = buildSpawnSpec("gemini", { readOnly: true }, runDir);
    assert.equal(overridden.env.CLANKER_GEMINI_PRINT_TIMEOUT, "20m");
  } finally {
    if (original === undefined) delete process.env.CLANKER_GEMINI_PRINT_TIMEOUT;
    else process.env.CLANKER_GEMINI_PRINT_TIMEOUT = original;
  }
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
  assert.match(args, /--print-timeout\n10m\n/);
  assert.match(args, /--print\n/);
  assert.match(args, /conclusions, source URLs or repository evidence, uncertainties, and the recommended next lane/);
  assert.match(args, /Do not modify workspace files or run destructive commands/);
});

test("Gemini ACP sidecar honors CLANKER_GEMINI_PRINT_TIMEOUT override over the 10m default", { skip: !workspaceSandboxAvailable }, async () => {
  const capture = path.join(os.tmpdir(), `clanker-agy-timeout-override-${process.pid}`);
  await prompt(sidecarSpec(fakeAgy("echo grounded-result"), capture, { CLANKER_GEMINI_PRINT_TIMEOUT: "20m" }));
  const args = fs.readFileSync(capture, "utf8");
  assert.match(args, /--print-timeout\n20m\n/);
});

test("Gemini ACP sidecar fails loudly on nonzero and empty output", { skip: !workspaceSandboxAvailable }, async () => {
  for (const [body, expected] of [["echo boom >&2; exit 7", /exit 7.*boom/], ["exit 0", /empty output/]] as const) {
    const capture = path.join(os.tmpdir(), `clanker-agy-fail-${process.pid}-${Math.random()}`);
    await assert.rejects(prompt(sidecarSpec(fakeAgy(body), capture)), expected);
  }
});

test("Gemini ACP sidecar classifies a print-timeout hit distinctly from a backend crash", { skip: !workspaceSandboxAvailable }, async () => {
  const capture = path.join(os.tmpdir(), `clanker-agy-timeout-classify-${process.pid}`);
  // agy exits 1 with this exact stderr phrase when its own --print-timeout
  // ceiling elapses; the wrapping error must not read as a generic crash.
  await assert.rejects(
    prompt(sidecarSpec(fakeAgy("echo 'timeout waiting for response' >&2; exit 1"), capture)),
    /print-timeout/,
  );
  await assert.rejects(
    prompt(sidecarSpec(fakeAgy("echo 'timeout waiting for response' >&2; exit 1"), capture)),
    (error: Error) => !/Clanker: Gemini agy failed \(exit/.test(error.message),
  );
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
    // 15s, not the 2s default (#29). This is the only wait in the file whose
    // subject is the OS reaping a process GROUP rather than this process
    // writing a file, and the fake agy sits in `trap ... TERM` + `sleep 30`:
    // the signal has to be delivered, the trap has to run, and the group has
    // to be torn down, none of which this process schedules. Under load — a
    // full suite on a busy machine — that measured 1 red in 6 runs against a
    // 2s budget, i.e. a test that fails for being on a slow machine, and CI
    // treats it as a product regression.
    //
    // The budget is an upper bound, not a sleep: waitUntil returns the moment
    // the group is gone, so a healthy machine pays nothing for the headroom.
    // Raising it weakens nothing — the assertion is still "the group dies",
    // never "the group dies fast".
    await waitUntil(() => {
      try {
        process.kill(-agyPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15_000);
  } finally {
    conn.close();
  }
});

test("Gemini manager rejects managed worktrees before backend resolution", async () => {
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
      /Gemini rejects worktree/,
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
