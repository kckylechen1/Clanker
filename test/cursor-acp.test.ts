/**
 * The cursor lane, tested against the bytes `cursor-agent` really emits.
 *
 * Every fixture in this file is a transcription of a measured run against
 * cursor-agent 2026.07.23-e383d2b (2026-07-28), not an invented schema. Two
 * measurements are load-bearing enough that the projector is wrong without
 * them, so they are stated here once:
 *
 *  1. With `--stream-partial-output` the CLI emits one `assistant` event per
 *     fragment AND THEN a final `assistant` event repeating the whole message.
 *     run.ts concatenates every agent_message_chunk into `final_message`, so a
 *     projector that relays both halves hands back the answer twice.
 *  2. `--mode ask --force` is accepted by the CLI without complaint. Nothing
 *     downstream enforces the read/write exclusion; the sidecar's argv builder
 *     is the only place it exists.
 *
 * Each has a mutation at the bottom of this file: break it in a copy of the
 * sidecar and the corresponding assertion must go red, or the assertion is not
 * observing what it claims to.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LaneConnection } from "../src/acp-client.js";
import { buildSpawnSpec } from "../src/backends.js";
import { CURSOR_MODEL_ALIASES, DEFAULT_CURSOR_MODEL, resolveCursorModel, resolveOcModel } from "../src/constants.js";
import { LaneManager } from "../src/manager.js";
import { resolveNodeBinary } from "../src/node-binary.js";
import { getProfile, resolveProfileDispatch } from "../src/profiles.js";
import { dropMutant, materializeMutant, until } from "./helpers.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

/** The measured read-only transcript: thinking deltas, message deltas, the recap, the result line. */
const PARTIAL_STREAM = [
  `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"${SESSION}","model":"Composer 2.5","permissionMode":"default"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"count to 3"}]},"session_id":"${SESSION}"}`,
  `{"type":"thinking","subtype":"delta","text":"Counting to 3.","session_id":"${SESSION}","timestamp_ms":1}`,
  `{"type":"thinking","subtype":"completed","session_id":"${SESSION}","timestamp_ms":2}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"1"}]},"session_id":"${SESSION}","timestamp_ms":3}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":", "}]},"session_id":"${SESSION}","timestamp_ms":4}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"2, 3."}]},"session_id":"${SESSION}","timestamp_ms":5}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"1, 2, 3."}]},"session_id":"${SESSION}"}`,
  `{"type":"result","subtype":"success","duration_ms":7489,"duration_api_ms":7489,"is_error":false,"result":"1, 2, 3.","session_id":"${SESSION}","request_id":"req-1","usage":{"inputTokens":14795,"outputTokens":39,"cacheReadTokens":5248,"cacheWriteTokens":0}}`,
];

/** The measured shape WITHOUT --stream-partial-output: one whole-message event, then the result. */
const WHOLE_STREAM = [
  `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"${SESSION}","model":"Cursor Grok 4.5 High Fast","permissionMode":"default"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"1  \\n2  \\n3"}]},"session_id":"${SESSION}"}`,
  `{"type":"result","subtype":"success","duration_ms":7595,"is_error":false,"result":"1  \\n2  \\n3","session_id":"${SESSION}","request_id":"req-2","usage":{"inputTokens":13098,"outputTokens":84,"cacheReadTokens":5952,"cacheWriteTokens":0}}`,
];

/** The measured write transcript: an editToolCall pair around the message. */
const WRITE_STREAM = [
  `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"${SESSION}","model":"Composer 2.5","permissionMode":"default"}`,
  `{"type":"tool_call","subtype":"started","call_id":"tool_abc","tool_call":{"editToolCall":{"args":{"path":"/tmp/hello.txt","streamContent":"PONG"}},"toolCallId":"tool_abc"}}`,
  `{"type":"tool_call","subtype":"completed","call_id":"tool_abc","tool_call":{"editToolCall":{"args":{"path":"/tmp/hello.txt"},"result":{"success":{"path":"/tmp/hello.txt"}}},"toolCallId":"tool_abc"}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Created \`hello.txt\`."}]},"session_id":"${SESSION}"}`,
  `{"type":"result","subtype":"success","duration_ms":12400,"is_error":false,"result":"Created \`hello.txt\`.","session_id":"${SESSION}","request_id":"req-3","usage":{"inputTokens":11662,"outputTokens":149,"cacheReadTokens":23408,"cacheWriteTokens":0}}`,
];

