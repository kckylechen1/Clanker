/**
 * Discriminating tests for the dispatch-profile registry (#19).
 *
 * Each block below states which implementation mistake it is designed to catch;
 * a test that passes on the pre-#19 implementation, or on a plausible wrong
 * implementation of #19, is not doing any work.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildSpawnSpec } from "../src/backends.js";
import { LaneManager } from "../src/manager.js";
import {
  DISPATCH_PROFILES,
  UNREACHABLE_COMBINATIONS,
  getProfile,
  profileTurnTimeoutMs,
  requiredCombinations,
  resolveProfileDispatch,
} from "../src/profiles.js";
import { registerTools } from "../src/tools.js";
import { fakeSpec, until } from "./helpers.js";

/** A real (origin + clone) base repo, so worktree-cutting dispatches can run. */
function makeBaseRepo(): { base: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-profiles-repo-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["clone", origin, base]);
  return { base, root };
}

type Registered = { config: { inputSchema: Record<string, unknown>; description?: string }; handler: (args: any) => Promise<any> };

function captureTools(manager: unknown) {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerTools(server, manager as LaneManager);
  return tools;
}

// ---- 1. schema omission ---------------------------------------------------
// Catches the "add the parameter back and override it in the handler" shape:
// runtime enforcement would still pass every manager test, but the seat holding
// the tool could once again ASK for a lane / write mode / sandbox / model.

test("#19-1: no generated start tool exposes lane, read_only or sandbox", () => {
  const tools = captureTools({});
  const generated = [...tools.entries()].filter(([name]) => name.startsWith("clanker_start_"));
  assert.equal(generated.length, DISPATCH_PROFILES.length, "one generated tool per registry row");
  for (const [name, tool] of generated) {
    const keys = Object.keys(tool.config.inputSchema);
    for (const welded of ["lane", "read_only", "sandbox", "profile"]) {
      assert.equal(keys.includes(welded), false, `${name} must not expose '${welded}'`);
    }
    assert.ok(keys.includes("prompt"), `${name} must expose prompt`);
  }
});

test("#19-1: a generated tool exposes 'model' only where the registry says the caller must name one", () => {
  const tools = captureTools({});
  for (const profile of DISPATCH_PROFILES) {
    const keys = Object.keys(tools.get(`clanker_start_${profile.id}`)!.config.inputSchema);
    assert.equal(
      keys.includes("model"),
      profile.model.kind === "caller-required",
      `clanker_start_${profile.id}: model exposure must match the registry model policy`,
    );
    assert.equal(
      keys.includes("worktree"),
      profile.isolation === "required",
      `clanker_start_${profile.id}: worktree exposure must match the registry isolation policy`,
    );
  }
});

test("#19-1: welded dimensions reach the manager from the registry, not from the caller", async () => {
  let received: any;
  const tools = captureTools({ async dispatchStart(args: any) { received = args; return { id: "x", warnings: [] }; } });
  await tools.get("clanker_start_codex-review")!.handler({ prompt: "review this" });
  assert.equal(received.lane, "codex");
  assert.equal(received.readOnly, true);
  assert.equal(received.sandbox, "read-only");

  await tools.get("clanker_start_oc-kimi-crew")!.handler({ prompt: "implement", worktree: "clanker/crew" });
  assert.equal(received.lane, "opencode");
  assert.equal(received.model, "kimi");
  assert.equal(received.readOnly, false);
  assert.equal(received.profile, "kimi-crew");
});

// ---- 2. GLM strict-parent flow --------------------------------------------
// Red on main twice over: there is no oc-glm-write profile, and manager.ts
// rejects every GLM write outright ("direct GLM write is prohibited").

test("#19-2: oc-glm-write welds a GLM write with Sonnet supervision", () => {
  const resolved = resolveProfileDispatch({ profile: "oc-glm-write", prompt: "implement", worktree: "clanker/glm" });
  assert.equal(resolved.lane, "opencode");
  assert.equal(resolved.model, "glm");
  assert.equal(resolved.readOnly, false);
  assert.equal(resolved.supervision, "sonnet");
  assert.deepEqual([...resolved.secrets], ["ZHIPUAI_API_KEY"]);
});

test("#19-2: the oc-glm-write spawn command starts with tachi vault exec --keychain --require ZHIPUAI_API_KEY --", () => {
  const resolved = resolveProfileDispatch({ profile: "oc-glm-write", prompt: "implement", worktree: "clanker/glm" });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-profile-glm-"));
  const spec = buildSpawnSpec(resolved.lane, {
    model: resolved.model,
    effort: resolved.effort,
    readOnly: resolved.readOnly,
    sandbox: resolved.sandbox,
    profile: resolved.profile,
    secrets: resolved.secrets,
  }, runDir);
  assert.deepEqual(
    [spec.command, ...spec.args.slice(0, 6)],
    ["tachi", "vault", "exec", "--keychain", "--require", "ZHIPUAI_API_KEY", "--"],
  );
  assert.deepEqual(spec.args.slice(6), ["opencode", "acp"]);
});

