/**
 * #37 C1 — dispatch-guard ordering (issue #35's telemetry stub + the
 * "no orphan worktree on rejection" invariant).
 *
 * Before this fix, `mkdirSync(runDir)` and `createWorktree` both ran BEFORE
 * `resolveSpec` — the function that carries every lane-specific fail-closed
 * gate (opencode requires an explicit model, gemini's own rules, sandbox
 * validation). A dispatch resolveSpec rejected could already have a REAL
 * worktree on disk with nothing tracking it, and the run directory it did
 * leave behind carried no signal at all — not even that the attempt had
 * happened.
 *
 * The fix reorders to: pure validation -> mkdir(runDir) + telemetry stub ->
 * resolveSpec -> createWorktree, and on a resolveSpec/createWorktree
 * rejection, closes out the stub with `terminal_at`/`error`/
 * `terminal_reason: "rejected"` instead of leaving it an empty shell.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import type { SpecResolver } from "../src/manager.js";
import { dropMutant, fakeResolver, loadMutantManager, until, worktreesForBranch } from "./helpers.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function makeBaseRepo(): { base: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-order-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["clone", origin, base]);
  return { base, root };
}

test("C1: a resolveSpec rejection (opencode, no model) leaves a closed-out telemetry stub and never creates the worktree", async () => {
  const repo = makeBaseRepo();
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-"));
  // Deliberately no `resolveSpec` override: the real backends.ts buildSpawnSpec
  // is what carries the "opencode requires an explicit model" fail-closed gate.
  const m = new LaneManager({ disableReaper: true, baseRepo: repo.base, runsRoot });
  const branch = `clanker/guard-reject-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "opencode",
          prompt: "no model supplied",
          cwd: repo.base,
          readOnly: true,
          worktree: branch,
        }),
      /opencode lane requires an explicit model id/,
    );

    const entries = fs.readdirSync(runsRoot);
    assert.equal(entries.length, 1, `expected exactly one run dir stub, found: ${JSON.stringify(entries)}`);
    const runDir = path.join(runsRoot, entries[0]);
    const telemetryPath = path.join(runDir, "telemetry.json");
    assert.ok(fs.existsSync(telemetryPath), "a rejected dispatch must still leave a readable telemetry stub");
    const stub = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.equal(stub.lane, "opencode");
    assert.ok(stub.created_at, "the stub must carry created_at from before the rejection");
    assert.ok(stub.terminal_at, "the stub must be closed out with terminal_at on rejection");
    assert.match(stub.error ?? "", /opencode lane requires an explicit model id/);
    assert.equal(stub.terminal_reason, "rejected");

    assert.deepEqual(
      worktreesForBranch(branch),
      [],
      "resolveSpec's rejection must fire before createWorktree ever runs — no orphan worktree",
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("C1: a successful dispatch has a telemetry.json with created_at before the connection even starts", async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-ok-"));
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: os.tmpdir(), runsRoot });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "hello", cwd: os.tmpdir(), readOnly: true });
    const telemetryPath = path.join(runsRoot, id, "telemetry.json");
    const immediate = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.ok(immediate.created_at, "the telemetry stub must exist with created_at before spawn/connect completes");
    assert.equal(immediate.host, "standalone");
    assert.equal(immediate.lane, "codex");
    // #32: the stub names its owner from the very first write — a dispatch
    // that dies before a worker exists still has to say whose session it was.
    assert.equal(immediate.server_pid, process.pid);

    await until(() => m.status(id).status !== "running");
    const final = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.ok(final.created_at, "run.persistTelemetry()'s overwrite must still carry a created_at field");
    assert.equal(final.lane, "codex");
  } finally {
    await m.shutdown();
  }
});

// ---------------------------------------------------------------------------
// #46 — one field, one namespace.
//
// The stub used to write `profileId: profile`, where `profile` is the OPENCODE
// AGENT profile (`worker` / `kimi-crew`, types.ts LaneRequestOptions), while
// every other surface that says `profileId` — LaneRun.profileId, the #27 issue
// comment's byline, MintedCapabilities — means the REGISTRY DISPATCH PROFILE
// (`oc-write`, `codex-review`, profiles.ts). Same name, two namespaces, and the
// stub is the ONLY record a dispatch that dies in the startup window ever
// leaves, so the one reader with nothing else to go on was the one being lied
// to: an `oc-write` run's stub said `worker`.
//
// The right value is available where the bug was, which is why the write is not
// deferred instead: dispatchProfile resolves the registry row BEFORE
// dispatchStartInternal is entered and hands the id over as a minted
// capability, so the stub can write the true value at the very first write
// without moving that write later — which would give back exactly the
// startup-window coverage #35 exists for.
// ---------------------------------------------------------------------------

/**
 * Read `telemetry.json` from INSIDE the injected SpecResolver — the one point
 * that is provably the stub stage: `dispatchStartInternal` calls it after
 * `writeTelemetryStub` and before any LaneRun exists, and it is handed the
 * run directory to read.
 *
 * Reading the file after the dispatch call RETURNS does not observe the stub at
 * all, which is worth stating because it looks like it does: the drive is
 * started synchronously and `beginTurn()` calls `persistTelemetry()`
 * (run.ts:363) before it awaits anything, so by the time the caller is resumed
 * the file is already a full RunTelemetry. Every key the older test on this
 * page checks (`host`, `lane`, `server_pid`, `created_at`) exists in BOTH
 * shapes, which is why nothing noticed — and `oc_profile`, which exists only in
 * the stub, is what made it visible here.
 */
