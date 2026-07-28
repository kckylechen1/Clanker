import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneConnection } from "../src/acp-client.js";
import { buildSpawnSpec } from "../src/backends.js";
import { LaneManager } from "../src/manager.js";
import { resolveNodeBinary } from "../src/node-binary.js";
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

/**
 * A capture/pid file living in its own fresh mkdtempSync directory, matching
 * the rest of this file's per-call isolation (fakeAgy, prompt()'s cwd). The
 * previous fixed `os.tmpdir()` + `process.pid` name could collide across
 * tests or loop iterations in the same process and left every file behind.
 */
function tmpCaptureFile(prefix: string, name = "capture"): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clanker-agy-${prefix}-`));
  return { dir, path: path.join(dir, name) };
}

function sidecarSpec(agy: string, capture: string, env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: ["--import", path.resolve("node_modules/tsx/dist/esm/index.mjs"), path.resolve("src/gemini-acp.ts")],
    env: { CLANKER_AGY_PATH: agy, CLANKER_AGY_CAPTURE: capture, ...env },
    warnings: [],
  };
}

/** Signal 0: does a pid still exist? (The teardown tests' only honest oracle.) */
function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every pid a fake agy has appended so far — one line per turn. */
function readPids(file: string): number[] {
  return fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map(Number);
}

function readPid(file: string): number {
  const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  assert.equal(Number.isInteger(pid) && pid > 0, true, `expected a pid in ${file}, got ${JSON.stringify(fs.readFileSync(file, "utf8"))}`);
  return pid;
}

/**
 * A pid's process group, read from OUTSIDE the sandbox.
 *
 * Not from inside the fake agy: `sandbox-exec` refuses to exec /bin/ps at all
 * ("Operation not permitted", measured), profile or no profile, so a sandboxed
 * child cannot report its own pgid.
 */
function pgidOf(pid: number): number {
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  assert.equal(out.status, 0, `ps failed for pid ${pid}: ${out.stderr}`);
  const pgid = Number.parseInt(out.stdout.trim(), 10);
  assert.equal(Number.isInteger(pgid) && pgid > 0, true, `expected a pgid for pid ${pid}, got ${JSON.stringify(out.stdout)}`);
  return pgid;
}

function killIfAlive(...pids: number[]): void {
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* raced us */
    }
  }
}

/**
 * Drain updates to the turn's stop, but fail instead of hanging.
 *
 * A cancel that does not settle is exactly the regression these tests exist to
 * catch, and `nextUpdate()` waits forever — without this cap a regression would
 * wedge the whole suite rather than report a red test.
 */
async function stopReasonWithin(
  conn: Awaited<ReturnType<typeof LaneConnection.connect>>,
  turn: Promise<{ stopReason: string }>,
  timeoutMs: number,
): Promise<string> {
  let handle: NodeJS.Timeout;
  const capped = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`turn produced no stop update within ${timeoutMs}ms`)), timeoutMs);
    handle.unref?.();
  });
  const drained = (async () => {
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
    }
    return (await turn).stopReason;
  })();
  try {
    return await Promise.race([drained, capped]);
  } finally {
    clearTimeout(handle!);
  }
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
  // #37: the sidecar's node is the recorded-and-still-existing one.
  assert.equal(spec.command, resolveNodeBinary());
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
  const research = tmpCaptureFile("role-research");
  try {
    await prompt(sidecarSpec(fakeAgy("echo grounded-result"), research.path, { CLANKER_GEMINI_ROLE: "gemini-research" }));
    const researchArgs = fs.readFileSync(research.path, "utf8");
    assert.match(researchArgs, /read-only online research lane/);
    assert.match(researchArgs, /every conclusion must carry its source URL/);
    assert.match(researchArgs, /Do not modify workspace files or run destructive commands/);
  } finally {
    fs.rmSync(research.dir, { recursive: true, force: true });
  }

  for (const env of [{}, { CLANKER_GEMINI_ROLE: "gemini-recon" }, { CLANKER_GEMINI_ROLE: "bogus" }] as Record<string, string>[]) {
    const recon = tmpCaptureFile("role-recon");
    try {
      await prompt(sidecarSpec(fakeAgy("echo grounded-result"), recon.path, env));
      const args = fs.readFileSync(recon.path, "utf8");
      assert.match(args, /read-only reconnaissance lane/);
      assert.match(args, /conclusions, source URLs or repository evidence, uncertainties, and the recommended next lane/);
      assert.match(args, /Do not modify workspace files or run destructive commands/);
    } finally {
      fs.rmSync(recon.dir, { recursive: true, force: true });
    }
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
  const { dir, path: capture } = tmpCaptureFile("args");
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini ACP sidecar honors CLANKER_GEMINI_PRINT_TIMEOUT override over the 10m default", { skip: !workspaceSandboxAvailable }, async () => {
  const { dir, path: capture } = tmpCaptureFile("timeout-override");
  try {
    await prompt(sidecarSpec(fakeAgy("echo grounded-result"), capture, { CLANKER_GEMINI_PRINT_TIMEOUT: "20m" }));
    const args = fs.readFileSync(capture, "utf8");
    assert.match(args, /--print-timeout\n20m\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini ACP sidecar fails loudly on nonzero and empty output", { skip: !workspaceSandboxAvailable }, async () => {
  for (const [body, expected] of [["echo boom >&2; exit 7", /exit 7.*boom/], ["exit 0", /empty output/]] as const) {
    const { dir, path: capture } = tmpCaptureFile("fail");
    try {
      await assert.rejects(prompt(sidecarSpec(fakeAgy(body), capture)), expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Gemini ACP sidecar classifies a print-timeout hit distinctly from a backend crash", { skip: !workspaceSandboxAvailable }, async () => {
  const { dir, path: capture } = tmpCaptureFile("timeout-classify");
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  const { dir: captureDir, path: capture } = tmpCaptureFile("deny-args");
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
    fs.rmSync(captureDir, { recursive: true, force: true });
  }
});

test("Gemini ACP cancellation terminates agy and returns cancelled", { skip: !workspaceSandboxAvailable }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-cancel-workspace-"));
  const { dir: captureDir, path: capture } = tmpCaptureFile("cancel-args");
  const pidFile = path.join(captureDir, "pid");
  const agy = fakeAgy(`echo $$ > "$CLANKER_AGY_PID_FILE"\ntrap 'exit 143' TERM\nsleep 30`);
  const conn = await LaneConnection.connect({
    spec: sidecarSpec(agy, capture, { CLANKER_AGY_PID_FILE: pidFile }),
    cwd: workspace,
    readOnly: true,
  });
  try {
    const turn = conn.session.prompt("long research");
    turn.catch(() => {});
    // 15s, not the 2s default: this waits on the OS actually spawning and
    // running the sidecar's shell far enough to reach the `echo $$ >` line —
    // process-launch latency, not this-process work — same class as #29
    // below.
    await waitUntil(() => fs.existsSync(pidFile), 15_000);
    const agyPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    await conn.cancel();
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
    }
    assert.equal((await turn).stopReason, "cancelled");
    // The subject is agy's PID, not `-agyPid` as it was before PR #40's cold
    // review. agy no longer leads a group of its own (gemini-acp.ts spawns it
    // undetached so the manager's group kill covers it), so `kill(-agyPid, 0)`
    // now throws ESRCH the instant it is called, whether or not anything died:
    // as a liveness probe it had become vacuously green.
    //
    // Note what this fixture actually exercises now, measured on this machine:
    // agy is `/bin/sh` sitting in `trap 'exit 143' TERM` + a FOREGROUND `sleep
    // 30`, and a SIGTERM to the shell's pid alone does not kill it — the shell
    // defers the trap until the foreground child returns, which it does not.
    // So this turn dies on terminateChild's 1s SIGKILL escalation, i.e. by
    // SIGNAL (exitCode null, signalCode set), which is the very shape the
    // review's probe caught the old exitCode-only gates mishandling. `close`
    // stays pending behind the orphaned `sleep`, so `cancelled` above is proof
    // the turn settles on `exit` and not on the pipes.
    //
    // 15s, not the 2s default (#29): the subject is the OS delivering a signal
    // and reaping, none of which this process schedules, and a 2s budget
    // measured 1 red in 6 runs on a loaded machine — a test that fails for
    // being on a slow machine, which CI reads as a product regression. The
    // budget is an upper bound, not a sleep: waitUntil returns the moment agy
    // is gone, so a healthy machine pays nothing for the headroom. The
    // assertion is still "agy dies", never "agy dies fast".
    await waitUntil(() => !alive(agyPid), 15_000);
  } finally {
    conn.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(captureDir, { recursive: true, force: true });
  }
});