test("#19-2: a GLM write actually dispatches, and its telemetry shows the GLM provider in write mode", async () => {
  let capturedOpts: any;
  const repo = makeBaseRepo();
  const m = new LaneManager({
    resolveSpec: (_lane, opts) => { capturedOpts = opts; return fakeSpec(); },
    disableReaper: true,
    baseRepo: repo.base,
  });
  try {
    // Only the registry can set supervision; a hand-built dispatch still cannot.
    await assert.rejects(
      () => m.dispatchStart({ lane: "opencode", model: "glm", prompt: "w", readOnly: false, worktree: "x" }),
      /direct GLM write is prohibited/,
    );
    const resolved = resolveProfileDispatch({
      profile: "oc-glm-write",
      prompt: "implement",
      worktree: `clanker/glm-telemetry-${Date.now()}`,
    });
    const { id } = await m.dispatchStart(resolved);
    const telemetry = m.status(id).telemetry!;
    assert.equal(telemetry.read_only, false);
    assert.equal(telemetry.resolved_model, "zhipuai-coding-plan/glm-5.2");
    assert.deepEqual([...(capturedOpts.secrets ?? [])], ["ZHIPUAI_API_KEY"]);
    await until(() => m.status(id).status !== "running", 4_000);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- 3. profile coverage ---------------------------------------------------
// Catches a migration that silently drops a live dispatch shape.

test("#19-3: every reachable lane x write-mode combination has a profile", () => {
  for (const combo of requiredCombinations()) {
    const match = DISPATCH_PROFILES.filter((p) => p.lane === combo.lane && p.readOnly === combo.readOnly);
    assert.ok(
      match.length > 0,
      `no profile covers lane=${combo.lane} readOnly=${combo.readOnly}; a live dispatch shape would be unreachable`,
    );
  }
  // Anything declared unreachable must really be refused by the server.
  for (const combo of UNREACHABLE_COMBINATIONS) {
    assert.equal(
      DISPATCH_PROFILES.some((p) => p.lane === combo.lane && p.readOnly === combo.readOnly),
      false,
      `${combo.lane} readOnly=${combo.readOnly} is declared unreachable but a profile offers it`,
    );
  }
});

test("#19-3: gemini write really is unreachable, which is why it has no profile", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-gemini-write-"));
  assert.throws(
    () => buildSpawnSpec("gemini", { readOnly: false, model: "gemini-3.6-flash-medium" }, runDir),
    /reconnaissance-only/,
  );
});

// ---- 4. per-profile turn ceiling -------------------------------------------
// Catches "declared the field but never wired it": the value must reach the
// run, not just sit in the registry.

test("#19-4: two profiles with different turnTimeoutMs take effect differently", async () => {
  const recon = getProfile("gemini-recon");
  const review = getProfile("codex-review");
  assert.notEqual(recon.turnTimeoutMs, review.turnTimeoutMs, "the registry must actually differentiate the ceilings");

  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  try {
    const a = await m.dispatchStart(resolveProfileDispatch({ profile: "gemini-recon", prompt: "survey", cwd: os.tmpdir() }));
    const b = await m.dispatchStart(resolveProfileDispatch({ profile: "codex-review", prompt: "review", cwd: os.tmpdir() }));
    assert.equal(m.status(a.id).telemetry?.turn_timeout_ms, recon.turnTimeoutMs);
    assert.equal(m.status(b.id).telemetry?.turn_timeout_ms, review.turnTimeoutMs);
    await until(() => m.status(a.id).status !== "running" && m.status(b.id).status !== "running", 4_000);
  } finally {
    await m.shutdown();
  }
});

test("#19-4: a profile ceiling is operator-overridable per profile", () => {
  const profile = getProfile("codex-write");
  assert.equal(profileTurnTimeoutMs(profile, {}), profile.turnTimeoutMs);
  assert.equal(profileTurnTimeoutMs(profile, { CLANKER_TURN_TIMEOUT_MS_CODEX_WRITE: "90000" }), 90_000);
  assert.equal(
    profileTurnTimeoutMs(profile, { CLANKER_TURN_TIMEOUT_MS_CODEX_WRITE: "not-a-number" }),
    profile.turnTimeoutMs,
    "a malformed override falls back to the declared ceiling instead of disabling the ceiling",
  );
});

// ---- 5. existing runtime enforcement is untouched ---------------------------
// The registry narrows the entrance; it must not become a second, weaker copy
// of the manager's gates.

test("#19-5: profile dispatches still hit the manager's own write-isolation and gemini gates", async () => {
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  try {
    // Bypassing the registry with a hand-built write dispatch is still refused.
    await assert.rejects(
      () => m.dispatchStart({ lane: "codex", prompt: "do work", readOnly: false }),
      /must run in an isolated worktree/,
    );
    await assert.rejects(
      () => m.dispatchStart({ lane: "gemini", prompt: "r", readOnly: false, worktree: "x" }),
      /reconnaissance-only|rejects worktree/,
    );
  } finally {
    await m.shutdown();
  }
});

test("#19-5: the registry never emits a dispatch the manager would have to reject", () => {
  for (const profile of DISPATCH_PROFILES) {
    const resolved = resolveProfileDispatch({
      profile: profile.id,
      prompt: "task",
      ...(profile.isolation === "required" ? { worktree: `clanker/${profile.id}` } : {}),
      ...(profile.model.kind === "caller-required" ? { model: "ds" } : {}),
    });
    // Every write-capable profile carries a worktree (manager CP2).
    if (!resolved.readOnly) assert.ok(resolved.worktree, `${profile.id} is write-capable and must carry a worktree`);
    // A codex read-only profile must not weld a write-capable sandbox, or the
    // manager's writeCapableSandbox rule would demand isolation it forbids.
    if (resolved.readOnly && resolved.lane === "codex") {
      assert.equal(resolved.sandbox, "read-only", `${profile.id} would trip writeCapableSandbox`);
    }
    // Non-codex write lanes must carry an explicit model (manager gate).
    if (!resolved.readOnly && resolved.lane !== "codex") {
      assert.ok(resolved.model?.trim(), `${profile.id} must carry an explicit model`);
    }
    // Only the gemini lane may be read-only-and-worktree-free by policy.
    if (resolved.lane === "gemini") assert.equal(resolved.readOnly, true);
  }
});

// ---- 6. 0.2.5 semantic parity ----------------------------------------------
// The registry is a better mechanism for the same behavior, not a redesign of
// it. These pin the three 0.2.5 dispatch shapes field by field.

test("#19-6: 0.2.5 parity — readonly / write / glm_write shapes survive field-for-field", () => {
  // clanker_dispatch_readonly_start: read_only forced true, sandbox undefined,
  // model required for opencode, worktree optional-but-unused, lane chosen.
  for (const id of ["codex-review", "oc-review", "grok-review"]) {
    const p = getProfile(id);
    assert.equal(p.readOnly, true, `${id}: 0.2.5 readonly path forced read_only=true`);
    assert.equal(p.isolation, "forbidden");
  }
  assert.equal(getProfile("oc-review").model.kind, "caller-required", "0.2.5 required an explicit opencode model on the read path too");

  // clanker_dispatch_write_start: read_only forced false, worktree required,
  // model required except on codex, GLM rejected.
  for (const id of ["codex-write", "oc-write", "grok-write"]) {
    const p = getProfile(id);
    assert.equal(p.readOnly, false, `${id}: 0.2.5 write path forced read_only=false`);
    assert.equal(p.isolation, "required", `${id}: 0.2.5 write path required a managed worktree`);
  }
  assert.equal(getProfile("codex-write").model.kind, "lane-default", "0.2.5 made model optional for lane=codex writes");
  assert.equal(getProfile("oc-write").model.kind, "caller-required");
  assert.equal(getProfile("grok-write").model.kind, "caller-required");
  assert.throws(
    () => resolveProfileDispatch({ profile: "oc-write", prompt: "w", worktree: "b", model: "glm" }),
    /supervised|prohibited|GLM/i,
    "0.2.5's writer relay rejected the GLM alias; GLM writes belong to the supervised profile",
  );

  // clanker_dispatch_glm_write_start: lane/model/read_only all fixed, worktree
  // required, ZHIPUAI_API_KEY vaulted, Sonnet supervision.
  const glm = getProfile("oc-glm-write");
  assert.deepEqual(
    {
      lane: glm.lane,
      model: glm.model,
      readOnly: glm.readOnly,
      isolation: glm.isolation,
      secrets: [...glm.secrets],
      supervision: glm.supervision,
    },
    {
      lane: "opencode",
      model: { kind: "welded", id: "glm" },
      readOnly: false,
      isolation: "required",
      secrets: ["ZHIPUAI_API_KEY"],
      supervision: "sonnet",
    },
  );
});

test("#19-6: every profile description states its welded capabilities and its deadline", () => {
  const tools = captureTools({});
  for (const profile of DISPATCH_PROFILES) {
    const description = tools.get(`clanker_start_${profile.id}`)!.config.description ?? "";
    assert.match(description, new RegExp(`lane=${profile.lane}`));
    assert.match(description, new RegExp(`read_only=${profile.readOnly}`));
    assert.match(description, /Hard turn ceiling: \d+ minutes/);
    if (profile.secrets.length) assert.match(description, /tachi vault exec/);
    if (profile.status === "dormant") assert.match(description, /DORMANT/);
  }
});
