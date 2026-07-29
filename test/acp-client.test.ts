import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  LaneConnection,
  resolveContainedReadPath,
  resolveContainedWritePath,
  writeContainedTextFile,
} from "../src/acp-client.js";
import { dropMutant, fakeSpec, loadMutantModule, until } from "./helpers.js";

type AcpClientModule = typeof import("../src/acp-client.js");

/** Is this pid still signalable? (`kill(pid, 0)` — no signal delivered.) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Connect a fake agent that has grown a grandchild of its own, and hand back
 * both the connection and the grandchild's pid once it is published.
 */
async function connectWithGrandchild(
  connect: AcpClientModule["LaneConnection"]["connect"],
): Promise<{ conn: LaneConnection; grandchildPid: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grandchild-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const conn = await connect({
    spec: fakeSpec({ CLANKER_TEST_GRANDCHILD_PID_FILE: pidFile }),
    cwd: os.tmpdir(),
    readOnly: true,
    terminateGraceMs: 50,
  });
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0);
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(grandchildPid > 0, "fake agent must publish its grandchild's pid");
  assert.ok(alive(grandchildPid), "the grandchild must be running before the kill under test");
  return { conn, grandchildPid };
}

/**
 * #32: a worker is spawned `detached` (its own process group) and every kill
 * path signals `-pid`, so the grandchildren a real lane grows — codex-acp's
 * `codex app-server` above all — die with it instead of surviving as orphans
 * that still hold the worktree. The mutant below proves this assertion is
 * really observing the group kill and not just the worker's own exit.
 */
test("close kills the worker's whole process group, grandchildren included", async () => {
  const { conn, grandchildPid } = await connectWithGrandchild(LaneConnection.connect);
  try {
    conn.close();
    await conn.exited;
    await until(() => !alive(grandchildPid), 4000);
  } finally {
    if (alive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
  }
});

test("mutant: a single-pid kill leaves the grandchild alive (proves the test above)", async () => {
  const name = "acp-single-pid-kill";
  const mutated = await loadMutantModule<AcpClientModule>(
    name,
    [
      {
        // Drop the group kill; every call site then falls through to the
        // single-pid `child.kill()` exactly as the code did before #32.
        file: "acp-client.ts",
        find: "      process.kill(-child.pid, signal);\n      return;",
        replace: "      /* mutant: no group kill */",
      },
    ],
    "acp-client.ts",
  );
  const { conn, grandchildPid } = await connectWithGrandchild(mutated.LaneConnection.connect);
  try {
    conn.close();
    await conn.exited;
    // Give the mutant the same window the real path is allowed above.
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(
      alive(grandchildPid),
      "without the group kill the grandchild survives — so the previous test observes the group kill, not the worker's exit",
    );
  } finally {
    if (alive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    dropMutant(name);
  }
});

test("handshake: connect completes initialize + session/new", async () => {
  const conn = await LaneConnection.connect({ spec: fakeSpec(), cwd: os.tmpdir(), readOnly: false });
  assert.match(conn.sessionId, /^sess-\d+$/);
  conn.close();
});

test("close escalates SIGTERM to SIGKILL based on actual exit", async () => {
  const conn = await LaneConnection.connect({
    spec: fakeSpec({ CLANKER_TEST_IGNORE_SIGTERM: "1" }), cwd: os.tmpdir(), readOnly: true, terminateGraceMs: 30,
  });
  conn.close();
  const exit = await conn.exited;
  assert.equal(exit.signal, "SIGKILL");
});

test("ACP filesystem paths are canonical and confined to cwd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-fs-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-fs-out-"));
  fs.writeFileSync(path.join(root, "ok.txt"), "ok");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "read-link"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "write-link"));
  fs.symlinkSync(outside, path.join(root, "parent-link"));
  const canonicalRoot = fs.realpathSync(root);
  assert.equal(resolveContainedReadPath(root, "ok.txt"), path.join(canonicalRoot, "ok.txt"));
  assert.equal(resolveContainedReadPath(root, path.join(root, "ok.txt")), path.join(canonicalRoot, "ok.txt"));
  assert.equal(resolveContainedWritePath(root, "new.txt"), path.join(canonicalRoot, "new.txt"));
  assert.throws(() => resolveContainedReadPath(root, "../x"), /boundary rejection/);
  assert.throws(() => resolveContainedReadPath(root, path.join(outside, "secret.txt")), /boundary rejection/);
  assert.throws(() => resolveContainedReadPath(root, "read-link"), /boundary rejection/);
  assert.throws(() => resolveContainedWritePath(root, "write-link"), /boundary rejection/);
  assert.throws(() => resolveContainedWritePath(root, "parent-link/new.txt"), /boundary rejection/);
});

test("ACP write rejects a cwd-local hardlink without changing the outside inode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-hardlink-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-hardlink-outside-"));
  const outsideFile = path.join(outside, "outside.txt");
  const localLink = path.join(root, "local-hardlink.txt");
  fs.writeFileSync(outsideFile, "original outside content");
  fs.linkSync(outsideFile, localLink);
  try {
    const target = resolveContainedWritePath(root, localLink);
    assert.throws(
      () => writeContainedTextFile(target, localLink, "outside-must-not-change"),
      /filesystem boundary rejection.*hardlinks/i,
    );
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "original outside content");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("prompt turn completes and yields the agent message as final text", async () => {
  const conn = await LaneConnection.connect({ spec: fakeSpec(), cwd: os.tmpdir(), readOnly: false });
  const promptPromise = conn.session.prompt("DONE");
  promptPromise.catch(() => {});

  let message = "";
  let stopReason = "";
  for (;;) {
    const msg = await conn.session.nextUpdate();
    if (msg.kind === "stop") {
      stopReason = msg.stopReason;
      break;
    }
    if (msg.update.sessionUpdate === "agent_message_chunk" && msg.update.content.type === "text") {
      message += msg.update.content.text;
    }
  }
  assert.equal(stopReason, "end_turn");
  assert.equal(message, "DONE");
  conn.close();
});

test("two sequential prompts reuse the same session", async () => {
  const conn = await LaneConnection.connect({ spec: fakeSpec(), cwd: os.tmpdir(), readOnly: false });
  const firstSession = conn.sessionId;

  for (const text of ["first-turn", "second-turn"]) {
    conn.session.prompt(text).catch(() => {});
    for (;;) {
      const msg = await conn.session.nextUpdate();
      if (msg.kind === "stop") break;
    }
  }
  // Same connection/session id across both turns.
  assert.equal(conn.sessionId, firstSession);
  conn.close();
});
