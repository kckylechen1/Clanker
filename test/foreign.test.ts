/**
 * Cross-process visibility (#32).
 *
 * The property under test is not "list returns more rows". It is that the two
 * kinds of absent stop rendering as the same answer:
 *
 *   - an id that never existed
 *   - an id that is running right now inside another session's server
 *
 * Both used to be `run '<id>' not found`, and the documented recovery for a
 * dropped relay re-dispatches when the lifecycle tools come back empty. So the
 * second case, rendered as the first, is how one frozen contract ends up with
 * two live workers both opening a PR.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { readForeignRun, scanForeignRuns } from "../src/foreign.js";
import { fakeSpec, until } from "./helpers.js";

const NOW = 1_800_000_000_000;

function makeRunsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clanker-foreign-"));
}

/** Write what another session's server would have left on disk. */
function writeRun(
  root: string,
  id: string,
  telemetry: Record<string, unknown>,
  extra: Record<string, string> = {},
): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify(telemetry));
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test("an in-flight foreign run is visible; a terminal one is not, by default", () => {
  const root = makeRunsRoot();
  writeRun(root, "opencode-live", { lane: "opencode", host: "claude", created_at: "x", terminal_at: null, turns: 1 });
  writeRun(root, "codex-done", { lane: "codex", host: "claude", created_at: "x", terminal_at: "y", terminal_reason: "done" });

  const inFlight = scanForeignRuns({ runsRoot: root, now: NOW });
  assert.deepEqual(inFlight.map((r) => r.id), ["opencode-live"], "a scan asks what is still in flight");

  const all = scanForeignRuns({ runsRoot: root, inFlightOnly: false, now: NOW });
  assert.deepEqual(all.map((r) => r.id).sort(), ["codex-done", "opencode-live"]);
});

test("runs this process owns are excluded — the live object beats its file", () => {
  const root = makeRunsRoot();
  writeRun(root, "opencode-mine", { lane: "opencode", terminal_at: null });
  writeRun(root, "opencode-theirs", { lane: "opencode", terminal_at: null });

  const found = scanForeignRuns({ runsRoot: root, exclude: new Set(["opencode-mine"]), now: NOW });
  assert.deepEqual(found.map((r) => r.id), ["opencode-theirs"]);
});

test("a directory with no telemetry is not reported as a run", () => {
  // #35's empty shells, and everything older than telemetry.json. Reconstructing
  // a job from a directory NAME would put something on the orphan board that may
  // never have spawned — worse than the silence it replaces.
  const root = makeRunsRoot();
  fs.mkdirSync(path.join(root, "codex-empty"), { recursive: true });
  fs.writeFileSync(path.join(root, "codex-streams-only", "..", "stray"), "x");
  fs.mkdirSync(path.join(root, "codex-streams-only"), { recursive: true });
  fs.writeFileSync(path.join(root, "codex-streams-only", "events.jsonl"), "{}\n");

  assert.deepEqual(scanForeignRuns({ runsRoot: root, inFlightOnly: false, now: NOW }), []);
  assert.equal(readForeignRun("codex-empty", root, NOW), null);
});

test("a missing or unreadable runs root degrades to 'I saw nothing', never to a throw", () => {
  assert.deepEqual(scanForeignRuns({ runsRoot: path.join(os.tmpdir(), "clanker-foreign-nope-91a2"), now: NOW }), []);
});

test("the durable record carries the model that actually ran, and the verdict path", () => {
  const root = makeRunsRoot();
  writeRun(
    root,
    "codex-obs",
    { lane: "codex", host: "claude", terminal_at: null, observed_model: "gpt-5.3-codex-spark", read_only: true },
    { "result.md": "# verdict\n" },
  );
  const run = readForeignRun("codex-obs", root, NOW)!;
  assert.equal(run.observed_model, "gpt-5.3-codex-spark", "a silent model swap stays visible across processes");
  assert.equal(run.read_only, true);
  assert.ok(run.result_path?.endsWith("result.md"));
});

