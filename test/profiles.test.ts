/**
 * Discriminating tests for the dispatch-profile registry (#19).
 *
 * Each block states which implementation mistake it is designed to catch; a
 * test that passes on the pre-#19 implementation, or on a plausible wrong
 * implementation of #19, is not doing any work. The v3 blocks (F1-F7) each
 * reproduce a concrete cold-review finding against 4a8a718.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildSpawnSpec } from "../src/backends.js";
import { isGlmModel, LANES_WITH_PINNED_WRITE_MODEL } from "../src/constants.js";
import type { ClankerHost } from "../src/host.js";
import { LaneManager } from "../src/manager.js";
import {
  DISPATCH_PROFILES,
  UNREACHABLE_COMBINATIONS,
  allCombinations,
  getProfile,
  profileTurnTimeoutMs,
  resolveProfileDispatch,
  type DispatchProfile,
} from "../src/profiles.js";
import { profilesForHost, registerTools } from "../src/tools.js";
import { LANE_NAMES, type LaneRequestOptions, type LaneStatusView, type SpawnSpec } from "../src/types.js";
import { dropMutant, fakeSpec, loadMutantManager, until } from "./helpers.js";

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

type Registered = {
  config: { inputSchema: Record<string, unknown>; description?: string };
  handler: (args: any) => Promise<any>;
};

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

/**
 * A stand-in manager that records every dispatch attempt through BOTH public
 * entrances, so a test can ask "what could this tool surface actually start?"
 * without caring which entrance a tool chose.
 */
function recordingManager(host: ClankerHost) {
  const profileDispatches: any[] = [];
  const rawDispatches: any[] = [];
  return {
    host,
    profileDispatches,
    rawDispatches,
    async dispatchProfile(input: any) { profileDispatches.push(input); return { id: "rec", warnings: [] }; },
    async dispatchStart(params: any) { rawDispatches.push(params); return { id: "rec", warnings: [] }; },
  };
}

// ---- F1. the narrow tools are the ONLY entrance ----------------------------
// Cold review on 4a8a718: with a generic `clanker_start(profile,...)` present,
// host=codex started oc-glm-write and got a live opencode/glm/write job. This
// test therefore walks EVERY registered tool instead of asserting one name is
// absent, and goes red the moment any universal entrance comes back.

test("#19-F1: on host=codex no registered tool can reach a supervised profile", async () => {
  const supervised = DISPATCH_PROFILES.filter((p) => p.supervision === "sonnet").map((p) => p.id);
  assert.ok(supervised.length > 0, "the registry must still contain a supervised profile for this test to mean anything");

  const manager = recordingManager("codex");
  const tools = captureTools(manager);

  // (a) structural: no tool's schema accepts a value that names a supervised
  //     profile — this is what catches a re-added generic `profile` enum.
  for (const [name, tool] of tools) {
    for (const [key, field] of Object.entries(tool.config.inputSchema)) {
      for (const id of supervised) {
        assert.equal(
          (field as z.ZodTypeAny).safeParse(id).success && key === "profile",
          false,
          `${name}.${key} accepts the supervised profile id '${id}'`,
        );
      }
    }
  }

  // (b) behavioral: fire every tool with a kitchen-sink argument bag that tries
  //     to name the supervised profile through every plausible parameter, then
  //     assert nothing supervised was ever dispatched.
  const attack = {
    profile: supervised[0],
    prompt: "reach the supervised profile",
    cwd: os.tmpdir(),
    worktree: "clanker/attack",
    model: "glm",
    sandbox: "danger-full-access",
    effort: "high",
    lane: "opencode",
    read_only: false,
    supervision: "sonnet",
  };
  for (const [, tool] of tools) await tool.handler(attack).catch(() => undefined);

  for (const input of manager.profileDispatches) {
    const profile = DISPATCH_PROFILES.find((p) => p.id === input.profile);
    assert.ok(profile, `dispatched an unknown profile '${input.profile}'`);
    assert.notEqual(profile.supervision, "sonnet", `the tool surface reached supervised profile '${input.profile}'`);
  }
  assert.deepEqual(manager.rawDispatches, [], "no tool may reach the raw dispatchStart entrance");
});