/**
 * PR #40 cold review (run codex-62e86), BUG 2: agy could survive the manager.
 *
 * The sidecar used to spawn agy `detached`, into a group of its own, and relied
 * on its own SIGTERM handler to tear that group down. The manager only ever
 * knows the SIDECAR's group, and its escalation is an uncatchable SIGKILL — so
 * any grace shorter than the sidecar's fixed 1s inner escalation killed the one
 * process that knew agy's pgid, and agy plus everything under it was orphaned.
 *
 * `terminateGraceMs: 50` is that trigger, made deterministic; the fake agy
 * ignores SIGTERM outright so nothing cooperative can rescue the test.
 */
test("agy shares the sidecar's process group, so the manager's kill covers it even when the sidecar is SIGKILLed first", { skip: !workspaceSandboxAvailable }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-group-workspace-"));
  const { dir: captureDir, path: capture } = tmpCaptureFile("group-args");
  const pidFile = path.join(captureDir, "pid");
  const helperPidFile = path.join(captureDir, "helper");
  // An agy that cannot be talked down: SIGTERM ignored (inherited by the helper
  // it leaves holding the turn's stdout), and a helper standing in for the
  // terminal/search subprocesses a real headless agent launches. `wait` rather
  // than another `sleep` keeps the helper the ONLY descendant. The pid file is
  // written last, so waiting on it means both exist.
  const agy = fakeAgy([
    `trap '' TERM`,
    `sleep 45 &`,
    `echo $! > "$CLANKER_AGY_HELPER_PID_FILE"`,
    `echo $$ > "$CLANKER_AGY_PID_FILE"`,
    `wait`,
  ].join("\n"));
  let sidecarPid = 0;
  let agyPid = 0;
  let helperPid = 0;
  const conn = await LaneConnection.connect({
    spec: sidecarSpec(agy, capture, {
      CLANKER_AGY_PID_FILE: pidFile,
      CLANKER_AGY_HELPER_PID_FILE: helperPidFile,
    }),
    cwd: workspace,
    readOnly: true,
    terminateGraceMs: 50,
    onSpawn: ({ pid }) => { sidecarPid = pid; },
  });
  try {
    const turn = conn.session.prompt("long research");
    turn.catch(() => {});
    await waitUntil(() => fs.existsSync(pidFile), 15_000);
    agyPid = readPid(pidFile);
    helperPid = readPid(helperPidFile);
    // The structural claim, checked directly: agy's process group IS the
    // sidecar's, and so is its helper's. Restore `detached: true` in runAgy and
    // both read back agy's own pid instead.
    assert.equal(pgidOf(agyPid), sidecarPid, "agy must run in the sidecar's process group, not one of its own");
    assert.equal(pgidOf(helperPid), sidecarPid, "agy's helper must inherit the sidecar's group too");
    assert.equal(alive(agyPid) && alive(helperPid), true);
    // One group kill from the manager, escalating to SIGKILL at 50ms — long
    // before terminateChild's 1s escalation could contribute anything.
    conn.close();
    await waitUntil(() => !alive(agyPid) && !alive(helperPid), 15_000);
  } finally {
    killIfAlive(agyPid, helperPid);
    conn.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(captureDir, { recursive: true, force: true });
  }
});