function stubCapture(): { resolveSpec: SpecResolver; captured: () => Record<string, unknown> } {
  let seen: Record<string, unknown> | undefined;
  return {
    resolveSpec: (lane, opts, runDir) => {
      seen = JSON.parse(fs.readFileSync(path.join(runDir, "telemetry.json"), "utf8")) as Record<string, unknown>;
      return fakeResolver(lane, opts, runDir);
    },
    captured: () => {
      assert.ok(seen, "resolveSpec never ran, so nothing observed the stub stage");
      return seen;
    },
  };
}

/**
 * Dispatch a read-only registry profile in place and hand back the stub as it
 * stood before any LaneRun existed. Takes the LaneManager class so the same
 * probe can be pointed at a mutant.
 */
async function readProfileStub(Manager: typeof LaneManager): Promise<Record<string, unknown>> {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-profile-"));
  const capture = stubCapture();
  const m = new Manager({ resolveSpec: capture.resolveSpec, disableReaper: true, baseRepo: os.tmpdir(), runsRoot });
  try {
    await m.dispatchProfile({ profile: "codex-review", prompt: "review this", cwd: os.tmpdir() });
    return capture.captured();
  } finally {
    await m.shutdown();
  }
}

/** The claim itself, factored out so a mutant can be required to break it. */
function assertStubNamesTheRegistryProfile(stub: Record<string, unknown>): void {
  assert.equal(
    stub.profile_id,
    "codex-review",
    "the stub must name the REGISTRY profile id — the same value the #27 issue comment prints — " +
      `not the OpenCode agent profile; got ${JSON.stringify(stub.profile_id)}`,
  );
  assert.equal(
    stub.oc_profile,
    "worker",
    "the OpenCode agent profile keeps its own key, under the name profiles.ts already uses for it",
  );
  assert.equal(
    "profileId" in stub,
    false,
    "the camelCase key that carried the wrong namespace must be gone, not kept alongside the right one",
  );
}

test("#46: the dispatch stub names the registry profile id, not the OpenCode agent profile", async () => {
  assertStubNamesTheRegistryProfile(await readProfileStub(LaneManager));
});

