/**
 * The cursor lane's correction turn: `--resume`, and a model hand-off with it
 * (#43).
 *
 * The measured fact this whole path rests on (2026-07-28, cursor-agent
 * 2026.07.23-e383d2b): `cursor-agent -p --resume <session_id> --model <another
 * model>` continues the SAME conversation — composer-2.5 was told a passphrase,
 * and cursor-grok-4.5-high, resuming that session, answered with it. Context
 * inheritance is the CLI's job and is not re-tested here; what is tested is
 * everything Clanker must get right for that CLI call to happen at all:
 *
 *  1. the session id makes it from the sidecar's event stream, through the run,
 *     onto telemetry (`lane_session_ref`) — a lane-neutral field, not a cursor
 *     one;
 *  2. a correction turn re-spawns the lane with `--resume <that id>` and the
 *     newly named model, and with the ORIGINAL read/write boundary intact;
 *  3. lanes without the capability keep the old refusal, and every way this can
 *     fail (no ref recorded, worktree already reclaimed, a flag-shaped ref)
 *     fails loudly instead of silently starting a worker with no memory.
 *
 * The fake `cursor-agent` here appends its argv to a capture file per
 * invocation, so "what the second spawn really asked for" is read off the same
 * surface the real CLI would see — not off the spec object that built it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSpawnSpec } from "../src/backends.js";
import { LANES_WITH_RESUME } from "../src/constants.js";
import { LANE_SESSION_META_KEY } from "../src/lane-session.js";
import { LaneManager } from "../src/manager.js";
import { planResumeTurn } from "../src/resume.js";
import type { LaneName, LaneRequestOptions, SpawnSpec } from "../src/types.js";
import { dropMutant, fakeSpec, loadMutantManager, materializeMutant, until } from "./helpers.js";

const FIRST_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const RESUMED_SESSION = "bbbbbbbb-5555-6666-7777-888888888888";

const TSX = path.resolve("node_modules/tsx/dist/esm/index.mjs");
const SIDECAR = path.resolve("src/cursor-acp.ts");

/**
 * A stand-in `cursor-agent` that appends its argv (NUL-terminated record) to
 * `$CLANKER_CURSOR_CAPTURE` and then emits a minimal but real stream-json turn.
 *
 * It reports a DIFFERENT session id once `--resume` is present, which is how
 * the "freshest reported id wins" rule below is observed: whether the real CLI
 * keeps or forks the id on resume has not been measured, and Clanker must be
 * correct either way.
 *
 * @param touch relative path the agent creates in its cwd, so a write run's
 *   worktree is dirty enough to survive the close (a clean one is reclaimed).
 */
function fakeCursorAgent(touch?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-resume-agent-"));
  const executable = path.join(dir, "cursor-agent");
  const script = [
    "#!/bin/sh",
    `{ printf '%s\\n' "$@"; printf '\\0'; } >> "$CLANKER_CURSOR_CAPTURE"`,
    `SID="${FIRST_SESSION}"`,
    `MSG="first turn"`,
    `for arg in "$@"; do if [ "$arg" = "--resume" ]; then RESUMED=1; fi; done`,
    `if [ -n "$RESUMED" ]; then SID="${RESUMED_SESSION}"; MSG="resumed turn"; fi`,
    ...(touch ? [`: > "${touch}"`] : []),
    "cat <<EOF",
    `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"$SID","model":"Composer 2.5","permissionMode":"default"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"$MSG"}]},"session_id":"$SID"}`,
    `{"type":"result","subtype":"success","duration_ms":10,"is_error":false,"result":"$MSG","session_id":"$SID","request_id":"req","usage":{"inputTokens":1,"outputTokens":1}}`,
    "EOF",
  ].join("\n");
  fs.writeFileSync(executable, `${script}\n`, { mode: 0o755 });
  return executable;
}