/**
 * A stand-in `cursor-agent` that records its argv and then runs `body`.
 *
 * Same trick as test/gemini-acp.test.ts's fakeAgy: the sidecar spawns whatever
 * CLANKER_CURSOR_AGENT_PATH names, so a shell script is a complete substitute
 * for the CLI as far as this projection is concerned.
 */
function fakeCursor(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-fake-cursor-"));
  const executable = path.join(dir, "cursor-agent");
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CLANKER_CURSOR_CAPTURE"\n${body}\n`, { mode: 0o755 });
  return executable;
}

/** Emit the given stream-json lines verbatim, one per line. */
function emitLines(lines: string[]): string {
  return lines.map((line) => `cat <<'CLANKER_FIXTURE_EOF'\n${line}\nCLANKER_FIXTURE_EOF`).join("\n");
}

function tmpFile(prefix: string, name = "capture"): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clanker-cursor-${prefix}-`));
  return { dir, path: path.join(dir, name) };
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgidOf(pid: number): number {
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  assert.equal(out.status, 0, `ps failed for pid ${pid}: ${out.stderr}`);
  return Number.parseInt(out.stdout.trim(), 10);
}

function killIfAlive(...pids: number[]): void {
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* raced us */ }
  }
}

const SIDECAR = path.resolve("src/cursor-acp.ts");

function sidecarSpec(cursorAgent: string, capture: string, env: Record<string, string> = {}, sidecar = SIDECAR) {
  return {
    command: process.execPath,
    args: ["--import", path.resolve("node_modules/tsx/dist/esm/index.mjs"), sidecar],
    env: { CLANKER_CURSOR_AGENT_PATH: cursorAgent, CLANKER_CURSOR_CAPTURE: capture, ...env },
    warnings: [],
  };
}

interface TurnFacts {
  message: string;
  thoughts: string;
  toolCalls: { id: string; title: string; kind?: string }[];
  toolUpdates: string[];
  reportedModelAtHandshake?: string;
  observedModel?: string;
  cursorMeta: Record<string, unknown>[];
  usage?: { totalTokens: number; inputTokens: number; outputTokens: number; cachedReadTokens?: number | null };
  stopReason: string;
}

/** Drive one turn through the real ACP client and collect everything it projected. */
async function runTurn(spec: ReturnType<typeof sidecarSpec>): Promise<TurnFacts> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-workspace-"));
  const conn = await LaneConnection.connect({ spec, cwd, readOnly: true });
  const facts: TurnFacts = { message: "", thoughts: "", toolCalls: [], toolUpdates: [], cursorMeta: [], stopReason: "" };
  try {
    const turn = conn.session.prompt("count to 3");
    turn.catch(() => {});
    for (;;) {
      const event = await conn.session.nextUpdate();
      if (event.kind === "stop") break;
      const update = event.update as Record<string, any>;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": facts.message += update.content.text; break;
        case "agent_thought_chunk": facts.thoughts += update.content.text; break;
        case "tool_call": facts.toolCalls.push({ id: update.toolCallId, title: update.title, kind: update.kind }); break;
        case "tool_call_update": facts.toolUpdates.push(`${update.toolCallId}:${update.status ?? "none"}`); break;
        case "config_option_update":
          for (const option of update.configOptions ?? []) {
            if (option.category === "model") facts.observedModel = String(option.currentValue);
          }
          break;
        case "session_info_update": {
          const meta = (update._meta ?? {})["clanker.cursor"];
          if (meta) facts.cursorMeta.push(meta as Record<string, unknown>);
          break;
        }
      }
    }
    const response = await turn;
    facts.stopReason = response.stopReason;
    facts.usage = response.usage as TurnFacts["usage"];
    const handshake = (conn.session.newSessionResponse.configOptions ?? []).find((o) => o.category === "model");
    facts.reportedModelAtHandshake = handshake === undefined ? undefined : String(handshake.currentValue);
    return facts;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; sidecar stderr: ${conn.stderr()}`);
  } finally {
    conn.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---- 1. the spawn spec ------------------------------------------------------

test("cursor spec runs the sidecar, derives mode from the write gate, and pins the default model", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-spec-"));
  const read = buildSpawnSpec("cursor", { readOnly: true }, runDir);
  // #37: the sidecar's node is the recorded-and-still-existing one.
  assert.equal(read.command, resolveNodeBinary());
  assert.match(read.args[0], /cursor-acp\.m?js$/);
  assert.equal(read.env.CLANKER_CURSOR_MODE, "ask");
  assert.equal(read.env.CLANKER_CURSOR_MODEL, DEFAULT_CURSOR_MODEL);
  assert.ok(read.env.CLANKER_CURSOR_AGENT_PATH, "the resolved cursor-agent path must reach the sidecar");
  assert.equal(Object.keys(read.env).some((key) => /API_KEY/.test(key)), false);

  const write = buildSpawnSpec("cursor", { readOnly: false }, runDir);
  assert.equal(write.env.CLANKER_CURSOR_MODE, "write");
  // Unlike gemini, the cursor lane serves both modes — a write spec must build.
  assert.equal(write.env.CLANKER_CURSOR_MODEL, DEFAULT_CURSOR_MODEL);
});

