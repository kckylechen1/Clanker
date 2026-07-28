#!/usr/bin/env node
/**
 * Scripted fake ACP agent for tests. Speaks newline-delimited JSON-RPC 2.0 on
 * stdin/stdout (the agent side), so the real @agentclientprotocol/sdk client in
 * src/acp-client.ts is exercised end-to-end against controlled behavior.
 *
 * Turn behavior is selected by the prompt text so tests can script scenarios:
 *   PLAN     -> emit a plan (completed/in_progress/pending) + a tool_call whose
 *               location is <cwd>/planned.txt, an agent message, then end_turn.
 *   SLOW     -> stream two message chunks with delays, then end_turn.
 *   STALL    -> emit one tool_call then never respond (simulated hang).
 *   STALL_ACTIVITY -> ignore cancel while emitting ordinary message chunks.
 *   CANCELME -> emit a tool_call then wait; respond `cancelled` on session/cancel.
 *   SCHEMA400 -> exit(1) immediately with zero tool_calls and stderr shaped like a
 *               turn-1 API-schema-rejection 400 (invalid_request_error, param:"tools")
 *               — simulates the 2026-07-13 incident class for CLANKER-INFRA-FAILURE
 *               classification tests. Never recovers, never retried.
 *   CAPACITY_ONCE <marker-file> -> first invocation (marker file absent) exits(1) with
 *               stderr shaped like a transient "model at capacity" backend error; every
 *               subsequent invocation (marker file present, written by the first) succeeds
 *               normally. Simulates a capacity-transient failure that a single automatic
 *               retry should recover from.
 *   CAPACITY_ALWAYS -> every invocation exits(1) with the same "model at capacity" stderr,
 *               never recovers. Simulates a backend that stays at capacity through the one
 *               automatic retry, so the retry budget (exactly one) must still be respected.
 *   TRICKLE  -> emit a trivial tool_call, delay, then a significant plan update,
 *               delay, then end_turn — for clanker_wait quiet-mode debounce tests
 *               (the tool_call must not cut a wait short; the plan update must).
 *   WRITEFILE <relpath> -> write a real (uncommitted) file at <cwd>/<relpath>,
 *               then end_turn — for server-side doNotTouch validation tests
 *               (the porcelain half of the diff must catch it).
 *   COMMITFILE <relpath> -> write AND `git add`+`git commit` the file, then
 *               end_turn — the committed half of the same validation.
 *   <other>  -> emit one agent_message_chunk equal to the prompt, then end_turn.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.env.CLANKER_TEST_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});
if (process.env.CLANKER_TEST_PID_FILE) fs.writeFileSync(process.env.CLANKER_TEST_PID_FILE, String(process.pid));
if (process.env.CLANKER_TEST_ATTEMPT_COUNTER) {
  const counter = process.env.CLANKER_TEST_ATTEMPT_COUNTER;
  const attempts = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(attempts + 1));
}
if (process.env.CLANKER_TEST_EXIT_MARKER) {
  process.on("SIGTERM", () => setTimeout(() => {
    fs.writeFileSync(process.env.CLANKER_TEST_EXIT_MARKER, String(process.pid));
    process.exit(0);
  }, 20));
}

const out = process.stdout;
function send(msg) {
  out.write(JSON.stringify(msg) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function update(sessionId, update) {
  notify("session/update", { sessionId, update });
}

let sessionCounter = 0;
let cwd = process.cwd();
/** pending prompt awaiting a cancel, keyed by sessionId */
const pendingCancel = new Map();
/** requests this agent sent to the client, awaiting a response, keyed by id */
const pendingAgentRequests = new Map();
let agentReqId = 1000;

function sendRequest(method, params, onResult) {
  const rid = ++agentReqId;
  pendingAgentRequests.set(rid, onResult);
  send({ jsonrpc: "2.0", id: rid, method, params });
}

function textBlock(text) {
  return { type: "text", text };
}