test("#46: a profile dispatch rejected in the startup window carries the registry id on its only record", async () => {
  // The #35 case exactly: the dispatch dies before a LaneRun ever exists, so
  // this stub is the entire durable account of it. `base` is resolved inside
  // the guarded block — after the stub write, before resolveSpec — so this
  // rejects without spawning anything or creating a worktree.
  const repo = makeBaseRepo();
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-reject-"));
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: repo.base, runsRoot });
  const branch = `clanker/guard-profile-reject-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await assert.rejects(
      () =>
        m.dispatchProfile({
          profile: "codex-write",
          prompt: "implement",
          cwd: repo.base,
          worktree: branch,
          base: "0000000000000000000000000000000000000000",
        }),
      /does not resolve to a commit/,
    );
    const entries = fs.readdirSync(runsRoot);
    assert.equal(entries.length, 1, `expected exactly one run dir stub, found: ${JSON.stringify(entries)}`);
    const stub = JSON.parse(fs.readFileSync(path.join(runsRoot, entries[0], "telemetry.json"), "utf8"));
    assert.equal(stub.terminal_reason, "rejected", "precondition: this dispatch died in the startup window");
    assert.equal(
      stub.profile_id,
      "codex-write",
      "a run that never reached a LaneRun still has to say which seat shape it was",
    );
    assert.equal(stub.oc_profile, "worker");
    assert.deepEqual(worktreesForBranch(branch), [], "the base rejection must fire before createWorktree");
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#46: a direct dispatchStart mints no profile id — absent, never the agent profile's name", async () => {
  // The semantics this pins, stated once for every surface that carries the
  // field: `profile_id` present <=> the run was minted by the profile
  // entrance. Absent means "no registry profile", which is already what
  // LaneRun.profileId and the issue comment's `lane / profileId` fallback
  // mean. A direct dispatchStart mints no capability, and an id is one, so it
  // must not acquire one by having its agent profile renamed into that slot.
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-direct-"));
  const capture = stubCapture();
  const m = new LaneManager({ resolveSpec: capture.resolveSpec, disableReaper: true, baseRepo: os.tmpdir(), runsRoot });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "hello", cwd: os.tmpdir(), readOnly: true });
    const stub = capture.captured();
    assert.equal("profile_id" in stub, false, "no registry row minted this run, so there is no id to report");
    assert.equal(stub.oc_profile, "worker", "the agent profile is still recorded — under its own name");

    // And it stays absent through the overwrite, so "no profile" reads the
    // same at every point in the file's life.
    await until(() => m.status(id).status !== "running");
    const final = JSON.parse(fs.readFileSync(path.join(runsRoot, id, "telemetry.json"), "utf8"));
    assert.equal("profile_id" in final, false);
  } finally {
    await m.shutdown();
  }
});

test("#46: a kimi-crew dispatchStart records the agent profile under oc_profile and still mints no id", async () => {
  // kimi-crew is the one agent profile reachable WITHOUT the registry, so it is
  // the case where `oc_profile` is the only thing beyond the lane that says what
  // was asked for — and the case the old field name made unreadable, since
  // `profileId: "kimi-crew"` sat in the very slot an `oc-kimi-crew` id would.
  const repo = makeBaseRepo();
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-crew-"));
  const m = new LaneManager({ resolveSpec: fakeResolver, disableReaper: true, baseRepo: repo.base, runsRoot });
  const branch = `clanker/guard-crew-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await assert.rejects(
      () =>
        m.dispatchStart({
          lane: "opencode",
          profile: "kimi-crew",
          prompt: "implement and review",
          cwd: repo.base,
          worktree: branch,
          base: "0000000000000000000000000000000000000000",
        }),
      /does not resolve to a commit/,
    );
    const entries = fs.readdirSync(runsRoot);
    assert.equal(entries.length, 1, `expected exactly one run dir stub, found: ${JSON.stringify(entries)}`);
    const stub = JSON.parse(fs.readFileSync(path.join(runsRoot, entries[0], "telemetry.json"), "utf8"));
    assert.equal(stub.oc_profile, "kimi-crew");
    assert.equal(
      "profile_id" in stub,
      false,
      "the direct entrance mints no registry id, whatever agent profile it names",
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#46: the registry id survives persistTelemetry's whole-file overwrite", async () => {
  // `persistTelemetry()` rewrites telemetry.json with `run.telemetry()` — no
  // merge — so a key the stub wrote and RunTelemetry does not restate is gone
  // from disk at the first turn. Before this change the identity vanished
  // there, leaving a reader unable to tell "this run had no profile" from
  // "this run had one and we dropped it": the same ambiguity as the namespace
  // collision, on the time axis instead of the name axis.
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-survive-"));
  const capture = stubCapture();
  const m = new LaneManager({ resolveSpec: capture.resolveSpec, disableReaper: true, baseRepo: os.tmpdir(), runsRoot });
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review this", cwd: os.tmpdir() });
    const telemetryPath = path.join(runsRoot, id, "telemetry.json");
    assert.equal(capture.captured().profile_id, "codex-review", "precondition: the stub wrote the id in the first place");
    await until(() => m.status(id).status !== "running");
    const final = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.equal(
      final.profile_id,
      "codex-review",
      "the terminal record must still name the seat shape the stub named — one field, one meaning, whole file life",
    );
    assert.ok(final.terminal_at, "precondition: this record was rewritten by run.persistTelemetry()");
  } finally {
    await m.shutdown();
  }
});

