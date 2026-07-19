import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { choosePermissionOption } from "../src/acp-client.js";
import { DIGEST_CHAR_BUDGET, resolveOcModel } from "../src/constants.js";
import { buildSpawnSpec } from "../src/backends.js";
import { LaneRun } from "../src/run.js";

// ---- CP3: opencode model shortname single source ------------------------

test("CP3: resolveOcModel expands shortnames and passes full ids through", () => {
  assert.equal(resolveOcModel("glm"), "zhipuai-coding-plan/glm-5.2");
  assert.equal(resolveOcModel("ds"), "deepseek/deepseek-v4-pro");
  assert.equal(resolveOcModel("kimi"), "kimi-for-coding/k2p7");
  assert.equal(resolveOcModel("free"), "opencode/deepseek-v4-flash-free");
  assert.equal(resolveOcModel("anthropic/claude"), "anthropic/claude");
  assert.equal(resolveOcModel("unknown"), "unknown");
  assert.equal(resolveOcModel(undefined), undefined);
});

test("CP3: opencode lane pins the resolved model and dedicated worker in inline config", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-"));
  const spec = buildSpawnSpec("opencode", { model: "glm" }, runDir);
  assert.ok(spec.env.OPENCODE_CONFIG, "OPENCODE_CONFIG env is set");
  assert.ok(spec.env.OPENCODE_CONFIG_CONTENT, "highest-precedence inline config is set");
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.model, "zhipuai-coding-plan/glm-5.2");
  assert.equal(cfg.default_agent, "clanker-worker");
  assert.equal(cfg.agent?.["clanker-worker"]?.mode, "primary");
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.task, "deny");
  assert.deepEqual(cfg, JSON.parse(fs.readFileSync(spec.env.OPENCODE_CONFIG, "utf8")));
});

test("opencode read-only lane denies delegation, skills, external paths, edits, and shell", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-default-"));
  const spec = buildSpawnSpec("opencode", { readOnly: true }, runDir);
  assert.ok(spec.env.OPENCODE_CONFIG, "OPENCODE_CONFIG env is set without a model override");
  assert.equal(spec.env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(spec.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(Object.hasOwn(cfg, "model"), false, "the user's normal model resolution remains intact");
  assert.equal(cfg.default_agent, "clanker-worker");
  assert.equal(cfg.agent?.["clanker-worker"]?.mode, "primary");
  assert.deepEqual(cfg.agent?.["clanker-worker"]?.permission, {
    // The MCP namespace: OpenCode flattens injected MCP tools to
    // `${server}_${tool}`, so this glob — not `task`/`skill`, which only match
    // the native tools of those names — is what stops a lane from reaching
    // `tachi_task`/`tachi_skill`. Observed live before this was added.
    "*_*": "deny",
    task: "deny",
    skill: "deny",
    external_directory: "deny",
    edit: "deny",
    bash: "deny",
  });
});

test("opencode write lane keeps worktree-local edit and shell enabled", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-write-"));
  const spec = buildSpawnSpec("opencode", { readOnly: false }, runDir);
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.edit, "allow");
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.bash, "allow");
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.external_directory, "deny");
});

// ---- codex sandbox override (review-seat workspace-write tier) ----------
//
// Verified against codex-acp 1.1.2 source (src/AgentMode.ts): INITIAL_AGENT_MODE
// accepts three ids ("read-only" | "agent" | "agent-full-access"), not the two
// this lane previously exposed. `sandbox` maps codex-acp's own sandboxMode
// vocabulary ("read-only" | "workspace-write" | "danger-full-access") onto
// those ids and takes precedence over the readOnly-derived legacy default.

test("codex sandbox='workspace-write' maps to INITIAL_AGENT_MODE=agent (the review-seat middle tier)", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  const spec = buildSpawnSpec("codex", { readOnly: true, sandbox: "workspace-write" }, runDir);
  assert.equal(spec.env.INITIAL_AGENT_MODE, "agent");
  assert.deepEqual(spec.warnings, []);
});

test("codex sandbox='read-only' and 'danger-full-access' map to the matching INITIAL_AGENT_MODE ids", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  assert.equal(buildSpawnSpec("codex", { sandbox: "read-only" }, runDir).env.INITIAL_AGENT_MODE, "read-only");
  assert.equal(
    buildSpawnSpec("codex", { sandbox: "danger-full-access" }, runDir).env.INITIAL_AGENT_MODE,
    "agent-full-access",
  );
});

test("codex with no sandbox override preserves legacy readOnly-derived behavior", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  assert.equal(buildSpawnSpec("codex", { readOnly: true }, runDir).env.INITIAL_AGENT_MODE, "read-only");
  assert.equal(buildSpawnSpec("codex", { readOnly: false }, runDir).env.INITIAL_AGENT_MODE, "agent-full-access");
});