test("#19-F1: the surface is exactly the generated narrow tools plus lifecycle tools", () => {
  const tools = captureTools(recordingManager("standalone"));
  assert.equal(tools.has("clanker_start"), false, "a universal entrance makes every narrow tool decoration");
  const generated = [...tools.keys()].filter((n) => n.startsWith("clanker_start_"));
  assert.deepEqual(generated.sort(), DISPATCH_PROFILES.map((p) => `clanker_start_${p.id}`).sort());
});

test("#19-F1: no generated start tool exposes lane or read_only, or a welded model/sandbox", () => {
  const tools = captureTools(recordingManager("standalone"));
  for (const profile of DISPATCH_PROFILES) {
    const keys = Object.keys(tools.get(`clanker_start_${profile.id}`)!.config.inputSchema);
    for (const welded of ["lane", "read_only", "profile", "supervision", "secrets"]) {
      assert.equal(keys.includes(welded), false, `clanker_start_${profile.id} must not expose '${welded}'`);
    }
    // Two policies put `model` on the schema (required, optional) and two keep
    // it off (welded, lane-default). Spelled out rather than delegated to
    // `modelIsCallerSupplied`, so that helper changing behaviour cannot make
    // this assertion agree with it automatically.
    assert.equal(
      keys.includes("model"),
      profile.model.kind === "caller-required" || profile.model.kind === "caller-optional",
      `clanker_start_${profile.id}: model exposure must match the registry model policy`,
    );
    assert.equal(
      keys.includes("sandbox"),
      profile.sandbox?.kind === "caller",
      `clanker_start_${profile.id}: sandbox exposure must match the registry sandbox policy`,
    );
    assert.equal(
      keys.includes("worktree"),
      profile.isolation !== "forbidden",
      `clanker_start_${profile.id}: worktree exposure must match the registry isolation policy`,
    );
  }
});

// ---- F2. supervision is unforgeable ----------------------------------------
// Cold review reproduced PASSED_GATE + a live dispatch by handing
// `supervision: "sonnet"` to the public dispatchStart. 0.2.5's shape was a
// private positional flag (26e9c9f src/manager.ts:162-179).