/** A fake whose init/result lines carry the given session id verbatim (or none at all). */
function fakeCursorAgentReporting(sessionField: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-resume-agent-odd-"));
  const executable = path.join(dir, "cursor-agent");
  fs.writeFileSync(
    executable,
    [
      "#!/bin/sh",
      `{ printf '%s\\n' "$@"; printf '\\0'; } >> "$CLANKER_CURSOR_CAPTURE"`,
      "cat <<'EOF'",
      `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp"${sessionField},"model":"Composer 2.5","permissionMode":"default"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}`,
      `{"type":"result","subtype":"success","duration_ms":10,"is_error":false,"result":"done","request_id":"req","usage":{"inputTokens":1,"outputTokens":1}}`,
      "EOF",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

/**
 * Resolve the REAL cursor spawn spec (so backends.ts's env wiring is exercised,
 * `resumeRef` included) and then point the command at the source sidecar with
 * the fake CLI underneath it.
 */
function cursorResolver(agent: string, capture: string) {
  return (lane: LaneName, opts: LaneRequestOptions, runDir: string): SpawnSpec => {
    const spec = buildSpawnSpec(lane, opts, runDir);
    return {
      command: process.execPath,
      args: ["--import", TSX, SIDECAR],
      env: { ...spec.env, CLANKER_CURSOR_AGENT_PATH: agent, CLANKER_CURSOR_CAPTURE: capture },
      warnings: spec.warnings,
    };
  };
}

/** One argv record per fake-CLI invocation, in order. */
function argvBlocks(capture: string): string[][] {
  if (!fs.existsSync(capture)) return [];
  return fs
    .readFileSync(capture, "utf8")
    .split("\0")
    .filter((block) => block.trim() !== "")
    .map((block) => block.split("\n"));
}

/** The token following `flag` in one argv record, or undefined when absent. */
function flagValue(block: string[], flag: string): string | undefined {
  const at = block.indexOf(flag);
  return at < 0 ? undefined : block[at + 1];
}

function tmpCapture(tag: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `clanker-resume-${tag}-`)), "argv");
}

