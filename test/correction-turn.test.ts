/**
 * The supervised correction turn — 严父流.
 *
 * `clanker_prompt` existed in 0.2.x, was removed by 69988a3 when Clanker became
 * a thin one-shot job controller, and `plugin/agents/supervisor.md` went on
 * declaring it and instructing the seat to correct a drifting worker with it for
 * four more releases. The seat's only steering verb did not exist, and the
 * contract test of the day ASSERTED that it must be declared, so nothing could
 * catch it.
 *
 * Restoring it is not "add the tool back": the machinery survived (the session
 * outlives a terminal turn until the idle-TTL reaper, `beginTurn` already takes
 * a `correction` flag, telemetry already counts corrections and continuation
 * turns), but one invariant did NOT survive contact with a second terminal
 * transition — see the ledger test below.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { fakeSpec, until } from "./helpers.js";

function makeBaseRepo(): { base: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-correction-repo-"));
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

function makeManager(base: string): LaneManager {
  return new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: base });
}

/** Start the supervised profile and drive its first turn to terminal. */
async function startSupervised(m: LaneManager, tag: string): Promise<string> {
  const { id } = await m.dispatchProfile({
    profile: "oc-glm-write",
    prompt: "implement the frozen spec",
    worktree: `clanker/correction-${tag}-${Math.random().toString(36).slice(2, 8)}`,
  });
  await until(() => m.status(id).status !== "running", 6_000);
  return id;
}

const ledgerRowsFor = (id: string): unknown[] => {
  const file = path.join(process.env.CLANKER_LEDGER_DIR ?? "", "ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    // The row's id field is `label` (ledger.ts buildLedgerRow), not `id`.
    .map((line) => JSON.parse(line))
    .filter((row) => row.label === id);
};

test("a supervised run takes a correction turn and ends on the corrected verdict", async () => {
  const repo = makeBaseRepo();
  const m = makeManager(repo.base);
  try {
    const id = await startSupervised(m, "happy");
    assert.equal(m.status(id).telemetry?.corrections, 0, "no corrections before one is sent");

    await m.promptExisting(id, "you drifted: only touch src/", true);
    await until(() => m.status(id).status !== "running", 6_000);

    const telemetry = m.status(id).telemetry!;
    assert.equal(telemetry.corrections, 1, "the correction is counted as a correction");
    assert.equal(telemetry.continuation_turns, 1, "and as a continuation turn");
    assert.equal(telemetry.turns, 2);

    // result.md must hold the CORRECTED turn's verdict. The fake agent echoes
    // its prompt as the final message, so the corrected text is the discriminator:
    // a verdict file frozen at the first terminal transition would hand the lead
    // exactly the output the correction was issued to replace.
    const resultPath = path.join(m.status(id).run_dir, "result.md");
    const result = fs.readFileSync(resultPath, "utf8");
    assert.match(result, /you drifted: only touch src\//, "result.md holds the corrected turn's verdict");
    assert.doesNotMatch(result, /## final_message\n\nimplement the frozen spec/, "not the pre-correction verdict");
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a corrected run still writes exactly ONE ledger row", async () => {
  // The invariant that did not survive. "Once" used to be emergent: completeTurn
  // and failTurn both bail on an already-terminal run, so a one-shot controller
  // could only ever reach one terminal transition. A correction turn clears
  // terminalAt and reaches a second one — without an explicit guard every
  // supervised GLM write would have been double-counted in the ledger's stats,
  // and the ledger is the thing those stats are computed FROM.
  const repo = makeBaseRepo();
  const m = makeManager(repo.base);
  try {
    const id = await startSupervised(m, "ledger");
    assert.equal(ledgerRowsFor(id).length, 1, "the first terminal transition writes the row");

    await m.promptExisting(id, "correct yourself", true);
    await until(() => m.status(id).status !== "running", 6_000);

    assert.equal(m.status(id).telemetry?.turns, 2, "the correction really ran a second turn");
    assert.equal(ledgerRowsFor(id).length, 1, "a second terminal transition must NOT append a second row");
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("an unsupervised profile refuses a correction turn, server-side", async () => {
  // The capability is checked against the registry row that minted the run, not
  // against which tool the caller holds — so a seat file that drifts into
  // declaring clanker_prompt still cannot steer an unsupervised worker.
  const repo = makeBaseRepo();
  const m = makeManager(repo.base);
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: repo.base });
    await until(() => m.status(id).status !== "running", 6_000);
    await assert.rejects(
      () => m.promptExisting(id, "steer this read-only run", true),
      /not started from a supervised profile/,
    );
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a correction is refused while a turn is still running, and on an unknown id", async () => {
  const repo = makeBaseRepo();
  const m = makeManager(repo.base);
  try {
    const { id } = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "implement",
      worktree: `clanker/correction-busy-${Math.random().toString(36).slice(2, 8)}`,
    });
    // Deliberately NOT waiting for terminal: correction is turn-by-turn, and a
    // seat that fires one at a working agent must get a refusal rather than a
    // second concurrent turn on one session.
    await assert.rejects(() => m.promptExisting(id, "too early", true), /already running/);
    await until(() => m.status(id).status !== "running", 6_000);

    await assert.rejects(() => m.promptExisting("codex-nope", "no such run", true), /not found/);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("once the session is closed the correction window is gone, and says so", async () => {
  // The honest failure. A supervisor that deliberated past the idle-TTL must be
  // told the session is gone — not handed a silently respawned worker with no
  // memory of what it was being corrected about.
  const repo = makeBaseRepo();
  const m = makeManager(repo.base);
  try {
    const id = await startSupervised(m, "reaped");
    await m.close(id); // what the idle-TTL reaper does on a finished session
    await assert.rejects(() => m.promptExisting(id, "too late", true), /session for '.+' is (gone|already closed)/);
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});