test("#19-F2: a caller cannot self-report supervision to unlock a GLM write", async () => {
  const repo = makeBaseRepo();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: repo.base });
  try {
    for (const forged of [
      { supervision: "sonnet" },
      { supervision: "sonnet", secrets: ["ZHIPUAI_API_KEY"] },
      { supervision: "sonnet", profileId: "oc-glm-write" },
    ]) {
      await assert.rejects(
        () => m.dispatchStart({
          lane: "opencode",
          model: "glm",
          prompt: "forge supervision",
          readOnly: false,
          worktree: `clanker/forged-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...forged,
        } as any),
        /direct GLM write is prohibited/,
        `forged ${JSON.stringify(forged)} must not unlock the GLM gate`,
      );
    }
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#19-F2: the registry entrance still mints supervision, and it really dispatches", async () => {
  let capturedOpts: any;
  const repo = makeBaseRepo();
  const m = new LaneManager({
    resolveSpec: (_lane, opts) => { capturedOpts = opts; return fakeSpec(); },
    disableReaper: true,
    baseRepo: repo.base,
  });
  try {
    const { id } = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "implement",
      worktree: `clanker/glm-telemetry-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
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

test("#19-F2: the oc-glm-write spawn command starts with tachi vault exec --keychain --require ZHIPUAI_API_KEY --", () => {
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

// ---- F3. read-only + worktree survives -------------------------------------
// 0.2.5's read-only schema kept `worktree` optional and the manager really cut
// the tree; welding isolation to "forbidden" deleted a documented workflow.

test("#19-F3: read-only profiles accept an optional worktree and really run inside it", async () => {
  const repo = makeBaseRepo();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: repo.base });
  try {
    const branch = `clanker/read-in-tree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review with tests", worktree: branch });
    const view = m.status(id);
    assert.equal(view.telemetry?.read_only, true, "the read gate stays on");
    assert.ok(view.worktree, "a read-only dispatch that names a worktree must actually get one");
    assert.notEqual(path.resolve(view.cwd), path.resolve(repo.base), "it must not run in the primary checkout");
    await until(() => m.status(id).status !== "running", 4_000);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#19-F3: omitting the worktree still runs a read in place, and gemini still refuses one", async () => {
  const repo = makeBaseRepo();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: repo.base });
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review in place" });
    assert.equal(m.status(id).worktree, undefined);
    await until(() => m.status(id).status !== "running", 4_000);
    await assert.rejects(
      () => m.dispatchProfile({ profile: "gemini-recon", prompt: "survey", worktree: "clanker/nope" }),
      /runs in place and does not take a worktree/,
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- F4. caller-selectable sandbox survives --------------------------------
// 0.2.5's write schema omitted only read_only and kept all three sandbox tiers.

test("#19-F4: codex-write keeps all three sandbox tiers and defaults to workspace-write", () => {
  const tools = captureTools(recordingManager("standalone"));
  const schema = tools.get("clanker_start_codex-write")!.config.inputSchema.sandbox as z.ZodTypeAny;
  for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
    assert.equal(schema.safeParse(mode).success, true, `sandbox tier '${mode}' must stay selectable`);
    assert.equal(resolveProfileDispatch({ profile: "codex-write", prompt: "w", worktree: "b", sandbox: mode }).sandbox, mode);
  }
  assert.equal(schema.safeParse("nonsense").success, false);
  assert.equal(
    resolveProfileDispatch({ profile: "codex-write", prompt: "w", worktree: "b" }).sandbox,
    "workspace-write",
    "omitting sandbox keeps 0.2.5's effective default",
  );
});

test("#19-F4: a welded sandbox is still not a parameter", () => {
  const tools = captureTools(recordingManager("standalone"));
  assert.equal("sandbox" in tools.get("clanker_start_codex-review")!.config.inputSchema, false);
  assert.throws(
    () => resolveProfileDispatch({ profile: "codex-review", prompt: "r", sandbox: "danger-full-access" }),
    /welds sandbox='read-only'/,
    "the read-only gate must not be reachable around via the native sandbox",
  );
});

// ---- F5. grok read-only model policy matches 0.2.5 -------------------------
// 0.2.5 forced an explicit model only for read-only OPENCODE (26e9c9f
// src/tools.ts:183-192); grok read fell back to the backend default.

test("#19-F5: grok-review may omit the model and lands on the lane default; oc-review may not", () => {
  assert.equal(resolveProfileDispatch({ profile: "grok-review", prompt: "review" }).model, undefined);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-default-"));
  const spec = buildSpawnSpec("grok", { readOnly: true }, runDir);
  assert.equal(spec.args[spec.args.indexOf("--model") + 1], "grok-4.5");

  assert.throws(
    () => resolveProfileDispatch({ profile: "oc-review", prompt: "review" }),
    /requires an explicit model id/,
    "opencode is the lane that fails closed without a model",
  );
});

// ---- F6. 0.2.5 parity, compared on every dimension -------------------------
// The first revision compared only lane/model/readOnly, so a registry that
// changed worktree policy, sandbox policy or host reachability still went
// green. Every dimension below has a mutation proof underneath it.

/** The 0.2.5 dispatch shapes, field by field, from 26e9c9f. */
const PARITY_0_2_5 = {
  // src/tools.ts:129 — omit({read_only, sandbox}); :21-29 keeps worktree optional.
  readonly_start: { readOnly: true, isolation: "optional", sandboxSelectable: false, weldedSandbox: undefined },
  // :131-138 — omit({read_only}) only, so all three sandbox tiers stay; worktree required.
  write_start: { readOnly: false, isolation: "required", sandboxSelectable: true, weldedSandbox: undefined },
  // :71-76 — omit({model, effort, read_only, sandbox, agent}); worktree required.
  glm_write_start: {
    readOnly: false, isolation: "required", sandboxSelectable: false, weldedSandbox: undefined,
    lane: "opencode", model: "glm", secrets: ["ZHIPUAI_API_KEY"], supervision: "sonnet",
  },
} as const;

/** Project a profile onto the 0.2.5 comparison dimensions. */
function parityShape(profile: DispatchProfile) {
  return {
    readOnly: profile.readOnly,
    isolation: profile.isolation,
    sandboxSelectable: profile.sandbox?.kind === "caller",
    weldedSandbox: profile.sandbox?.kind === "welded" ? profile.sandbox.mode : undefined,
  };
}

test("#19-F6: read profiles match 0.2.5's readonly shape on worktree and sandbox", () => {
  for (const id of ["oc-review", "grok-review"]) {
    assert.deepEqual(parityShape(getProfile(id)), PARITY_0_2_5.readonly_start, `${id} diverges from 0.2.5's readonly shape`);
  }
  // codex-review is the one documented divergence: it welds sandbox=read-only
  // so a caller cannot use the native sandbox to get around read_only.
  assert.deepEqual(parityShape(getProfile("codex-review")), { ...PARITY_0_2_5.readonly_start, weldedSandbox: "read-only" });
  // gemini did not exist in 0.2.5; its forbidden isolation is the lane's rule.
  assert.equal(getProfile("gemini-recon").isolation, "forbidden");
});

test("#19-F6: write profiles match 0.2.5's write shape on worktree and sandbox", () => {
  assert.deepEqual(parityShape(getProfile("codex-write")), PARITY_0_2_5.write_start, "codex-write must keep all three sandbox tiers");
  for (const id of ["oc-write", "grok-write"]) {
    // opencode/grok have no native sandbox tier, so 0.2.5's selectable sandbox
    // was a warn-and-ignore no-op on them; absence is behavior-identical.
    assert.equal(getProfile(id).readOnly, false);
    assert.equal(getProfile(id).isolation, "required");
    assert.equal(getProfile(id).sandbox, undefined);
  }
});

test("#19-F6: oc-glm-write matches 0.2.5's glm_write shape on every dimension", () => {
  const glm = getProfile("oc-glm-write");
  assert.deepEqual({
    ...parityShape(glm),
    lane: glm.lane,
    model: glm.model.kind === "welded" ? glm.model.id : glm.model.kind,
    secrets: [...glm.secrets],
    supervision: glm.supervision,
  }, PARITY_0_2_5.glm_write_start);
});

test("#19-F6: host reachability matches 0.2.5's per-host tool registration", () => {
  // 0.2.5: the lane enum was filtered by laneNamesForHost, and the glm write
  // tool was registered only when host !== "codex" (26e9c9f src/tools.ts:232).
  const reachable = (host: ClankerHost) =>
    profilesForHost({ host } as LaneManager).map((p) => `${p.lane}:${p.readOnly ? "read" : "write"}:${p.supervision}`).sort();

  assert.equal(reachable("codex").some((s) => s.startsWith("codex:")), false, "host=codex must not reach its own lane");
  assert.equal(reachable("codex").some((s) => s.endsWith(":sonnet")), false, "host=codex must not reach the supervised shape");
  assert.equal(reachable("claude").some((s) => s.endsWith(":sonnet")), true, "host=claude keeps the supervisor");
  assert.equal(reachable("claude").some((s) => s.startsWith("codex:")), true);
  assert.deepEqual(reachable("standalone"), reachable("claude"));
});

test("#19-F6: the parity comparator has teeth — mutating any dimension flips it red", () => {
  const base = getProfile("codex-write");
  const mutations: Array<[string, DispatchProfile]> = [
    ["worktree", { ...base, isolation: "optional" }],
    ["sandbox", { ...base, sandbox: { kind: "welded", mode: "workspace-write" } }],
    ["readOnly", { ...base, readOnly: true }],
  ];
  for (const [dimension, mutated] of mutations) {
    assert.notDeepEqual(
      parityShape(mutated),
      parityShape(base),
      `the comparator does not observe the '${dimension}' dimension — it would go green on a real divergence`,
    );
  }
  // Host reachability: the filter is only load-bearing if the supervised
  // profile sits on a lane host=codex could otherwise drive.
  assert.equal(profilesForHost({ host: "codex" } as LaneManager).some((p) => p.supervision === "sonnet"), false);
  assert.ok(
    DISPATCH_PROFILES.some((p) => p.supervision === "sonnet" && p.lane !== "codex"),
    "the supervised profile is on a lane host=codex could otherwise drive, so the filter is load-bearing",
  );
});

// ---- F6b. parity observed at RUNTIME, not read back off the registry -------
// Cold review's attack on the block above: patch the manager so a read-only
// dispatch RECEIVES a worktree path but no tree is ever created — all eleven
// #19-F6 tests stayed green, because they compare registry rows against a table
// of registry rows. Declaration parity cannot see an implementation that
// contradicts its own declaration.
//
// So these dispatch through the real LaneManager and assert against facts the
// registry cannot fake: what git says about the worktree, what the real
// backends.ts spawn recipe carries, what options the backend was actually
// handed. Every one of them is then re-run against mutant builds (bottom of the
// block) that break exactly those runtime dimensions while leaving every
// registry row untouched — each mutant MUST make these assertions throw.

/** What one profile dispatch really did, as opposed to what its row says. */
interface RuntimeFacts {
  view: LaneStatusView;
  /** The options the manager actually handed the backend spec resolver. */
  opts: LaneRequestOptions;
  /** What the REAL backends.ts would spawn for those options (gemini excluded, see below). */
  spec?: SpawnSpec;
  branch?: string;
}

/** Absolute, symlink-resolved path, tolerating a path that no longer exists. */
function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** Worktree paths git itself has registered for `repo`. */
function registeredWorktrees(repo: string): string[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, stdio: "pipe" }).toString();
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => real(line.slice("worktree ".length).trim()));
}

/**
 * Dispatch one profile through a (possibly mutated) LaneManager and assert that
 * the RUNTIME matches what the registry row declares. Throws on the first
 * divergence — which is what makes it usable as a mutation oracle.
 */
async function assertRuntimeMatchesDeclaration(
  Manager: typeof LaneManager,
  base: string,
  profile: DispatchProfile,
  extra: Partial<Parameters<LaneManager["dispatchProfile"]>[0]> = {},
): Promise<RuntimeFacts> {
  let opts!: LaneRequestOptions;
  let spec: SpawnSpec | undefined;
  const m = new Manager({
    resolveSpec: (lane, o, runDir) => {
      opts = o;
      // The REAL spawn recipe for exactly those options. This is what turns
      // "the row says sandbox=read-only" into "the backend received it".
      // Gemini is excluded on purpose: buildSpawnSpec refuses to build a gemini
      // spec off macOS (requireGeminiWorkspaceSandbox), so computing one here
      // would silently turn a parity test into a platform test.
      if (lane !== "gemini") spec = buildSpawnSpec(lane, o, runDir);
      return fakeSpec();
    },
    disableReaper: true,
    baseRepo: base,
  });
  const branch = profile.isolation === "forbidden"
    ? undefined
    : `clanker/f6b-${profile.id}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { id } = await m.dispatchProfile({
      profile: profile.id,
      prompt: `F6b runtime probe for ${profile.id}`,
      cwd: base,
      ...(branch ? { worktree: branch } : {}),
      ...(profile.model.kind === "caller-required" ? { model: "ds" } : {}),
      ...extra,
    });
    const view = m.status(id);

    // (1) the write gate reached both the run and the backend
    assert.equal(view.telemetry?.read_only, profile.readOnly, `${profile.id}: run read_only diverges from the row`);
    assert.equal(opts.readOnly, profile.readOnly, `${profile.id}: backend received the wrong read_only`);

    // (2) isolation: a declared worktree must be a real, git-registered tree the
    //     job is really running in — the exact dimension the cold-review mutant
    //     falsified while every declaration test stayed green.
    if (branch === undefined) {
      assert.equal(view.worktree, undefined, `${profile.id}: isolation=forbidden but a worktree was created`);
      assert.equal(real(view.cwd), real(base), `${profile.id}: must run in place`);
    } else {
      assert.ok(view.worktree, `${profile.id}: named a worktree branch but the run reports none`);
      const wt = view.worktree!;
      assert.equal(fs.existsSync(wt), true, `${profile.id}: reported worktree '${wt}' does not exist on disk`);
      assert.equal(fs.existsSync(path.join(wt, ".git")), true, `${profile.id}: '${wt}' is not a git worktree`);
      assert.ok(
        registeredWorktrees(base).includes(real(wt)),
        `${profile.id}: git has no worktree registered at '${wt}' for the target repo`,
      );
      assert.equal(
        execFileSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" }).toString().trim(),
        branch,
        `${profile.id}: the worktree is not on the requested branch`,
      );
      assert.equal(real(view.cwd), real(wt), `${profile.id}: the job is not actually running inside the worktree`);
      assert.notEqual(real(view.cwd), real(base), `${profile.id}: the job is running in the primary checkout`);
    }

    // (3) sandbox: a welded tier must arrive at the backend, not merely be
    //     declared. For the codex lane it is checked all the way down to the
    //     env var codex-acp actually reads.
    if (profile.sandbox === undefined) {
      assert.equal(opts.sandbox, undefined, `${profile.id}: a sandbox reached a lane that has no sandbox tier`);
    } else {
      const expected = profile.sandbox.kind === "welded"
        ? profile.sandbox.mode
        : (extra.sandbox ?? profile.sandbox.defaultMode);
      assert.equal(opts.sandbox, expected, `${profile.id}: backend received sandbox='${opts.sandbox}', row says '${expected}'`);
      if (profile.lane === "codex") {
        assert.equal(
          spec?.env.INITIAL_AGENT_MODE,
          CODEX_AGENT_MODE[expected],
          `${profile.id}: codex-acp would run in the wrong agent mode`,
        );
      }
    }

    // (4) credentials + supervision: the vault wrap is a property of the spawn
    //     command, and a supervised profile is one that a caller-forged dispatch
    //     cannot reproduce.
    assert.deepEqual([...(opts.secrets ?? [])], [...profile.secrets], `${profile.id}: declared secrets did not reach the spawn`);
    if (profile.secrets.length) {
      // `--require` takes ONE comma-joined argument, and backends.ts unions the
      // profile's secrets with its own model-derived requirement, so assert
      // containment rather than an exact list.
      assert.equal(spec?.command, "tachi", `${profile.id}: the spawn command is not wrapped in tachi vault exec`);
      assert.deepEqual((spec?.args ?? []).slice(0, 4), ["vault", "exec", "--keychain", "--require"]);
      const required = (spec?.args[4] ?? "").split(",");
      for (const secret of profile.secrets) {
        assert.ok(required.includes(secret), `${profile.id}: '${secret}' is not materialized by the vault wrap`);
      }
      assert.equal(spec?.args[5], "--", `${profile.id}: the vault wrap does not hand off to the real command`);
    }
    if (profile.supervision === "sonnet") {
      assert.equal(opts.readOnly, false, `${profile.id}: a supervised profile that is not write-capable proves nothing`);
      assert.ok(isGlmModel(opts.model), `${profile.id}: supervision must be minted for the GLM write shape`);
      // The same shape without the minted capability must be refused, or
      // "supervision reached the spawn" is vacuous.
      await assert.rejects(
        () => m.dispatchStart({
          lane: profile.lane, model: opts.model, prompt: "forge", readOnly: false,
          cwd: base, worktree: `clanker/f6b-forged-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          supervision: "sonnet",
        } as any),
        /direct GLM write is prohibited/,
        `${profile.id}: the supervised gate is not actually guarding anything`,
      );
    }

    // (5) the per-profile ceiling is the one really in force for this run
    assert.equal(
      view.telemetry?.turn_timeout_ms,
      profileTurnTimeoutMs(profile),
      `${profile.id}: the declared turn ceiling never reached the run`,
    );

    await until(() => m.status(id).status !== "running", 4_000);
    return { view, opts, spec, branch };
  } finally {
    await m.shutdown();
  }
}