test("codex sandbox override takes precedence over readOnly when both are set", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  // readOnly: true would legacy-derive "read-only", but sandbox explicitly asks for the middle tier.
  const spec = buildSpawnSpec("codex", { readOnly: true, sandbox: "workspace-write" }, runDir);
  assert.equal(spec.env.INITIAL_AGENT_MODE, "agent");
});

test("grok/opencode warn and ignore a sandbox override (no native sandbox tier)", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  const grokSpec = buildSpawnSpec("grok", { sandbox: "workspace-write" }, runDir);
  assert.ok(grokSpec.warnings.some((w) => /sandbox/.test(w)), `expected a sandbox warning, got ${JSON.stringify(grokSpec.warnings)}`);
  const ocSpec = buildSpawnSpec("opencode", { sandbox: "workspace-write" }, runDir);
  assert.ok(ocSpec.warnings.some((w) => /sandbox/.test(w)), `expected a sandbox warning, got ${JSON.stringify(ocSpec.warnings)}`);
});

// NOTE (rebase merge resolution, 2026-07-18): the npx `@<version>`-pin test
// that used to live here ("codex lane spawns a version-pinned codex-acp,
// never @latest") is gone — this lane no longer spawns via npx at all (see
// "codex lane spawns codex-acp's local dist/index.js directly, not npx"
// below). Version pinning is now `package.json`'s exact dependency version,
// asserted by nothing here (it's enforced by `npm ci`/lockfile, not the spawn
// spec) — see the file header note in src/backends.ts.

// ---- codex multi_agent_v2 reserved-tool guard (2026-07-13 incident) -----
//
// codex-acp only runs Codex in app-server mode, which registers a
// collaboration.spawn_agent tool whenever multi_agent_v2 is on; the backend
// rejected that reserved schema for both the default and sol-override codex
// lanes as a turn-1, zero-tool-call HTTP 400. Clanker dispatches are solo by
// contract, so this must be off for every codex session regardless of model.

test("codex lane always disables multi_agent_v2 in CODEX_CONFIG, with no model override", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-"));
  const spec = buildSpawnSpec("codex", {}, runDir);
  assert.ok(spec.env.CODEX_CONFIG, "CODEX_CONFIG env is set even with no model/effort opts");
  const cfg = JSON.parse(spec.env.CODEX_CONFIG);
  assert.equal(cfg.features?.multi_agent_v2?.enabled, false);
});

test("codex lane keeps multi_agent_v2 disabled alongside a model override (e.g. sol lane)", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-sol-"));
  const spec = buildSpawnSpec("codex", { model: "gpt-5.6-sol" }, runDir);
  const cfg = JSON.parse(spec.env.CODEX_CONFIG);
  assert.equal(cfg.model, "gpt-5.6-sol");
  assert.equal(cfg.features?.multi_agent_v2?.enabled, false);
});

// ---- codex lane: local dependency, not npx (2026-07-17 cold-start fix) --
//
// npx -y @agentclientprotocol/codex-acp cold-starts in ~35s per lane spawn
// (registry/package resolution round trip). codex-acp is now a local
// dependency (`npm i --save`, installed --ignore-scripts) spawned directly
// as `node <its dist/index.js>`; CODEX_PATH tells it which system `codex`
// binary to run its app-server against, since --ignore-scripts skipped its
// own @openai/codex dependency's bundled-binary download.

test("codex lane spawns codex-acp's local dist/index.js directly, not npx", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-npx-"));
  const spec = buildSpawnSpec("codex", {}, runDir);
  assert.equal(spec.command, process.execPath, "spawns via the running node binary, not `npx`");
  assert.equal(spec.args.length, 1, "single arg: the resolved entry script path");
  assert.ok(
    spec.args[0].endsWith(path.join("@agentclientprotocol", "codex-acp", "dist", "index.js")),
    `expected codex-acp's local dist/index.js, got: ${spec.args[0]}`,
  );
  assert.ok(fs.existsSync(spec.args[0]), "resolved entry script actually exists on disk");
});

test("codex lane sets CODEX_PATH to a real, executable file — not the bare 'codex' alias name", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-path-"));
  const spec = buildSpawnSpec("codex", {}, runDir);
  assert.ok(spec.env.CODEX_PATH, "CODEX_PATH env is set");
  assert.notEqual(spec.env.CODEX_PATH, "codex", "must resolve past the bare name to an absolute path");
  assert.ok(path.isAbsolute(spec.env.CODEX_PATH), "CODEX_PATH is an absolute path");
  assert.ok(fs.existsSync(spec.env.CODEX_PATH), "CODEX_PATH points at a file that actually exists");
});

// ---- CP5: read-only never auto-approves ---------------------------------

test("CP5: read-only with only an allow option declines (cancelled), never selects allow", () => {
  const res = choosePermissionOption([{ optionId: "a", kind: "allow_once" }], true);
  assert.equal(res.outcome.outcome, "cancelled");
});