/**
 * The other half of that trade, which the fix must not silently pay: with agy
 * in the sidecar's group, a cancel can only signal agy's own pid, so any helper
 * agy leaves behind keeps the turn's stdout pipe open and the child's `close`
 * event pending — measured at +1.5s past the child's death on this machine, and
 * unbounded in general. manager.ts's cancel() only waits CANCEL_GRACE_MS for
 * `cancelled` before it force-kills the run and stamps forced_kill on the
 * telemetry, so a turn that settles on the pipes turns every Gemini cancel into
 * a recorded forced kill.
 */
test("Gemini cancel settles on the child's exit, not on pipes an orphaned helper still holds", { skip: !workspaceSandboxAvailable }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-orphan-workspace-"));
  const { dir: captureDir, path: capture } = tmpCaptureFile("orphan-args");
  const pidFile = path.join(captureDir, "pid");
  const helperPidFile = path.join(captureDir, "helper");
  // SIGTERM ignored, so agy dies on the sidecar's 1s SIGKILL escalation: a
  // SIGNAL exit (exitCode null, signalCode set), the shape the review's Node
  // probe caught the old gates reading as "still running".
  const agy = fakeAgy([
    `trap '' TERM`,
    `sleep 45 &`,
    `echo $! > "$CLANKER_AGY_HELPER_PID_FILE"`,
    `echo $$ > "$CLANKER_AGY_PID_FILE"`,
    `wait`,
  ].join("\n"));
  let sidecarPid = 0;
  let agyPid = 0;
  let helperPid = 0;
  const conn = await LaneConnection.connect({
    spec: sidecarSpec(agy, capture, { CLANKER_AGY_PID_FILE: pidFile, CLANKER_AGY_HELPER_PID_FILE: helperPidFile }),
    cwd: workspace,
    readOnly: true,
    onSpawn: ({ pid }) => { sidecarPid = pid; },
  });
  try {
    const turn = conn.session.prompt("long research");
    turn.catch(() => {});
    await waitUntil(() => fs.existsSync(pidFile), 15_000);
    agyPid = readPid(pidFile);
    helperPid = readPid(helperPidFile);
    await conn.cancel();
    // Well inside CANCEL_GRACE_MS's 5s in production terms, and the assertion
    // is "it settles at all": without the exit-path settle this never arrives.
    assert.equal(await stopReasonWithin(conn, turn, 15_000), "cancelled");
    await waitUntil(() => !alive(agyPid), 15_000);
    // The sidecar signalled agy, not a group: had it signalled one, it would
    // have signalled its own, and there would be no sidecar left to answer.
    assert.equal(alive(sidecarPid), true, "the sidecar must survive a cancel");
    assert.doesNotMatch(conn.stderr(), /ESRCH|EPERM|Uncaught|UnhandledPromiseRejection/);
  } finally {
    killIfAlive(agyPid, helperPid);
    conn.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(captureDir, { recursive: true, force: true });
  }
});