test("cursor model aliases are lane-local, and full ids pass through untouched", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-alias-"));
  const modelFor = (model?: string) => buildSpawnSpec("cursor", { readOnly: true, model }, runDir).env.CLANKER_CURSOR_MODEL;
  assert.equal(modelFor("composer"), "composer-2.5");
  assert.equal(modelFor("grok"), "cursor-grok-4.5-high");
  assert.equal(modelFor("codex53"), "gpt-5.3-codex-high");
  // Pass-through: a full id must arrive byte-identical, or a caller can never
  // reach the ~200 models the alias table does not name.
  for (const id of ["gpt-5.2", "claude-opus-5-thinking-high", "gemini-3.6-flash-high"]) {
    assert.equal(modelFor(id), id, `full model id '${id}' must not be rewritten`);
  }
  // The namespaces are separate on purpose: `composer` means a different
  // provider's model on the opencode lane, and merging the maps would make one
  // of them silently wrong.
  assert.equal(resolveOcModel("composer"), "xai/grok-composer-2.5-fast");
  assert.equal(resolveCursorModel("composer"), "composer-2.5");
  assert.equal(resolveCursorModel("glm"), "glm", "the opencode GLM alias must not leak into this lane");
  assert.equal(CURSOR_MODEL_ALIASES.grok, "cursor-grok-4.5-high");
});

test("cursor forwards only an explicit print-timeout override, never a hardcoded default", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-timeout-"));
  const original = process.env.CLANKER_CURSOR_PRINT_TIMEOUT;
  try {
    delete process.env.CLANKER_CURSOR_PRINT_TIMEOUT;
    // The per-mode defaults must live solely in cursor-acp.ts (#13): shadowing
    // them here means the sidecar never sees the var unset and its own
    // defaults become dead code on the real dispatch path.
    assert.equal("CLANKER_CURSOR_PRINT_TIMEOUT" in buildSpawnSpec("cursor", { readOnly: true }, runDir).env, false);
    process.env.CLANKER_CURSOR_PRINT_TIMEOUT = "20m";
    assert.equal(buildSpawnSpec("cursor", { readOnly: true }, runDir).env.CLANKER_CURSOR_PRINT_TIMEOUT, "20m");
  } finally {
    if (original === undefined) delete process.env.CLANKER_CURSOR_PRINT_TIMEOUT;
    else process.env.CLANKER_CURSOR_PRINT_TIMEOUT = original;
  }
});

test("the CLANKER_CURSOR_MODE operator override can pick a read-only mode but can never cross the write gate", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-mode-"));
  const original = process.env.CLANKER_CURSOR_MODE;
  try {
    process.env.CLANKER_CURSOR_MODE = "plan";
    assert.equal(buildSpawnSpec("cursor", { readOnly: true }, runDir).env.CLANKER_CURSOR_MODE, "plan");
    assert.equal(buildSpawnSpec("cursor", { readOnly: false }, runDir).env.CLANKER_CURSOR_MODE, "write");
    // The dangerous direction: an operator env must NOT be able to turn a
    // read-only dispatch into a write-capable one.
    process.env.CLANKER_CURSOR_MODE = "write";
    assert.equal(buildSpawnSpec("cursor", { readOnly: true }, runDir).env.CLANKER_CURSOR_MODE, "ask");
    process.env.CLANKER_CURSOR_MODE = "nonsense";
    assert.equal(buildSpawnSpec("cursor", { readOnly: true }, runDir).env.CLANKER_CURSOR_MODE, "ask");
  } finally {
    if (original === undefined) delete process.env.CLANKER_CURSOR_MODE;
    else process.env.CLANKER_CURSOR_MODE = original;
  }
});