test("CP5: read-only selects an available reject option", () => {
  const res = choosePermissionOption(
    [
      { optionId: "r", kind: "reject_once" },
      { optionId: "a", kind: "allow_once" },
    ],
    true,
  );
  assert.equal(res.outcome.outcome, "selected");
  assert.equal(res.outcome.outcome === "selected" ? res.outcome.optionId : "", "r");
});

test("CP5: write mode selects the first allow option", () => {
  const res = choosePermissionOption(
    [
      { optionId: "a1", kind: "allow_once" },
      { optionId: "a2", kind: "allow_always" },
    ],
    false,
  );
  assert.equal(res.outcome.outcome, "selected");
  assert.equal(res.outcome.outcome === "selected" ? res.outcome.optionId : "", "a1");
});

test("CP5: empty options always cancel", () => {
  assert.equal(choosePermissionOption([], false).outcome.outcome, "cancelled");
  assert.equal(choosePermissionOption([], true).outcome.outcome, "cancelled");
});

// ---- CP4: digest is capped at the char budget ---------------------------

test("CP4: a large event burst yields a digest at/under the char budget with a truncation marker", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({
    id: "unit-1",
    lane: "codex",
    cwd: os.tmpdir(),
    runDir,
    readOnly: true,
  });
  run.beginTurn("overflow");
  for (let i = 0; i < 80; i++) {
    run.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: `t${i}`,
      title: `overflow tool call number ${i} with a deliberately longish title`,
      status: "completed",
    } as unknown as SessionUpdate);
  }
  const digest = run.drainDigest();
  assert.ok(digest.length > 0, "digest is non-empty");
  assert.ok(
    digest.length <= DIGEST_CHAR_BUDGET + 2,
    `digest length ${digest.length} should be <= budget ${DIGEST_CHAR_BUDGET} (+2 marker)`,
  );
  assert.ok(digest.startsWith("…"), "over-budget digest starts with the truncation marker");
  run.closeStreams();
});

// ---- clanker_wait quiet-mode debounce: significant vs trivial events -----

test("hasUnreportedSignificant: trivial tool_call/location events don't count as significant", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-1", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("grep the repo");
  run.drainDigest(); // consume the (significant) turn_start entry first
  assert.equal(run.hasUnreportedSignificant(), false, "no significant event pending after drain");

  // A run of grep/read-shaped tool calls — exactly the "every grep fires an
  // event" noise clanker_wait's quiet mode exists to not wake on.
  for (let i = 0; i < 5; i++) {
    run.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: `t${i}`,
      title: `grep -n foo file${i}.ts`,
      status: "completed",
      locations: [{ path: `${os.tmpdir()}/file${i}.ts` }],
    } as unknown as SessionUpdate);
  }
  assert.equal(run.hasUnreported(), true, "seq did advance (there is a digest to drain)");
  assert.equal(
    run.hasUnreportedSignificant(),
    false,
    "tool_call + file-location echoes alone are not significant",
  );
  run.closeStreams();
});

test("hasUnreportedSignificant: a plan update is significant", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-2", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("do the plan thing");
  run.drainDigest();
  run.onUpdate({
    sessionUpdate: "plan",
    entries: [{ content: "step one", priority: "high", status: "in_progress" }],
  } as unknown as SessionUpdate);
  assert.equal(run.hasUnreportedSignificant(), true, "a plan change is significant");
  run.drainDigest();
  assert.equal(run.hasUnreportedSignificant(), false, "drain resets the significant cursor");
  run.closeStreams();
});

test("hasUnreportedSignificant: a failed tool_call_update is significant", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-3", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("do a thing that fails");
  run.drainDigest();
  run.onUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t-fail",
    title: "risky op",
    status: "in_progress",
  } as unknown as SessionUpdate);
  assert.equal(run.hasUnreportedSignificant(), false, "tool_call start alone is trivial");
  run.onUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-fail",
    status: "failed",
  } as unknown as SessionUpdate);
  assert.equal(run.hasUnreportedSignificant(), true, "a tool error is significant");
  run.closeStreams();
});

test("suspectedStallEdge fires once per stall episode, not on every call while still silent", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-4", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("go quiet");
  // Threshold -1 guarantees "stalled" is true from t=0 regardless of clock
  // granularity, isolating the edge-vs-level distinction from real timing.
  assert.equal(run.suspectedStallEdge(-1), true, "first observation of a stall fires the edge");
  assert.equal(
    run.suspectedStallEdge(-1),
    false,
    "a second call with no new event in between must NOT re-fire (busy-poll guard)",
  );
  assert.equal(
    run.suspectedStallEdge(-1),
    false,
    "and a third call still must not re-fire — this is what protected against the busy-spin regression",
  );
  // A real event clears the edge so a later stall can fire again.
  run.onUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t-after-stall",
    title: "still alive",
    status: "completed",
  } as unknown as SessionUpdate);
  assert.equal(run.suspectedStallEdge(-1), true, "a fresh event re-arms the stall edge");
  run.closeStreams();
});