/** A repo with an origin, so worktree dispatches have a real base to cut from. */
function makeRepo(): { base: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-resume-repo-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
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

const terminal = (m: LaneManager, id: string) => until(() => m.status(id).status !== "running", 20_000);

// ---- 1. the projection chain: sidecar -> run -> telemetry --------------------

test("the backend session id reaches telemetry as a lane-neutral field, not a cursor-shaped one", async () => {
  const repo = makeRepo();
  const capture = tmpCapture("chain");
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent(), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review this", cwd: repo.base });
    await terminal(m, id);
    const status = m.status(id);
    assert.equal(status.status, "done");
    assert.equal(status.telemetry?.lane_session_ref, FIRST_SESSION, "the run must carry the id the lane reported");

    // On disk too: telemetry.json is what a later process (or a foreign-run
    // scan) reads, and an id that lives only in memory is not addressable.
    const persisted = JSON.parse(fs.readFileSync(path.join(status.run_dir, "telemetry.json"), "utf8"));
    assert.equal(persisted.lane_session_ref, FIRST_SESSION);

    // ...and the raw event that carried it names the lane-NEUTRAL key. A run
    // reading `clanker.cursor` instead would have to learn one vendor's field
    // names to resume any lane.
    const events = fs.readFileSync(path.join(status.run_dir, "events.jsonl"), "utf8");
    assert.ok(events.includes(LANE_SESSION_META_KEY), "the neutral _meta key must be on the wire");
    assert.ok(events.includes(FIRST_SESSION));

    // The first spawn carries no --resume: there was nothing to resume.
    const blocks = argvBlocks(capture);
    assert.equal(blocks.length, 1, "one turn, one CLI invocation");
    assert.equal(flagValue(blocks[0], "--resume"), undefined);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- 2. the correction turn ------------------------------------------------

test("a cursor correction re-spawns with --resume and the newly named model, keeping the read-only boundary", async () => {
  const repo = makeRepo();
  const capture = tmpCapture("swap");
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent(), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review this", cwd: repo.base });
    await terminal(m, id);
    // The session is CLOSED by now — an unsupervised run closes on its terminal
    // turn. That is exactly the state this path exists to be usable in.
    assert.equal(m.list().some((entry) => entry.id === id), false, "the session really closed after turn 1");

    const accepted = await m.promptExisting(id, "you missed the error path; look again", true, "grok");
    assert.equal(accepted.status, "running", "the correction must report running before its worker is up");
    await terminal(m, id);

    const blocks = argvBlocks(capture);
    assert.equal(blocks.length, 2, "the correction is a second CLI invocation, not a prompt on the old one");
    assert.equal(flagValue(blocks[1], "--resume"), FIRST_SESSION, "it resumes the conversation turn 1 opened");
    assert.equal(flagValue(blocks[1], "--model"), "cursor-grok-4.5-high", "the alias resolves on the way out");
    // The hand-off must not widen anything: this run was read-only, so the
    // respawn is still cursor's own read-only mode with its sandbox on.
    assert.equal(flagValue(blocks[1], "--mode"), "ask");
    assert.equal(flagValue(blocks[1], "--sandbox"), "enabled");
    assert.equal(blocks[1].includes("--force"), false, "a read-only run must not come back write-capable");

    const telemetry = m.status(id).telemetry!;
    assert.equal(telemetry.turns, 2);
    assert.equal(telemetry.corrections, 1, "counted as a correction");
    assert.equal(telemetry.continuation_turns, 1);
    // The model the turn ACTUALLY ran on, not the dispatch's — otherwise
    // resolved_model would disagree with observed_model and a deliberate
    // hand-off would read as the silent-swap alarm (#25).
    assert.equal(telemetry.requested_model, "grok");
    assert.equal(telemetry.resolved_model, "cursor-grok-4.5-high");
    // The freshest id the lane reported wins, so a CLI that forks the chat on
    // resume stays resumable from the turn that just ran.
    assert.equal(telemetry.lane_session_ref, RESUMED_SESSION);

    // result.md holds the CORRECTED verdict, and the ledger still has one row.
    const result = fs.readFileSync(path.join(m.status(id).run_dir, "result.md"), "utf8");
    assert.match(result, /resumed turn/);
    assert.doesNotMatch(result, /## final_message\n\nfirst turn/);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a write run resumes as a write run, in the same worktree", async () => {
  const repo = makeRepo();
  const capture = tmpCapture("write");
  // The agent leaves a file behind, so the tree is dirty and survives close —
  // the state a correction turn actually happens in.
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent("resume-artifact.txt"), capture),
  });
  try {
    const { id } = await m.dispatchProfile({
      profile: "cursor-write",
      prompt: "implement",
      cwd: repo.base,
      worktree: `clanker/resume-write-${process.pid}-${Date.now()}`,
    });
    await terminal(m, id);
    const worktree = m.status(id).worktree!;
    assert.ok(fs.existsSync(path.join(worktree, "resume-artifact.txt")), "turn 1 left work in the tree");

    await m.promptExisting(id, "commit what you left uncommitted", true);
    await terminal(m, id);

    const blocks = argvBlocks(capture);
    assert.equal(blocks.length, 2);
    assert.equal(flagValue(blocks[1], "--resume"), FIRST_SESSION);
    assert.ok(blocks[1].includes("--force"), "a write run's correction stays write-capable");
    assert.equal(flagValue(blocks[1], "--mode"), undefined, "and never picks up a read-only execution mode");
    // No model named -> the run keeps the one it was dispatched with.
    assert.equal(flagValue(blocks[1], "--model"), "composer-2.5");
    assert.equal(m.status(id).worktree, worktree, "the correction runs in the same tree, not a new one");
    assert.equal(m.status(id).telemetry?.corrections, 1);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// ---- 3. the refusals -------------------------------------------------------

test("a lane with no backend resume keeps the supervised-only refusal, and refuses a model swap outright", async () => {
  const repo = makeRepo();
  const m = new LaneManager({ disableReaper: true, baseRepo: repo.base, resolveSpec: () => fakeSpec() });
  try {
    const codex = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: repo.base });
    await terminal(m, codex.id);
    await assert.rejects(
      () => m.promptExisting(codex.id, "steer this", true),
      /not started from a supervised profile/,
      "the pre-existing gate must be untouched for lanes that cannot resume",
    );

    // A supervised run CAN be corrected — but not onto another model: its
    // worker is a live session that was spawned on one.
    const glm = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "implement",
      worktree: `clanker/resume-refuse-${process.pid}-${Date.now()}`,
    });
    await terminal(m, glm.id);
    await assert.rejects(
      () => m.promptExisting(glm.id, "switch models", true, "grok"),
      /continues a LIVE session|cannot be swapped/,
    );
    // ...and without the model it is still the ordinary supervised correction.
    await m.promptExisting(glm.id, "fix the scope", true);
    await terminal(m, glm.id);
    assert.equal(m.status(glm.id).telemetry?.corrections, 1);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a cursor run whose lane never reported a session ref refuses the correction instead of starting fresh", async () => {
  const repo = makeRepo();
  const capture = tmpCapture("noref");
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    // An init event with no session_id at all: the honest shape of a backend
    // that never told us which conversation this was.
    resolveSpec: cursorResolver(fakeCursorAgentReporting(""), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review", cwd: repo.base });
    await terminal(m, id);
    assert.equal(m.status(id).telemetry?.lane_session_ref, undefined);
    await assert.rejects(
      () => m.promptExisting(id, "try again", true),
      /no backend session ref recorded/,
      "a correction with nothing to resume must refuse, not silently run a memoryless worker",
    );
    assert.equal(argvBlocks(capture).length, 1, "and no second worker was spawned");
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a reclaimed worktree makes the correction refuse by name, not by spawn failure", async () => {
  const repo = makeRepo();
  const capture = tmpCapture("gone");
  // No `touch`: the tree is clean at close, so removeIfClean reclaims it.
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent(), capture),
  });
  try {
    const { id } = await m.dispatchProfile({
      profile: "cursor-write",
      prompt: "implement",
      cwd: repo.base,
      worktree: `clanker/resume-gone-${process.pid}-${Date.now()}`,
    });
    await terminal(m, id);
    assert.equal(fs.existsSync(m.status(id).cwd), false, "the clean tree was reclaimed on close");
    await assert.rejects(
      () => m.promptExisting(id, "keep going", true),
      /no longer exists/,
      "the refusal must name the reclaimed tree, not surface as an ENOENT from a spawn",
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a flag-shaped session ref is refused synchronously, and never reaches the CLI", async () => {
  // The ref comes from the BACKEND's event stream — the one input this side
  // does not control — so the guard has to hold for it exactly as it does for
  // a caller-named model.
  //
  // The refusal MOVED (Scope-B review, gemini-ccfb4): it used to happen inside
  // the sidecar's argv gate, which meant the run was re-opened and published as
  // `running` before flipping to `error`, so a caller polling that id watched a
  // turn start and die for a reason the synchronous call could have stated
  // outright. The sidecar gate remains as the last line; this asserts the first
  // one — and still asserts what the old test's strongest claim was: the
  // poisoned argv is never handed to cursor-agent.
  const repo = makeRepo();
  const capture = tmpCapture("flagref");
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgentReporting(`,"session_id":"--force"`), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review", cwd: repo.base });
    await terminal(m, id);
    assert.equal(m.status(id).telemetry?.lane_session_ref, "--force");
    const before = m.status(id).status;
    await assert.rejects(
      () => m.promptExisting(id, "resume with the poisoned ref", true),
      /starts with '-'|would reach the backend as a flag/,
    );
    assert.equal(m.status(id).status, before, "a refused correction must not have re-opened the run");
    assert.equal(argvBlocks(capture).length, 1, "the poisoned argv was never handed to cursor-agent");
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("planResumeTurn carries the run's own contract forward and refuses an empty model", () => {
  const run = {
    id: "cursor-x",
    lane: "cursor" as const,
    cwd: os.tmpdir(),
    requestOpts: { readOnly: true, model: "composer", profile: "worker" as const },
    laneSessionRef: `  ${FIRST_SESSION}  `,
  };
  const plan = planResumeTurn(run, "grok");
  assert.equal(plan.ref, FIRST_SESSION, "a padded ref is trimmed, never passed through as-is");
  assert.equal(plan.requestOpts.resumeRef, FIRST_SESSION);
  assert.equal(plan.requestOpts.model, "grok");
  assert.equal(plan.requestOpts.readOnly, true, "the run's write boundary carries forward untouched");
  assert.equal(planResumeTurn(run).requestOpts.model, "composer", "no override keeps the dispatch's model");
  assert.throws(() => planResumeTurn(run, "   "), /cannot be empty/);
  assert.throws(
    () => planResumeTurn({ ...run, lane: "codex" as const }),
    /no backend resume capability/,
  );
  assert.deepEqual([...LANES_WITH_RESUME], ["cursor"], "the capability table is the single source for this");
});

// ---- 4. mutation self-checks ------------------------------------------------
// Each mutation breaks exactly one thing the assertions above claim to observe.

test("mutation: an empty capability table sends cursor back to the supervised-only refusal", async () => {
  // Proves the routing really reads the table rather than the lane name being
  // resume-capable by coincidence of some other check.
  const { LaneManager: Mutant } = await loadMutantManager("resume-capability-empty", [{
    file: "constants.ts",
    find: `export const LANES_WITH_RESUME: ReadonlySet<string> = new Set(["cursor"]);`,
    replace: `export const LANES_WITH_RESUME: ReadonlySet<string> = new Set([]);`,
  }]);
  const repo = makeRepo();
  const capture = tmpCapture("mutant-caps");
  const m = new Mutant({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent(), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review", cwd: repo.base });
    await until(() => m.status(id).status !== "running", 20_000);
    await assert.rejects(
      () => m.promptExisting(id, "correct", true, "grok"),
      /not started from a supervised profile|continues a LIVE session/,
      "with an empty table the cursor correction must fall back to the old refusal",
    );
    assert.equal(argvBlocks(capture).length, 1);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
    dropMutant("resume-capability-empty");
  }
});

test("mutation: dropping the --resume argument makes the second spawn a memoryless worker", async () => {
  const root = materializeMutant("resume-arg-dropped", [{
    file: "cursor-acp.ts",
    find: `    args.push("--resume", resumeRef);`,
    replace: `    // mutant: the ref is validated and then thrown away`,
  }]);
  const repo = makeRepo();
  const capture = tmpCapture("mutant-arg");
  const mutantSidecar = path.join(root, "src", "cursor-acp.ts");
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: (lane, opts, runDir) => {
      const spec = cursorResolver(fakeCursorAgent(), capture)(lane, opts, runDir);
      return { ...spec, args: ["--import", TSX, mutantSidecar] };
    },
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review", cwd: repo.base });
    await terminal(m, id);
    await m.promptExisting(id, "correct", true);
    await terminal(m, id);
    const blocks = argvBlocks(capture);
    assert.equal(blocks.length, 2, "the mutant still spawns a second worker — it just forgets why");
    assert.equal(
      flagValue(blocks[1], "--resume"),
      undefined,
      "the mutant must really drop the flag, or it proves nothing",
    );
    // Which is exactly what the real assertion catches.
    assert.throws(() => assert.equal(flagValue(blocks[1], "--resume"), FIRST_SESSION));
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
    dropMutant("resume-arg-dropped");
  }
});

test("mutation: a run that never records the reported ref cannot be corrected at all", async () => {
  const { LaneManager: Mutant } = await loadMutantManager("resume-ref-not-recorded", [{
    file: "run.ts",
    find: "    const ref = laneSessionRefFrom(meta);",
    replace: "    const ref = undefined as string | undefined; void laneSessionRefFrom(meta);",
  }]);
  const repo = makeRepo();
  const capture = tmpCapture("mutant-ref");
  const m = new Mutant({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent(), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review", cwd: repo.base });
    await until(() => m.status(id).status !== "running", 20_000);
    assert.equal(
      m.status(id).telemetry?.lane_session_ref,
      undefined,
      "the mutant must really lose the ref, or the projection assertion proves nothing",
    );
    await assert.rejects(() => m.promptExisting(id, "correct", true), /no backend session ref recorded/);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
    dropMutant("resume-ref-not-recorded");
  }
});

test("mutation: a resume turn that drops the run's write boundary is caught by the argv assertion", async () => {
  // The dangerous direction: a correction turn on a READ-ONLY run coming back
  // write-capable. The argv is where that would land, and where it is checked.
  const { LaneManager: Mutant } = await loadMutantManager("resume-boundary-widened", [{
    file: "resume.ts",
    find: "      ...run.requestOpts,",
    replace: "      ...run.requestOpts, readOnly: false,",
  }]);
  const repo = makeRepo();
  const capture = tmpCapture("mutant-boundary");
  const m = new Mutant({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent(), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review", cwd: repo.base });
    await until(() => m.status(id).status !== "running", 20_000);
    await m.promptExisting(id, "correct", true);
    await until(() => m.status(id).status !== "running", 20_000);
    const blocks = argvBlocks(capture);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[1].includes("--force"), "the mutant must really widen the boundary, or it proves nothing");
    assert.throws(() => assert.equal(blocks[1].includes("--force"), false));
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
    dropMutant("resume-boundary-widened");
  }
});


test("a resume turn that dies before the backend speaks does not report the PREVIOUS turn's model", async () => {
  // Scope-B review (gemini-ccfb4). `observed_model` exists to expose a backend
  // that silently ran something other than what was asked for (#25). On a lane
  // where every leg may name a different model, carrying the last leg's
  // observation into a leg that never got an init event is exactly the lie the
  // field is there to catch — it would read as "the swap took effect" when
  // nothing ran at all.
  const repo = makeRepo();
  const capture = tmpCapture("staleobs");
  const m = new LaneManager({
    disableReaper: true,
    baseRepo: repo.base,
    resolveSpec: cursorResolver(fakeCursorAgent(), capture),
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "cursor-review", prompt: "review", cwd: repo.base });
    await terminal(m, id);
    assert.ok(m.status(id).telemetry?.observed_model, "first turn observed a model");
    // Re-open the way a resume does, then read before any new init arrives.
    const run = (m as unknown as { runs: Map<string, { reopenForResume(): void }> }).runs.get(id)!;
    run.reopenForResume();
    assert.equal(
      m.status(id).telemetry?.observed_model ?? null,
      null,
      "the re-opened turn starts with no observation of its own",
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});
