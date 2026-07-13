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
 *   <other>  -> emit one agent_message_chunk equal to the prompt, then end_turn.
 *
 * Env vars (seat/resume tests, see test/seat.test.ts and test/acp-client.test.ts):
 *   CLANKER_TEST_NO_SESSION_NEW=1 -> this process instance refuses `session/new` (JSON-RPC
 *               error), so it can ONLY be reached via `session/resume`. A discriminating check:
 *               if acp-client.ts's resume path ever silently fell back to session/new instead
 *               of actually sending session/resume, a test process spawned in this mode would
 *               fail loudly (handshake error) rather than quietly succeeding via a fresh session.
 *   session/resume is always handled (regardless of the above): responds success for any
 *               request carrying a sessionId, echoing null modes/configOptions — the response
 *               intentionally omits `sessionId` (matching the real ACP schema; the caller
 *               already knows it) so a test can also verify the client doesn't depend on it
 *               being present.
 *   CLANKER_TEST_REJECT_RESUME=1 -> this process instance refuses EVERY `session/resume`
 *               (JSON-RPC error), regardless of the id — simulates a backend that can't honor
 *               a resume at all, so a test can prove the failure propagates as a real, reportable
 *               error instead of a silent fresh-session fallback.
 */
import fs from "node:fs";
import readline from "node:readline";

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

  if (p.includes("CRASH")) {
    // Emit one event then exit mid-turn without responding (simulated crash).
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-crash",
      title: "about to crash",
      status: "in_progress",
    });
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
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        agentInfo: { name: "fake-acp-agent" },
      });
      break;
    case "session/new": {
      if (process.env.CLANKER_TEST_NO_SESSION_NEW === "1") {
        respondError(msg.id, -32601, "session/new disabled for this test process (resume-only mode)");
        break;
      }
      cwd = msg.params?.cwd ?? cwd;
      const sessionId = `sess-${++sessionCounter}`;
      respond(msg.id, { sessionId });
      break;
    }
    case "session/resume": {
      const sessionId = msg.params?.sessionId;
      if (process.env.CLANKER_TEST_REJECT_RESUME === "1") {
        respondError(msg.id, -32603, `session/resume rejected (test mode) for '${sessionId}'`);
        break;
      }
      // Simulates an agent that rejects resuming a session it never knew
      // about (real ACP agents do this for expired/unknown ids) — any id
      // shaped like the ones this process itself mints via session/new.
      if (!sessionId || !/^sess-\d+$/.test(sessionId)) {
        respondError(msg.id, -32602, `session/resume: unknown session '${sessionId}'`);
        break;
      }
      cwd = msg.params?.cwd ?? cwd;
      // Response intentionally omits sessionId, matching schema.ResumeSessionResponse.
      respond(msg.id, { modes: null, configOptions: null });
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