test("an empty result.md yields no result_path — absence must stay machine-checkable", () => {
  const root = makeRunsRoot();
  writeRun(root, "codex-noresult", { lane: "codex", terminal_at: "y" }, { "result.md": "" });
  assert.equal(readForeignRun("codex-noresult", root, NOW)!.result_path, undefined);
});

test("list() reports foreign runs as foreign, and never claims to know they are working", async () => {
  const root = makeRunsRoot();
  writeRun(root, "opencode-elsewhere", { lane: "opencode", host: "claude", terminal_at: null, turns: 3, observed_model: "glm-5.2" });
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "mine", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).status !== "running", 6_000);

    const entries = m.list();
    const foreign = entries.find((e) => e.id === "opencode-elsewhere");
    assert.ok(foreign, "another session's in-flight run must appear");
    assert.equal(foreign.owner, "foreign");
    assert.equal(foreign.run_dir, path.join(root, "opencode-elsewhere"));
    assert.equal(foreign.observed_model, "glm-5.2");
    // Never "working": with no event stream this process cannot tell working
    // from wedged, and a board that guesses is worse than one that abstains.
    assert.notEqual(foreign.state, "working");
    assert.match(foreign.plan_summary, /foreign run/);

    assert.equal(entries.filter((e) => e.owner === "this-process").every((e) => e.run_dir === undefined), true);
  } finally {
    await m.shutdown();
  }
});

test("an in-flight run this process owns appears ONCE, as its own", async () => {
  // The exclusion rule needs a run that is still running to be tested at all:
  // a finished one is filtered by terminality instead, so a `list()` that
  // forgot to exclude its own ids would still look correct. Without this the
  // owning process double-reports every live job — once from memory with a
  // plan, once from disk as an untouchable stranger — on the very board an
  // orphan scan reads.
  const root = makeRunsRoot();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "CANCELME", cwd: os.tmpdir(), readOnly: true }); // never completes on its own
    await until(() => fs.existsSync(path.join(root, id, "telemetry.json")), 6_000);

    const rows = m.list().filter((e) => e.id === id);
    assert.equal(rows.length, 1, `own run must not be listed twice (got ${JSON.stringify(rows)})`);
    assert.equal(rows[0].owner, "this-process");
  } finally {
    await m.shutdown();
  }
});

test("control tools refuse a foreign id by NAME, not by pretending it does not exist", async () => {
  const root = makeRunsRoot();
  writeRun(root, "opencode-elsewhere", { lane: "opencode", terminal_at: null }, { "result.md": "# v\n" });
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root });
  try {
    for (const call of [
      () => m.wait("opencode-elsewhere", 10),
      () => m.cancel("opencode-elsewhere"),
      () => m.promptExisting("opencode-elsewhere", "correct", true),
    ]) {
      await assert.rejects(call, (error: Error) => {
        assert.match(error.message, /belongs to a different Clanker server process/);
        assert.match(error.message, /still in flight/);
        assert.match(error.message, /Do NOT re-dispatch/, "the refusal must say what not to conclude");
        assert.doesNotMatch(error.message, /^run '[^']+' not found/, "the old lie must be gone");
        return true;
      });
    }
    assert.throws(() => m.status("opencode-elsewhere"), /belongs to a different Clanker server process/);
  } finally {
    await m.shutdown();
  }
});

test("a genuinely unknown id still says not found, and says where it looked", async () => {
  // The other half: if "not found" stopped meaning anything, the fix would have
  // traded one ambiguous answer for another.
  const root = makeRunsRoot();
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root });
  try {
    await assert.rejects(() => m.wait("codex-never-existed", 10), (error: Error) => {
      assert.match(error.message, /not found/);
      assert.match(error.message, /no record of it on disk/);
      assert.doesNotMatch(error.message, /belongs to a different/);
      return true;
    });
  } finally {
    await m.shutdown();
  }
});