/** codex-acp's INITIAL_AGENT_MODE ids, per CodexSandboxMode (backends.ts SANDBOX_TO_AGENT_MODE). */
const CODEX_AGENT_MODE: Record<string, string> = {
  "read-only": "read-only",
  "workspace-write": "agent",
  "danger-full-access": "agent-full-access",
};

test("#19-F6b: every profile's runtime matches its declaration, not just its row", async () => {
  const repo = makeBaseRepo();
  try {
    for (const profile of DISPATCH_PROFILES) {
      await assertRuntimeMatchesDeclaration(LaneManager, repo.base, profile);
    }
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#19-F6b: a caller-selected sandbox tier really reaches codex-acp", async () => {
  const repo = makeBaseRepo();
  try {
    // The welded case is covered by the loop above; this is the selectable one,
    // where a manager that dropped the option would still look right on the
    // read-only/workspace-write pair (both map onto the same default).
    for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
      const facts = await assertRuntimeMatchesDeclaration(
        LaneManager, repo.base, getProfile("codex-write"), { sandbox: mode },
      );
      assert.equal(facts.opts.sandbox, mode);
      assert.equal(facts.spec?.env.INITIAL_AGENT_MODE, CODEX_AGENT_MODE[mode], `sandbox '${mode}' did not reach codex-acp`);
    }
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#19-F6b: the runtime checks have teeth — each broken dimension flips them red", async () => {
  const repo = makeBaseRepo();
  const mutants: Array<{ name: string; mutations: Parameters<typeof loadMutantManager>[1]; probe: string; expect: RegExp }> = [
    {
      // Cold review's own attack, verbatim in intent: read-only dispatches get a
      // worktree PATH and no worktree.
      name: "f6b-declared-worktree-never-created",
      mutations: [{
        file: "manager.ts",
        find: "        worktreePath = await createWorktree(params.worktree, id, targetRepo, baseSha);",
        replace: "        worktreePath = readOnly ? deriveWorktreePath(params.worktree, id) : await createWorktree(params.worktree, id, targetRepo, baseSha);",
      }],
      probe: "codex-review",
      expect: /does not exist on disk/,
    },
    {
      // The welded sandbox is declared but dropped on the way to the backend.
      name: "f6b-sandbox-dropped-before-backend",
      mutations: [{ file: "manager.ts", find: "      sandbox: params.sandbox,", replace: "      sandbox: undefined," }],
      probe: "codex-review",
      expect: /backend received sandbox='undefined'/,
    },
    {
      // Supervision is declared by the row but never minted into the dispatch.
      name: "f6b-supervision-never-minted",
      mutations: [{ file: "manager.ts", find: "        supervision: resolved.supervision,", replace: '        supervision: "none",' }],
      probe: "oc-glm-write",
      expect: /direct GLM write is prohibited/,
    },
    {
      // The profile's vault secrets are declared but never reach the spawn.
      name: "f6b-secrets-never-minted",
      mutations: [{ file: "manager.ts", find: "      secrets: minted.secrets,", replace: "      secrets: undefined," }],
      probe: "oc-glm-write",
      expect: /declared secrets did not reach the spawn/,
    },
  ];
  try {
    for (const mutant of mutants) {
      const { LaneManager: Mutated } = await loadMutantManager(mutant.name, mutant.mutations);
      await assert.rejects(
        () => assertRuntimeMatchesDeclaration(Mutated, repo.base, getProfile(mutant.probe)),
        mutant.expect,
        `mutant '${mutant.name}' left the runtime checks green — they do not observe that dimension`,
      );
      dropMutant(mutant.name);
    }
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- F7. coverage proven against the real server ---------------------------
// The first revision subtracted UNREACHABLE_COMBINATIONS from the space and
// then asserted the remainder — a table agreeing with itself. Now every
// uncovered combination must be refused by the actual manager/backend.

test("#19-F7: every lane x write-mode either has a profile or is really refused by the server", async () => {
  const repo = makeBaseRepo();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: repo.base });
  try {
    for (const combo of allCombinations()) {
      if (DISPATCH_PROFILES.some((p) => p.lane === combo.lane && p.readOnly === combo.readOnly)) continue;
      // No profile: prove the server itself refuses this shape rather than
      // trusting the exclusion list the registry ships.
      await assert.rejects(
        () => m.dispatchStart({
          lane: combo.lane,
          prompt: "probe",
          readOnly: combo.readOnly,
          model: combo.lane === "gemini" ? "gemini-3.6-flash-medium" : "ds",
          worktree: combo.readOnly ? undefined : `clanker/probe-${combo.lane}`,
        }),
        /reconnaissance-only|prohibited|rejects/,
        `lane=${combo.lane} readOnly=${combo.readOnly} has no profile but the server accepts it`,
      );
      // …and it must be a documented exclusion, not an accident.
      assert.ok(
        UNREACHABLE_COMBINATIONS.some((c) => c.lane === combo.lane && c.readOnly === combo.readOnly),
        `lane=${combo.lane} readOnly=${combo.readOnly} is uncovered and undocumented`,
      );
    }
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#19-F7: a write-capable gemini request is refused loudly, not silently downgraded", async () => {
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  try {
    // Pre-fix the manager normalized gemini to readOnly=true BEFORE the write
    // rejection, so the rejection was dead code: the caller got a running
    // read-only job while believing it had asked for a write.
    await assert.rejects(
      () => m.dispatchStart({ lane: "gemini", prompt: "write please", readOnly: false }),
      /reconnaissance-only and cannot run write-capable dispatches/,
    );
    // An omitted flag still normalizes to read-only, as before.
    const { id } = await m.dispatchStart({ lane: "gemini", prompt: "survey", cwd: os.tmpdir() });
    assert.equal(m.status(id).telemetry?.read_only, true);
    await until(() => m.status(id).status !== "running", 4_000);
  } finally {
    await m.shutdown();
  }
});

test("#19-F7: the exclusion list never claims something the server actually allows", async () => {
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  try {
    for (const combo of UNREACHABLE_COMBINATIONS) {
      await assert.rejects(
        () => m.dispatchStart({
          lane: combo.lane,
          prompt: "probe",
          readOnly: combo.readOnly,
          model: "gemini-3.6-flash-medium",
          worktree: combo.readOnly ? undefined : `clanker/claim-${combo.lane}`,
        }),
        /reconnaissance-only|prohibited|rejects/,
        `'${combo.reason}' is claimed but not enforced`,
      );
    }
  } finally {
    await m.shutdown();
  }
});

// ---- carried over from the first revision ----------------------------------

test("#19-4: two profiles with different turnTimeoutMs take effect differently", async () => {
  const recon = getProfile("gemini-recon");
  const review = getProfile("codex-review");
  assert.notEqual(recon.turnTimeoutMs, review.turnTimeoutMs, "the registry must actually differentiate the ceilings");

  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  try {
    const a = await m.dispatchProfile({ profile: "gemini-recon", prompt: "survey", cwd: os.tmpdir() });
    const b = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: os.tmpdir() });
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

test("#19-5: profile dispatches still hit the manager's own write-isolation gate", async () => {
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  try {
    await assert.rejects(
      () => m.dispatchStart({ lane: "codex", prompt: "do work", readOnly: false }),
      /must run in an isolated worktree/,
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
    if (!resolved.readOnly) assert.ok(resolved.worktree, `${profile.id} is write-capable and must carry a worktree`);
    // A codex read-only profile must not weld a write-capable sandbox, or the
    // manager's writeCapableSandbox rule would demand isolation it may not have.
    if (resolved.readOnly && resolved.lane === "codex") {
      assert.equal(resolved.sandbox, "read-only", `${profile.id} would trip writeCapableSandbox`);
    }
    // The manager's rule, consulted rather than restated: a write may omit the
    // model only on a lane whose backend pins a load-bearing default. A second
    // literal list here would go green while the manager rejected the dispatch.
    if (!resolved.readOnly && !LANES_WITH_PINNED_WRITE_MODEL.has(resolved.lane)) {
      assert.ok(resolved.model?.trim(), `${profile.id} must carry an explicit model`);
    }
    if (resolved.lane === "gemini") assert.equal(resolved.readOnly, true);
    assert.ok(LANE_NAMES.includes(resolved.lane));
  }
});

test("#19-6: every profile description states its welded capabilities and its deadline", () => {
  const tools = captureTools(recordingManager("standalone"));
  for (const profile of DISPATCH_PROFILES) {
    const description = tools.get(`clanker_start_${profile.id}`)!.config.description ?? "";
    assert.match(description, new RegExp(`lane=${profile.lane}`));
    assert.match(description, new RegExp(`read_only=${profile.readOnly}`));
    assert.match(description, new RegExp(`Isolation: ${profile.isolation}`));
    assert.match(description, /Hard turn ceiling: \d+ minutes/);
    if (profile.secrets.length) assert.match(description, /tachi vault exec/);
    if (profile.status === "dormant") assert.match(description, /DORMANT/);
  }
});