test("cursor warns on effort rather than inventing a flag for it", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-effort-"));
  const spec = buildSpawnSpec("cursor", { readOnly: true, effort: "high" }, runDir);
  assert.match(spec.warnings.join(" "), /does not support reasoning-effort/);
  assert.equal(Object.values(spec.env).includes("high"), false, "effort must not leak into the sidecar env");
});

// ---- 2. the profile registry ------------------------------------------------

test("cursor profiles weld the write gate and leave the model free with a default", () => {
  const review = getProfile("cursor-review");
  assert.equal(review.lane, "cursor");
  assert.equal(review.readOnly, true);
  assert.equal(review.isolation, "optional");
  assert.equal(review.model.kind, "caller-optional");
  assert.equal(review.turnTimeoutMs, 900_000);
  // The routing verdict travels with the profile, because the tool description
  // is where a dispatcher actually reads it.
  assert.match(review.description, /bounded single-layer-scaffolding/);
  assert.match(review.description, /#1368/);

  const write = getProfile("cursor-write");
  assert.equal(write.readOnly, false);
  assert.equal(write.isolation, "required");
  assert.equal(write.model.kind, "caller-optional");
  assert.match(write.description, /bounded single-layer-scaffolding/);

  // Omitting the model leaves it undefined here: backends.ts owns the default,
  // and a second source for it would drift.
  assert.equal(resolveProfileDispatch({ profile: "cursor-review", prompt: "review" }).model, undefined);
  assert.equal(
    resolveProfileDispatch({ profile: "cursor-write", prompt: "implement", worktree: "clanker/x", model: "grok" }).model,
    "grok",
    "an alias must reach the backend unexpanded — expansion belongs to one place",
  );
  // Welded dimensions stay unreachable.
  assert.throws(
    () => resolveProfileDispatch({ profile: "cursor-review", prompt: "r", sandbox: "danger-full-access" }),
    /takes no sandbox argument/,
  );
  assert.throws(
    () => resolveProfileDispatch({ profile: "cursor-write", prompt: "w" }),
    /requires a managed worktree branch name/,
  );
});

test("a cursor write may omit the model — the manager's pinned-default exemption is real, not just declared", async () => {
  let seen: Record<string, unknown> | undefined;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-write-repo-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  for (const args of [["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
  }
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo,
    resolveSpec: (_lane, opts, runDir) => {
      seen = opts as unknown as Record<string, unknown>;
      // The REAL spawn recipe for these options: the exemption is only correct
      // if the lane really pins a model when the caller named none.
      const spec = buildSpawnSpec("cursor", opts, runDir);
      assert.equal(spec.env.CLANKER_CURSOR_MODEL, DEFAULT_CURSOR_MODEL);
      assert.equal(spec.env.CLANKER_CURSOR_MODE, "write");
      return { command: process.execPath, args: [path.resolve("test/fake-acp-agent.mjs")], env: {}, warnings: [] };
    },
  });
  try {
    const { id } = await m.dispatchProfile({
      profile: "cursor-write",
      prompt: "implement",
      cwd: repo,
      worktree: `clanker/cursor-write-${process.pid}-${Date.now()}`,
    });
    assert.equal(seen?.model, undefined, "no model was named, and none was invented before the backend");
    // telemetry still names one, because the lane pinned it.
    assert.equal(m.status(id).telemetry?.resolved_model, DEFAULT_CURSOR_MODEL);
    await until(() => m.status(id).status !== "running");
  } finally {
    await m.shutdown();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- 3. argv: the read/write exclusion --------------------------------------

test("a read-only turn asks for cursor's read-only mode and sandbox, and never for --force", async () => {
  const { dir, path: capture } = tmpFile("args-read");
  try {
    await runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture, { CLANKER_CURSOR_MODEL: "composer-2.5" }));
    const argv = fs.readFileSync(capture, "utf8");
    assert.match(argv, /^--print$/m);
    assert.match(argv, /^--output-format\nstream-json$/m);
    assert.match(argv, /^--stream-partial-output$/m);
    assert.match(argv, /^--mode\nask$/m);
    assert.match(argv, /^--sandbox\nenabled$/m);
    assert.match(argv, /^--trust$/m);
    assert.match(argv, /^--model\ncomposer-2\.5$/m);
    // The exclusion. The CLI itself accepts `--mode ask --force` together, so
    // this argv is the only thing keeping a read-only turn read-only.
    assert.doesNotMatch(argv, /^--force$/m);
    assert.doesNotMatch(argv, /^--yolo$/m);
    // The role copy is prepended, so the positional prompt can never begin
    // with a dash and be re-read as a flag.
    assert.match(argv, /You are Clanker: Cursor, a read-only review and reconnaissance lane\./);
    assert.match(argv, /modify nothing in the workspace/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a write turn asks for --force --trust and never for a read-only mode", async () => {
  const { dir, path: capture } = tmpFile("args-write");
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(WRITE_STREAM)), capture, {
      CLANKER_CURSOR_MODE: "write",
      CLANKER_CURSOR_MODEL: "cursor-grok-4.5-high",
    }));
    const argv = fs.readFileSync(capture, "utf8");
    assert.match(argv, /^--force$/m);
    assert.match(argv, /^--trust$/m);
    assert.match(argv, /^--model\ncursor-grok-4\.5-high$/m);
    assert.doesNotMatch(argv, /^--mode$/m, "a write turn must not carry a read-only execution mode");
    assert.doesNotMatch(argv, /^--sandbox$/m);
    assert.match(argv, /You are Clanker: Cursor, a write-capable implementation lane/);
    assert.match(argv, /commit periodically/);
    // The measured editToolCall pair, projected onto ACP.
    assert.deepEqual(facts.toolCalls, [{ id: "tool_abc", title: "edit /tmp/hello.txt", kind: "edit" }]);
    assert.deepEqual(facts.toolUpdates, ["tool_abc:completed"]);
    assert.equal(facts.message, "Created `hello.txt`.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("`plan` is a read-only mode too, and carries the read-only flag set", async () => {
  const { dir, path: capture } = tmpFile("args-plan");
  try {
    await runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture, { CLANKER_CURSOR_MODE: "plan" }));
    const argv = fs.readFileSync(capture, "utf8");
    assert.match(argv, /^--mode\nplan$/m);
    assert.match(argv, /^--sandbox\nenabled$/m);
    assert.doesNotMatch(argv, /^--force$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 4. the projection ------------------------------------------------------

/**
 * The counterexample cold review (codex-8b2b3) killed the content-equality
 * dedupe with: a genuine delta whose text equals everything streamed so far.
 * `"a"`, `"a"`, `"b"` → result `"aab"`. Under content equality the second
 * delta was deleted as a recap and the result-line repair could not put it
 * back (`"aab"` is not prefixed by `"ab"`) — a real answer silently truncated.
 */
const REPEATED_DELTA_STREAM = [
  `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"${SESSION}","model":"Composer 2.5","permissionMode":"default"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"}]},"session_id":"${SESSION}","timestamp_ms":3}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"}]},"session_id":"${SESSION}","timestamp_ms":4}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"b"}]},"session_id":"${SESSION}","timestamp_ms":5}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"aab"}]},"session_id":"${SESSION}"}`,
  `{"type":"result","subtype":"success","duration_ms":10,"duration_api_ms":10,"is_error":false,"result":"aab","session_id":"${SESSION}","request_id":"req-r","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}`,
];

test("a repeated delta is NOT mistaken for the recap — the discriminator is structural, not content", async () => {
  const { dir, path: capture } = tmpFile("project-repeat");
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(REPEATED_DELTA_STREAM)), capture));
    assert.equal(facts.message, "aab", "every genuine delta survives; only the timestamp-less recap is dropped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a flag-shaped model is refused before it can reach argv as a flag", async () => {
  // cursor-review's argv IS its write boundary (the CLI takes `--mode ask
  // --force` silently), and unknown model ids pass through by design — so the
  // one place that can refuse a `--force`-shaped model is the argv builder.
  const { dir, path: capture } = tmpFile("model-flag");
  try {
    await assert.rejects(
      () => runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture, { CLANKER_CURSOR_MODEL: "--force" })),
      /starts with '-'|would reach cursor-agent as a flag/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed tool call carries ACP's failed status, so the poller can see it", async () => {
  const { dir, path: capture } = tmpFile("tool-failed");
  const stream = [
    `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"${SESSION}","model":"Composer 2.5","permissionMode":"default"}`,
    `{"type":"tool_call","subtype":"started","call_id":"tc-1","tool_call":{"readToolCall":{"args":{"path":"src/x.ts"}}},"session_id":"${SESSION}","timestamp_ms":1}`,
    `{"type":"tool_call","subtype":"failed","call_id":"tc-1","session_id":"${SESSION}","timestamp_ms":2}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"session_id":"${SESSION}"}`,
    `{"type":"result","subtype":"success","duration_ms":10,"duration_api_ms":10,"is_error":false,"result":"done","session_id":"${SESSION}","request_id":"req-f","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}`,
  ];
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(stream)), capture));
    assert.deepEqual(
      facts.toolUpdates,
      ["tc-1:failed"],
      `a failed tool call must reach ACP as status "failed", not statusless: ${JSON.stringify(facts.toolUpdates)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the partial-output recap is dropped, so the answer is delivered exactly once", async () => {
  const { dir, path: capture } = tmpFile("project-partial");
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture));
    // Not "1, 2, 3.1, 2, 3." — the deltas plus cursor's whole-message recap.
    assert.equal(facts.message, "1, 2, 3.");
    assert.equal(facts.stopReason, "end_turn");
    // The reasoning stream is relayed as thoughts (disk-only downstream), never
    // folded into the message.
    assert.equal(facts.thoughts, "Counting to 3.");
    assert.equal(facts.message.includes("Counting"), false);
    // Usage off the result line, mapped onto ACP's names. totalTokens is the
    // sum of the two counters cursor sends; the cache counters ride alongside
    // rather than being added into it.
    assert.deepEqual(facts.usage, {
      totalTokens: 14834,
      inputTokens: 14795,
      outputTokens: 39,
      cachedReadTokens: 5248,
      cachedWriteTokens: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stream with no deltas still delivers its message once", async () => {
  const { dir, path: capture } = tmpFile("project-whole");
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(WHOLE_STREAM)), capture));
    assert.equal(facts.message, "1  \n2  \n3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a result line with no assistant event at all is still the turn's message", async () => {
  const { dir, path: capture } = tmpFile("project-result-only");
  try {
    const stream = [
      `{"type":"system","subtype":"init","session_id":"${SESSION}","model":"Composer 2.5"}`,
      `{"type":"result","subtype":"success","is_error":false,"result":"only on the result line","session_id":"${SESSION}"}`,
    ];
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(stream)), capture));
    assert.equal(facts.message, "only on the result line");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a result that extends what was streamed contributes only its tail", async () => {
  const { dir, path: capture } = tmpFile("project-tail");
  try {
    const stream = [
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"half"}]},"session_id":"${SESSION}","timestamp_ms":1}`,
      `{"type":"result","subtype":"success","is_error":false,"result":"half and the rest","session_id":"${SESSION}"}`,
    ];
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(stream)), capture));
    assert.equal(facts.message, "half and the rest");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the model is reported at the handshake from argv, then corrected to what cursor itself says it ran", async () => {
  const { dir, path: capture } = tmpFile("observed-model");
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture, {
      CLANKER_CURSOR_MODEL: "composer-2.5",
    }));
    // Before the child exists, argv is the only knowable answer…
    assert.equal(facts.reportedModelAtHandshake, "composer-2.5");
    // …and once cursor states what it is running, THAT is observed_model. It is
    // the vendor's display name, deliberately not normalized into the id: a
    // fabricated agreement would defeat the field's whole purpose.
    assert.equal(facts.observedModel, "Composer 2.5");
    // A different family is exactly what a silent swap would look like.
    const swapped = await runTurn(sidecarSpec(fakeCursor(emitLines(WHOLE_STREAM)), capture, {
      CLANKER_CURSOR_MODEL: "composer-2.5",
    }));
    assert.equal(swapped.reportedModelAtHandshake, "composer-2.5");
    assert.equal(swapped.observedModel, "Cursor Grok 4.5 High Fast");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor's own chat id reaches the run's event log, for the resume unit that will need it", async () => {
  const { dir, path: capture } = tmpFile("chat-id");
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture));
    assert.equal(facts.cursorMeta[0]?.chat_id, SESSION);
    assert.equal(facts.cursorMeta[0]?.reported_model, "Composer 2.5");
    assert.equal(facts.cursorMeta.at(-1)?.request_id, "req-1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 5. failure classification ---------------------------------------------

test("cursor failures are reported by kind: crash, error result, missing result, empty output", async () => {
  const cases: [string, string, RegExp][] = [
    ["crash", "echo boom >&2; exit 7", /exit 7.*boom/],
    [
      "error-result",
      emitLines([`{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model refused"}`]),
      /reported a failed turn \(subtype error_during_execution\): model refused/,
    ],
    ["no-result", emitLines([`{"type":"system","subtype":"init","model":"Composer 2.5"}`]), /produced no result line/],
    [
      "empty",
      emitLines([`{"type":"result","subtype":"success","is_error":false,"result":""}`]),
      /returned empty output/,
    ],
    ["garbage", "echo 'not json at all'; exit 0", /produced no result line.*not json at all/s],
  ];
  for (const [name, body, expected] of cases) {
    const { dir, path: capture } = tmpFile(`fail-${name}`);
    try {
      await assert.rejects(runTurn(sidecarSpec(fakeCursor(body), capture)), expected, `case '${name}'`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a print-timeout is classified as a duration ceiling, not as a backend crash", async () => {
  const { dir, path: capture } = tmpFile("timeout");
  try {
    const spec = sidecarSpec(fakeCursor("sleep 30"), capture, { CLANKER_CURSOR_PRINT_TIMEOUT: "300ms" });
    await assert.rejects(runTurn(spec), /hit the print-timeout \(limit 300ms/);
    await assert.rejects(
      runTurn(spec),
      (error: Error) => !/cursor-agent failed \(/.test(error.message),
      "a ceiling hit must not read as a crash — that mis-diagnosis is #13's original sin",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparseable print-timeout fails the turn loudly instead of reverting to a default", async () => {
  const { dir, path: capture } = tmpFile("timeout-bad");
  try {
    await assert.rejects(
      runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture, { CLANKER_CURSOR_PRINT_TIMEOUT: "ten minutes" })),
      /could not parse CLANKER_CURSOR_PRINT_TIMEOUT='ten minutes'/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 6. process governance --------------------------------------------------

test("cancelling a cursor turn kills cursor-agent, settles as cancelled, and leaves the sidecar alive", async () => {
  const { dir, path: capture } = tmpFile("cancel");
  const pidFile = path.join(dir, "pid");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-cancel-ws-"));
  // SIGTERM ignored: the child dies on the sidecar's 1s SIGKILL escalation,
  // i.e. by SIGNAL (exitCode null, signalCode set) — the exact shape PR #40's
  // review caught an exitCode-only gate mishandling. The backgrounded helper
  // holds the stdout pipe open, so `close` stays pending and `cancelled` can
  // only arrive if the turn settles on `exit`.
  const agent = fakeCursor([
    `trap '' TERM`,
    `sleep 45 &`,
    `echo $! > "$CLANKER_CURSOR_HELPER_PID"`,
    `echo $$ > "$CLANKER_CURSOR_PID"`,
    `wait`,
  ].join("\n"));
  let sidecarPid = 0;
  let childPid = 0;
  let helperPid = 0;
  const conn = await LaneConnection.connect({
    spec: sidecarSpec(agent, capture, { CLANKER_CURSOR_PID: pidFile, CLANKER_CURSOR_HELPER_PID: path.join(dir, "helper") }),
    cwd,
    readOnly: true,
    onSpawn: ({ pid }) => { sidecarPid = pid; },
  });
  try {
    const turn = conn.session.prompt("long review");
    turn.catch(() => {});
    await until(() => fs.existsSync(pidFile));
    childPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    helperPid = Number.parseInt(fs.readFileSync(path.join(dir, "helper"), "utf8").trim(), 10);
    // The structural claim: cursor-agent runs in the SIDECAR's process group,
    // so the manager's one group kill covers it even if the sidecar dies first.
    assert.equal(pgidOf(childPid), sidecarPid, "cursor-agent must share the sidecar's process group");
    assert.equal(pgidOf(helperPid), sidecarPid, "its helpers must inherit that group too");
    await conn.cancel();
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
    }
    assert.equal((await turn).stopReason, "cancelled");
    await until(() => !alive(childPid));
    assert.equal(alive(sidecarPid), true, "the sidecar must survive a cancel — it signals a pid, never its own group");
    assert.doesNotMatch(conn.stderr(), /ESRCH|EPERM|Uncaught|UnhandledPromiseRejection/);
  } finally {
    killIfAlive(childPid, helperPid);
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ---- 7. mutation self-checks ------------------------------------------------
// Each mutation breaks exactly one measured fact. If the assertion above it
// stays green against the broken build, it was never observing that fact.

test("mutation: content-equality dedupe silently truncates a repeated delta", async () => {
  // The exact form cold review killed. Kept as a resident mutant so the
  // structural rule cannot quietly regress into the content one.
  const root = materializeMutant("cursor-recap-by-content", [{
    file: "cursor-acp.ts",
    find: "    if (isRecap && this.streamed !== \"\") return;",
    replace: "    if (this.streamed !== \"\" && text === this.streamed) return;",
  }]);
  const { dir, path: capture } = tmpFile("mutant-repeat");
  try {
    const facts = await runTurn(
      sidecarSpec(fakeCursor(emitLines(REPEATED_DELTA_STREAM)), capture, {}, path.join(root, "src", "cursor-acp.ts")),
    );
    // Measured, not predicted: the content rule is worse than "truncating".
    // It eats the repeated delta (streamed becomes "ab"), and then the recap
    // "aab" no longer equals what was streamed so it gets relayed too —
    // the caller receives "abaab": a dropped fragment AND a doubled tail.
    assert.equal(facts.message, "abaab", "the mutant must mangle the stream — otherwise the structural rule is untested");
    assert.notEqual(facts.message, "aab");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    dropMutant("cursor-recap-by-content");
  }
});

test("mutation: without the recap rule the answer is delivered twice", async () => {
  const root = materializeMutant("cursor-recap-not-dropped", [{
    file: "cursor-acp.ts",
    // Anchor moved with the fix (codex-8b2b3): the rule is now structural
    // (timestamp-less == recap), so the mutant drops THAT guard.
    find: "    if (isRecap && this.streamed !== \"\") return;",
    replace: "    // mutant: relay the recap too",
  }]);
  const { dir, path: capture } = tmpFile("mutant-recap");
  try {
    const facts = await runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture, {}, path.join(root, "src", "cursor-acp.ts")));
    assert.equal(facts.message, "1, 2, 3.1, 2, 3.", "the mutant must double the answer — otherwise the rule is untested");
    assert.notEqual(facts.message, "1, 2, 3.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    dropMutant("cursor-recap-not-dropped");
  }
});

test("mutation: a read-only turn that also carries --force is caught by the argv assertion", async () => {
  const root = materializeMutant("cursor-mode-not-exclusive", [{
    file: "cursor-acp.ts",
    find: "    args.push(\"--mode\", mode, \"--sandbox\", \"enabled\", \"--trust\");",
    replace: "    args.push(\"--mode\", mode, \"--sandbox\", \"enabled\", \"--trust\", \"--force\");",
  }]);
  const { dir, path: capture } = tmpFile("mutant-mode");
  try {
    await runTurn(sidecarSpec(fakeCursor(emitLines(PARTIAL_STREAM)), capture, {}, path.join(root, "src", "cursor-acp.ts")));
    const argv = fs.readFileSync(capture, "utf8");
    // The CLI would have accepted this silently; only our own assertion can see it.
    assert.match(argv, /^--force$/m, "the mutant must actually add --force, or it proves nothing");
    assert.throws(() => assert.doesNotMatch(argv, /^--force$/m));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    dropMutant("cursor-mode-not-exclusive");
  }
});

test("mutation: dropping alias resolution sends the shortname to cursor-agent verbatim", async () => {
  const root = materializeMutant("cursor-alias-not-resolved", [{
    file: "backends.ts",
    find: "      env.CLANKER_CURSOR_MODEL = resolveCursorModel(opts.model) || DEFAULT_CURSOR_MODEL;",
    replace: "      env.CLANKER_CURSOR_MODEL = opts.model || DEFAULT_CURSOR_MODEL;",
  }]);
  // resolveCursorAcpEntry looks for the sidecar bundle NEXT TO the module it
  // runs from, and the mutant tree is only `src/`. Give it the committed
  // artifact so the mutation is exercised, not the missing-bundle guard.
  fs.mkdirSync(path.join(root, "plugin", "dist"), { recursive: true });
  fs.copyFileSync(path.resolve("plugin/dist/cursor-acp.mjs"), path.join(root, "plugin", "dist", "cursor-acp.mjs"));
  const { buildSpawnSpec: mutated } = (await import(
    pathToFileURL(path.join(root, "src", "backends.ts")).href
  )) as typeof import("../src/backends.js");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-cursor-mutant-alias-"));
  try {
    // `grok` is not a model id cursor serves — the CLI would refuse the turn
    // with "Cannot use this model". The alias table is what keeps that from
    // happening, and this proves the assertion above observes it.
    assert.equal(mutated("cursor", { readOnly: true, model: "grok" }, runDir).env.CLANKER_CURSOR_MODEL, "grok");
    assert.equal(buildSpawnSpec("cursor", { readOnly: true, model: "grok" }, runDir).env.CLANKER_CURSOR_MODEL, "cursor-grok-4.5-high");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    dropMutant("cursor-alias-not-resolved");
  }
});