async function runPrompt(id, sessionId, promptText) {
  const p = promptText.toUpperCase();

  const writeMatch = promptText.match(/\b(WRITEFILE|COMMITFILE)\s+(\S+)/i);
  if (writeMatch) {
    // Write a REAL file into the session cwd (a worktree in the doNotTouch
    // tests) so the server's terminal validation diffs actual git state, not
    // an ACP signal. COMMITFILE also commits it, covering the committed half.
    const rel = writeMatch[2];
    const target = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `written by fake agent: ${rel}\n`);
    if (writeMatch[1].toUpperCase() === "COMMITFILE") {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      };
      execFileSync("git", ["add", rel], { cwd, env: gitEnv });
      execFileSync("git", ["commit", "-m", `fake agent writes ${rel}`], { cwd, env: gitEnv });
    }
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(`wrote ${rel}`) });
    respond(id, { stopReason: "end_turn" });
    return;
  }

  if (p.includes("TELEMETRY")) {
    update(sessionId, { sessionUpdate: "config_option_update", configOptions: [
      { id: "model", name: "Model", type: "select", category: "model", currentValue: "observed/model", options: [] },
      { id: "effort", name: "Effort", type: "select", category: "thought_level", currentValue: "high", options: [] },
    ] });
    update(sessionId, { sessionUpdate: "usage_update", used: 123, size: 4096, cost: { amount: 0.25, currency: "USD" } });
    respond(id, { stopReason: "end_turn", usage: {
      inputTokens: 10, outputTokens: 5, totalTokens: 15, thoughtTokens: 2,
      cachedReadTokens: 3, cachedWriteTokens: null, _meta: { secret: "must-not-persist" }, extra: "drop-me",
    } });
    return;
  }

  if (p.includes("STALL_ACTIVITY")) {
    update(sessionId, {
      sessionUpdate: "tool_call", toolCallId: "tc-stall-activity",
      title: "stalling with activity", status: "in_progress",
    });
    const timer = setInterval(() => {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock("still-working ") });
    }, 15);
    timer.unref();
    return;
  }

  if (p.includes("STALL")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-stall",
      title: "stalling tool",
      status: "in_progress",
    });
    // Never respond — simulates a hung turn.
    return;
  }

  if (p.includes("CANCELME")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-cancel",
      title: "long running op",
      status: "in_progress",
    });
    pendingCancel.set(sessionId, id);
    return;
  }

  if (p.includes("CRASH_SECRET")) {
    // Same as CRASH below, but the stderr text carries a secret-shaped value
    // so the redaction path (#37 B1 / issue #8) has something to strip.
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-crash-secret",
      title: "about to crash with a leaked secret",
      status: "in_progress",
    });
    process.stderr.write("auth failure: API_KEY=fake-not-a-real-credential-0000 rejected by upstream\n");
    setTimeout(() => process.exit(1), 30);
    return;
  }

  if (p.includes("CRASH")) {
    // Emit one event then exit mid-turn without responding (simulated crash).
    // The stderr line is evidence-carrying (#37 B1): a mid-turn crash used to
    // surface only "exited mid-turn (code=... signal=...)" with nothing
    // about WHY, even though acp-client.ts was already capturing this text.
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-crash",
      title: "about to crash",
      status: "in_progress",
    });
    process.stderr.write("simulated crash: worker unstable\n");
    setTimeout(() => process.exit(1), 30);
    return;
  }

  if (p.includes("SCHEMA400")) {
    // Zero tool_call events emitted, then a mid-turn crash whose stderr looks
    // like an API-level schema rejection — no update at all, straight to exit.
    process.stderr.write(
      '{"error":{"type":"invalid_request_error","message":"Invalid Value: \'tools\'. Function \'collaboration.spawn_agent\' is reserved for use by this model and must match the configured schema.","param":"tools"}}\n',
    );
    setTimeout(() => process.exit(1), 20);
    return;
  }

  if (p.includes("CAPACITY_ALWAYS")) {
    process.stderr.write('{"error":{"type":"overloaded_error","message":"model at capacity, please retry"}}\n');
    setTimeout(() => process.exit(1), 20);
    return;
  }

  if (p.includes("CAPACITY_ONCE")) {
    const m = promptText.match(/CAPACITY_ONCE\s+(\S+)/);
    const markerPath = m ? m[1] : null;
    if (markerPath && !fs.existsSync(markerPath)) {
      fs.writeFileSync(markerPath, "1");
      process.stderr.write('{"error":{"type":"overloaded_error","message":"model at capacity, please retry"}}\n');
      setTimeout(() => process.exit(1), 20);
      return;
    }
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock("capacity-retry-succeeded") });
    respond(id, { stopReason: "end_turn" });
    return;
  }

  if (p.includes("OVERFLOW")) {
    // Emit many tool_calls so the accumulated digest exceeds the char budget.
    for (let i = 0; i < 60; i++) {
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: `tc-of-${i}`,
        title: `overflow tool call number ${i} with a deliberately longish title`,
        status: "completed",
      });
    }
    respond(id, { stopReason: "end_turn" });
    return;
  }

  if (p.includes("PERMWRITE")) {
    // Ask the client for permission with ONLY an allow option; the client's
    // read-only gate must decline (cancelled) rather than approve.
    sendRequest(
      "session/request_permission",
      {
        sessionId,
        toolCall: { toolCallId: "w1", title: "write to a file", kind: "edit", status: "pending" },
        options: [{ optionId: "allow-1", name: "Allow", kind: "allow_once" }],
      },
      (result) => {
        const outcome = result && result.outcome && result.outcome.outcome;
        const text = outcome === "selected" ? "PERMISSION_GRANTED" : "PERMISSION_DENIED";
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(text) });
        respond(id, { stopReason: "end_turn" });
      },
    );
    return;
  }

  if (p.includes("READTOOL")) {
    // Emit a tool_call with kind "read" and a location — the same
    // "follow-along" signal a real Read/Grep tool produces. Used to prove a
    // read-only run's touched_files does NOT pick up read locations (only
    // write-class kinds may report a path as touched).
    const relMatch = promptText.match(/READTOOL\s+(\S+)/i);
    const rel = relMatch ? relMatch[1] : "src/looked-at.ts";
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-read",
      title: `read ${rel}`,
      kind: "read",
      status: "completed",
      locations: [{ path: `${cwd}/${rel}` }],
    });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(`read ${rel}`) });
    respond(id, { stopReason: "end_turn" });
    return;
  }

  if (p.includes("PLAN")) {
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "read the spec", priority: "high", status: "completed" },
        { content: "write the accessor", priority: "high", status: "in_progress" },
        { content: "migrate call sites", priority: "medium", status: "pending" },
      ],
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-edit",
      title: "edit planned.txt",
      kind: "edit",
      status: "completed",
      locations: [{ path: `${cwd}/planned.txt` }],
    });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock("planned") });
    respond(id, { stopReason: "end_turn" });
    return;
  }

  if (p.includes("TRICKLE")) {
    // Trivial event first (no wake expected in quiet mode), then — after a
    // real delay so a live wait is genuinely in-flight — a significant plan
    // update (wake expected), then end_turn.
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-trickle",
      title: "trivial op",
      status: "completed",
    });
    await delay(150);
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [{ content: "step one", priority: "high", status: "in_progress" }],
    });
    await delay(150);
    respond(id, { stopReason: "end_turn" });
    return;
  }

  if (p.includes("SLOW")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock("first-chunk-marker ") });
    await delay(120);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock("second-chunk-marker") });
    await delay(120);
    respond(id, { stopReason: "end_turn" });
    return;
  }

  // Default: echo the prompt as the final message.
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(promptText) });
  respond(id, { stopReason: "end_turn" });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Response to a request this agent sent (has id, no method).
  if (msg.id !== undefined && msg.method === undefined) {
    const cb = pendingAgentRequests.get(msg.id);
    if (cb) {
      pendingAgentRequests.delete(msg.id);
      cb(msg.result, msg.error);
    }
    return;
  }

  // Notifications (no id).
  if (msg.id === undefined) {
    if (msg.method === "session/cancel") {
      const sessionId = msg.params?.sessionId;
      const pendingId = pendingCancel.get(sessionId);
      if (pendingId !== undefined) {
        pendingCancel.delete(sessionId);
        respond(pendingId, { stopReason: "cancelled" });
      }
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-agent" },
      });
      break;
    case "session/new": {
      cwd = msg.params?.cwd ?? cwd;
      const sessionId = `sess-${++sessionCounter}`;
      const handshakeDelay = Number(process.env.CLANKER_TEST_HANDSHAKE_DELAY_MS ?? 0);
      if (handshakeDelay > 0) setTimeout(() => respond(msg.id, { sessionId }), handshakeDelay);
      else respond(msg.id, { sessionId });
      break;
    }
    case "session/prompt": {
      const sessionId = msg.params?.sessionId;
      const blocks = msg.params?.prompt ?? [];
      const promptText = blocks.map((b) => (b?.type === "text" ? b.text : "")).join("");
      void runPrompt(msg.id, sessionId, promptText);
      break;
    }
    default:
      // Unknown request: reply with an empty result to keep the stream alive.
      respond(msg.id, {});
      break;
  }
});