/**
 * The failure mode the exit-path settle introduces, and the guard against it.
 *
 * Settling a cancelled turn on `exit` means its `close` can now arrive AFTER
 * the next turn has started and claimed `session.active`. A `close` handler
 * that clears that slot unconditionally would strand the running turn's agy:
 * terminateChild reads `session.active`, so from that moment on nothing —
 * neither session/cancel nor the sidecar's own SIGTERM handler — can signal it.
 * That is a leak of exactly the kind this review exists to close, so the slot is
 * only ever cleared by the turn that filled it.
 */
test("a late `close` from a cancelled turn must not strand the turn that replaced it", { skip: !workspaceSandboxAvailable }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-relay-workspace-"));
  const { dir: captureDir, path: capture } = tmpCaptureFile("relay-args");
  const pidFile = path.join(captureDir, "pid");
  const helperPidFile = path.join(captureDir, "helper");
  // One script, two behaviours, keyed off the (appended) pid file:
  //  - turn 1 leaves a helper that outlives it by a couple of seconds and then
  //    exits ON ITS OWN. That exit is the moment turn 1's `close` is finally
  //    free to fire, and the test arranges for it to land mid-turn-2.
  //  - turn 2 must be endable ONLY by a signal — no self-exit, or the test goes
  //    green without anything having reached it, which is exactly the bug.
  // Turn 2 backgrounds its sleep and `wait`s on it rather than running it in the
  // foreground, purely so the pid is RECORDED: `trap '' TERM` is inherited, so
  // an unrecorded descendant survives both the group SIGTERM and (once the test
  // process is gone) the unref'd escalation behind it — measured as one stray
  // `sleep 45` reparented to launchd.
  const agy = fakeAgy([
    `trap '' TERM`,
    `if [ -s "$CLANKER_AGY_PID_FILE" ]; then`,
    `  sleep 45 &`,
    `  echo $! >> "$CLANKER_AGY_HELPER_PID_FILE"`,
    `  echo $$ >> "$CLANKER_AGY_PID_FILE"`,
    `  wait`,
    `else`,
    `  sleep 3 &`,
    `  echo $! >> "$CLANKER_AGY_HELPER_PID_FILE"`,
    `  echo $$ >> "$CLANKER_AGY_PID_FILE"`,
    `  wait`,
    `fi`,
  ].join("\n"));
  const conn = await LaneConnection.connect({
    spec: sidecarSpec(agy, capture, { CLANKER_AGY_PID_FILE: pidFile, CLANKER_AGY_HELPER_PID_FILE: helperPidFile }),
    cwd: workspace,
    readOnly: true,
  });
  let pids: number[] = [];
  try {
    const first = conn.session.prompt("first research");
    first.catch(() => {});
    await waitUntil(() => fs.existsSync(pidFile) && readPids(pidFile).length === 1, 15_000);
    const helperOne = readPids(helperPidFile)[0];
    pids = readPids(pidFile);
    await conn.cancel();
    assert.equal(await stopReasonWithin(conn, first, 15_000), "cancelled");

    const second = conn.session.prompt("second research");
    second.catch(() => {});
    await waitUntil(() => readPids(pidFile).length === 2, 15_000);
    pids = readPids(pidFile);
    // Turn 1's last pipe-holder is gone, so turn 1's `close` fires now — while
    // turn 2 is the live turn. Clear the slot unconditionally there and the
    // cancel below reaches nothing at all.
    await waitUntil(() => !alive(helperOne), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await conn.cancel();
    assert.equal(await stopReasonWithin(conn, second, 15_000), "cancelled");
    await waitUntil(() => !alive(pids[1]), 15_000);
  } finally {
    killIfAlive(...pids, ...(fs.existsSync(helperPidFile) ? readPids(helperPidFile) : []));
    conn.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(captureDir, { recursive: true, force: true });
  }
});

