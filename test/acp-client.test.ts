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
import { fakeSpec } from "./helpers.js";

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

// ---- session/resume (seat respawn) ---------------------------------------
//
// Discriminating setup: the SECOND connection is spawned against a fresh
// fake-agent process running with CLANKER_TEST_NO_SESSION_NEW=1, so it can
// ONLY succeed by actually sending `session/resume` — if LaneConnection's
// resume path ever silently fell back to `session/new` (a fresh session
// under a bug, defeating the whole point of resuming), this process would
// reject the handshake instead of quietly succeeding.

test("resumeSessionId reconnects via session/resume, not session/new, across a fresh process", async () => {
  const first = await LaneConnection.connect({ spec: fakeSpec(), cwd: os.tmpdir(), readOnly: false });
  const originalSessionId = first.sessionId;
  first.close();

  const second = await LaneConnection.connect({
    spec: fakeSpec({ CLANKER_TEST_NO_SESSION_NEW: "1" }),
    cwd: os.tmpdir(),
    readOnly: false,
    resumeSessionId: originalSessionId,
  });
  try {
    // Same session id: attachSession() carries the id we already had, since
    // ResumeSessionResponse never mints a new one.
    assert.equal(second.sessionId, originalSessionId);

    // And the resumed session is actually usable for a further turn.
    second.session.prompt("after-resume").catch(() => {});
    let message = "";
    for (;;) {
      const msg = await second.session.nextUpdate();
      if (msg.kind === "stop") break;
      if (msg.kind === "session_update" && msg.update.sessionUpdate === "agent_message_chunk" && msg.update.content.type === "text") {
        message += msg.update.content.text;
      }
    }
    assert.equal(message, "after-resume");
  } finally {
    second.close();
  }
});

test("resumeSessionId surfaces the agent's session/resume error instead of hanging or silently retrying", async () => {
  await assert.rejects(
    LaneConnection.connect({
      spec: fakeSpec({ CLANKER_TEST_NO_SESSION_NEW: "1" }),
      cwd: os.tmpdir(),
      readOnly: false,
      resumeSessionId: "not-a-real-session", // fake agent rejects any id it didn't itself mint
    }),
  );
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
