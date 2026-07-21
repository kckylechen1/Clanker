import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneConnection, resolveWithinRoot } from "../src/acp-client.js";
import { fakeSpec } from "./helpers.js";

test("handshake: connect completes initialize + session/new", async () => {
  const conn = await LaneConnection.connect({ spec: fakeSpec(), cwd: os.tmpdir(), readOnly: false });
  assert.match(conn.sessionId, /^sess-\d+$/);
  conn.close();
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

// ---- resolveWithinRoot (fs handler path-escape guard, P0 security) --------
//
// The ACP `fs/read_text_file` / `fs/write_text_file` handlers are served by
// direct fs.* calls in the MCP server process, not inside the lane
// subprocess's own sandbox. resolveWithinRoot is the fence that keeps a
// prompt-injected absolute path (or a symlink planted inside the worktree)
// from escaping the session's cwd/worktree root.

test("resolveWithinRoot: an in-root relative path resolves against root, not process.cwd()", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  const resolved = resolveWithinRoot(root, "sub/file.txt");
  assert.equal(resolved, path.join(root, "sub/file.txt"));
});

test("resolveWithinRoot: an in-root absolute path resolves as-is", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  const target = path.join(root, "notes.txt");
  fs.writeFileSync(target, "hi");
  assert.equal(resolveWithinRoot(root, target), target);
});

test("resolveWithinRoot: an absolute path outside root throws and never touches disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-outside-"));
  const evil = path.join(outsideDir, "evil.txt");
  assert.throws(() => resolveWithinRoot(root, evil), /escape session root/);
  assert.equal(fs.existsSync(evil), false);
});

test("resolveWithinRoot: a home-directory-shaped escape (~/.zshrc-style absolute path) throws", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  const home = os.homedir();
  // Don't actually touch the real dotfile — just prove the guard rejects any
  // absolute path outside root, home dir included, before a caller even gets
  // to fs.writeFileSync/readFileSync.
  assert.throws(() => resolveWithinRoot(root, path.join(home, ".zshrc")), /escape session root/);
});

test("resolveWithinRoot: '..' traversal collapses via path.resolve and is still rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  assert.throws(() => resolveWithinRoot(root, "../../../../etc/passwd"), /escape session root/);
});

test("resolveWithinRoot: a symlinked directory component inside root that points outside root is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-secret-"));
  fs.writeFileSync(path.join(secretDir, "passwd"), "root:x:0:0");
  const linkPath = path.join(root, "escape-link");
  fs.symlinkSync(secretDir, linkPath, "dir");
  assert.throws(() => resolveWithinRoot(root, path.join(root, "escape-link", "passwd")), /escape session root/);
});

test("resolveWithinRoot: a direct symlink file inside root pointing outside root is rejected (read-escape case)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-secret-"));
  const secretFile = path.join(secretDir, "id_rsa");
  fs.writeFileSync(secretFile, "-----BEGIN PRIVATE KEY-----");
  const linkFile = path.join(root, "innocuous.txt");
  fs.symlinkSync(secretFile, linkFile, "file");
  assert.throws(() => resolveWithinRoot(root, linkFile), /escape session root/);
});

test("resolveWithinRoot: root itself reached only via a symlinked ancestor still admits in-root paths (macOS /tmp case)", () => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-real-"));
  const parentLink = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-linkparent-"));
  const symlinkedRoot = path.join(parentLink, "root-via-link");
  fs.symlinkSync(realRoot, symlinkedRoot, "dir");
  // Root passed to resolveWithinRoot is the symlinked path (as os.tmpdir()
  // itself is on macOS, /tmp -> /private/tmp) — a legitimate in-root write
  // target must not be rejected as a false-positive escape.
  const resolved = resolveWithinRoot(symlinkedRoot, "ok.txt");
  assert.equal(resolved, path.join(symlinkedRoot, "ok.txt"));
});

test("resolveWithinRoot: a not-yet-existing nested write target under root is admitted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-"));
  const resolved = resolveWithinRoot(root, path.join(root, "newdir", "newfile.txt"));
  assert.equal(resolved, path.join(root, "newdir", "newfile.txt"));
});

// ---- end-to-end: the ACP fs handlers actually enforce the guard ----------
//
// Discriminating setup: the fake agent issues a real `fs/write_text_file` /
// `fs/read_text_file` JSON-RPC request to the client (this is the same code
// path a real, prompt-injected lane would exercise), and we assert on the
// *filesystem side effect* — not just the error text — so a bug that logs a
// rejection but writes anyway would still fail this test.

test("end-to-end: an out-of-root fs/write_text_file request is rejected and never reaches disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-e2e-root-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-e2e-outside-"));
  const evilPath = path.join(outsideDir, "evil.txt");

  const conn = await LaneConnection.connect({ spec: fakeSpec(), cwd: root, readOnly: false });
  conn.session.prompt(`FSWRITE ${evilPath}`).catch(() => {});
  let message = "";
  for (;;) {
    const msg = await conn.session.nextUpdate();
    if (msg.kind === "stop") break;
    if (msg.kind === "session_update" && msg.update.sessionUpdate === "agent_message_chunk" && msg.update.content.type === "text") {
      message += msg.update.content.text;
    }
  }
  conn.close();

  assert.match(message, /^FSWRITE_ERROR:/);
  assert.equal(fs.existsSync(evilPath), false);
});

test("end-to-end: an in-root fs/write_text_file request succeeds and is readable back via fs/read_text_file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-e2e-root-"));
  const innerPath = path.join(root, "notes.txt");

  const conn = await LaneConnection.connect({ spec: fakeSpec(), cwd: root, readOnly: false });
  conn.session.prompt(`FSWRITE ${innerPath}`).catch(() => {});
  let writeMessage = "";
  for (;;) {
    const msg = await conn.session.nextUpdate();
    if (msg.kind === "stop") break;
    if (msg.kind === "session_update" && msg.update.sessionUpdate === "agent_message_chunk" && msg.update.content.type === "text") {
      writeMessage += msg.update.content.text;
    }
  }
  assert.equal(writeMessage, "FSWRITE_OK");
  assert.equal(fs.existsSync(innerPath), true);

  conn.session.prompt(`FSREAD ${innerPath}`).catch(() => {});
  let readMessage = "";
  for (;;) {
    const msg = await conn.session.nextUpdate();
    if (msg.kind === "stop") break;
    if (msg.kind === "session_update" && msg.update.sessionUpdate === "agent_message_chunk" && msg.update.content.type === "text") {
      readMessage += msg.update.content.text;
    }
  }
  conn.close();

  assert.match(readMessage, /^FSREAD_OK:/);
});

test("end-to-end: an out-of-root fs/read_text_file request is rejected (no leak of a file outside root)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-e2e-root-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-e2e-outside-"));
  const secretPath = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(secretPath, "top-secret-content");

  const conn = await LaneConnection.connect({ spec: fakeSpec(), cwd: root, readOnly: false });
  conn.session.prompt(`FSREAD ${secretPath}`).catch(() => {});
  let message = "";
  for (;;) {
    const msg = await conn.session.nextUpdate();
    if (msg.kind === "stop") break;
    if (msg.kind === "session_update" && msg.update.sessionUpdate === "agent_message_chunk" && msg.update.content.type === "text") {
      message += msg.update.content.text;
    }
  }
  conn.close();

  assert.match(message, /^FSREAD_ERROR:/);
  assert.doesNotMatch(message, /top-secret-content/);
});