test("#46 mutation: each half of the fix, broken, turns its own assertion red", async () => {
  // 1. The bug itself, restored: the stub puts the agent profile back into the
  //    id's slot.
  const { LaneManager: PutBack } = await loadMutantManager("i46-stub-writes-agent-profile", [{
    file: "manager.ts",
    find: "      ...(minted.profileId !== undefined ? { profile_id: minted.profileId } : {}),\n      oc_profile: profile,",
    replace: "      profile_id: profile,\n      oc_profile: profile,",
  }]);
  const putBack = await readProfileStub(PutBack);
  assert.equal(putBack.profile_id, "worker", "precondition: the mutant really did restore the old value");
  assert.throws(
    () => assertStubNamesTheRegistryProfile(putBack),
    /must name the REGISTRY profile id/,
    "the stub-stage test does not observe which namespace the field holds",
  );
  dropMutant("i46-stub-writes-agent-profile");

  // 2. The agent profile welded to the default: a kimi-crew dispatch would
  //    report itself as an ordinary worker. codex-review's agent profile is
  //    "worker" either way, so this mutant is only observable through the
  //    kimi-crew dispatch — which is why that test exists separately.
  const { LaneManager: Welded } = await loadMutantManager("i46-oc-profile-welded", [{
    file: "manager.ts",
    find: "      oc_profile: profile,",
    replace: '      oc_profile: "worker",',
  }]);
  const weldedRunsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-crew-mut-"));
  const weldedRepo = makeBaseRepo();
  const weldedManager = new Welded({
    resolveSpec: fakeResolver, disableReaper: true, baseRepo: weldedRepo.base, runsRoot: weldedRunsRoot,
  });
  try {
    await assert.rejects(() =>
      weldedManager.dispatchStart({
        lane: "opencode",
        profile: "kimi-crew",
        prompt: "implement and review",
        cwd: weldedRepo.base,
        worktree: `clanker/guard-crew-mut-${Math.random().toString(36).slice(2, 8)}`,
        base: "0000000000000000000000000000000000000000",
      }));
    const entries = fs.readdirSync(weldedRunsRoot);
    const stub = JSON.parse(fs.readFileSync(path.join(weldedRunsRoot, entries[0], "telemetry.json"), "utf8"));
    assert.equal(
      stub.oc_profile,
      "worker",
      "mutant: the kimi-crew stub now lies about which agent profile was asked for — the test above goes red on exactly this",
    );
  } finally {
    await weldedManager.shutdown();
    fs.rmSync(weldedRepo.root, { recursive: true, force: true });
    dropMutant("i46-oc-profile-welded");
  }

  // 3. The carry-forward dropped: the id exists in the stub and disappears at
  //    the first turn, which is the state this change ended.
  const { LaneManager: Dropped } = await loadMutantManager("i46-terminal-drops-profile-id", [{
    file: "run.ts",
    find: "      ...(this.profileId !== undefined ? { profile_id: this.profileId } : {}),\n",
    replace: "",
  }]);
  const droppedRunsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-guard-runs-dropped-"));
  const droppedCapture = stubCapture();
  const droppedManager = new Dropped({
    resolveSpec: droppedCapture.resolveSpec, disableReaper: true, baseRepo: os.tmpdir(), runsRoot: droppedRunsRoot,
  });
  try {
    const { id } = await droppedManager.dispatchProfile({ profile: "codex-review", prompt: "review this", cwd: os.tmpdir() });
    const telemetryPath = path.join(droppedRunsRoot, id, "telemetry.json");
    assert.equal(
      droppedCapture.captured().profile_id,
      "codex-review",
      "the stub half is untouched by this mutation",
    );
    await until(() => droppedManager.status(id).status !== "running");
    const final = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    assert.equal(
      "profile_id" in final,
      false,
      "mutant: the overwrite drops the identity again — the survival test goes red on exactly this",
    );
  } finally {
    await droppedManager.shutdown();
    dropMutant("i46-terminal-drops-profile-id");
  }
});