/**
 * The runtime facts both teardown fixes rest on, frozen.
 *
 * Neither is visible on the sidecar's own observable surface — PR #40's review
 * found the exitCode-only gate by probing Node directly, not by watching
 * Clanker — and both are load-bearing enough that a runtime change to either
 * should fail here, loudly, next to the code that assumes them, rather than
 * showing up as a wrong-group kill in production.
 *
 * COVERAGE BOUNDARY (honest): this exercises Node and the OS, not
 * gemini-acp.ts. The sidecar's gates cannot be unit-tested directly — the file
 * is a standalone executable that connects an ACP stream to stdio on import —
 * and after this same review removed `process.kill(-pid)` from the sidecar, the
 * signalCode half of the gate no longer has an end-to-end observable of its own
 * (`child.kill()` on a reaped child is a documented no-op). The gate is
 * defence-in-depth for the next call site; what proves the wrong-kill is gone
 * is the group-topology test above, not this one.
 */
test("a signal-killed child reads exitCode null + signalCode, and its `close` waits on a helper that outlives it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-signal-shape-"));
  const helperPidFile = path.join(dir, "helper");
  const script = path.join(dir, "child.sh");
  // `wait`, not a second `sleep`: the backgrounded helper must be the only
  // other process holding this child's stdout, or killing it proves nothing.
  fs.writeFileSync(script, `#!/bin/sh\nsleep 45 &\necho $! > "${helperPidFile}"\nwait\n`, { mode: 0o755 });
  const child = spawn(script, [], { stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  let atExit: { exitCode: number | null; signalCode: string | null } | undefined;
  child.stdout?.resume();
  child.stderr?.resume();
  child.once("exit", () => { atExit = { exitCode: child.exitCode, signalCode: child.signalCode }; });
  child.once("close", () => { closed = true; });
  let helperPid = 0;
  try {
    await waitUntil(() => fs.existsSync(helperPidFile), 15_000);
    helperPid = readPid(helperPidFile);
    child.kill("SIGKILL");
    await waitUntil(() => atExit !== undefined, 15_000);
    // 1. Node has reaped this child, and `exitCode` is still null: an
    //    `exitCode !== null` gate reads a dead child as running and signals it.
    assert.deepEqual(atExit, { exitCode: null, signalCode: "SIGKILL" });
    // 2. `close` has NOT fired — the helper still holds the pipes. This is the
    //    window in which the old code's delayed group SIGKILL fired at a pgid
    //    the OS was free to have recycled.
    assert.equal(closed, false, "`close` must still be pending while a helper holds the pipes");
    killIfAlive(helperPid);
    await waitUntil(() => closed, 15_000);
  } finally {
    killIfAlive(helperPid, child.pid ?? 0);
    fs.rmSync(dir, { recursive: true, force: true });
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
