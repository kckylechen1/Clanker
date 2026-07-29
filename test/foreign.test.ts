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
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager } from "../src/manager.js";
import { isValidRunId, readForeignRun, scanForeignRuns } from "../src/foreign.js";
import { dropMutant, fakeSpec, loadMutantModule, until } from "./helpers.js";

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
  fs.writeFileSync(path.join(root, "stray"), "x");
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

test("#27: the issue-comment account survives its owner — the disk-poll reader can see it too", () => {
  // The whole point of #27 is that a dispatcher can learn whether the verdict
  // reached the ticket. The one reader who CANNOT ask the owning process was
  // also, until now, the only reader shown nothing about it.
  const root = makeRunsRoot();
  writeRun(root, "codex-postfailed", {
    lane: "codex", terminal_at: "y", terminal_reason: "done",
    issue_comment_error: "#27: `gh` exited 4: HTTP 403",
  });
  const failed = readForeignRun("codex-postfailed", root, NOW)!;
  assert.equal(failed.issue_comment_error, "#27: `gh` exited 4: HTTP 403");
  assert.equal(failed.issue_comment_pending, false);

  // An owner that died between raising the mark and settling it leaves a
  // permanent `pending`. That is not a hole needing more machinery: paired with
  // `terminal_at`, it reads as "this post will never resolve — check the
  // ticket", which is exactly the truth and exactly what a dispatcher needs.
  writeRun(root, "codex-diedmidpost", {
    lane: "codex", terminal_at: "y", terminal_reason: "done", issue_comment_pending: true,
  });
  const stuck = readForeignRun("codex-diedmidpost", root, NOW)!;
  assert.equal(stuck.issue_comment_pending, true);
  assert.equal(stuck.issue_comment_error, null);
  assert.ok(stuck.terminal_at, "terminal AND pending is the diagnosable pair");

  // A run that owed no account says so by carrying neither.
  writeRun(root, "codex-noticket", { lane: "codex", terminal_at: "y" });
  const none = readForeignRun("codex-noticket", root, NOW)!;
  assert.equal(none.issue_comment_error, null);
  assert.equal(none.issue_comment_pending, false);
});

test("list() reports foreign runs as foreign, and never claims to know they are working", async () => {
  const root = makeRunsRoot();
  writeRun(root, "opencode-elsewhere", { lane: "opencode", host: "claude", terminal_at: null, turns: 3, observed_model: "glm-5.2" });
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: root });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "mine", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).status !== "running");

    const entries = m.list();
    const foreign = entries.find((e) => e.id === "opencode-elsewhere");
    assert.ok(foreign, "another session's in-flight run must appear");
    assert.equal(foreign.owner, "foreign");
    // realpath, not the lexical join — see the containment note below.
    assert.equal(foreign.run_dir, fs.realpathSync(path.join(root, "opencode-elsewhere")));
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
    await until(() => fs.existsSync(path.join(root, id, "telemetry.json")));

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

// ---- an id is a path segment (#32 cold review, run codex-aed92) -------------

/**
 * A runs root with a NEIGHBOUR directory beside it holding a run record this
 * process was never meant to read — the attacker-controlled telemetry a
 * traversing id used to reach.
 *
 * Returns the escaping id (relative, as a caller would pass it) and the
 * outsider's directory.
 */
function rootWithOutsider(): { root: string; outsideDir: string; escapingId: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-traversal-"));
  const root = path.join(parent, "runs");
  const outsideDir = path.join(parent, "elsewhere", "codex-outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(
    path.join(outsideDir, "telemetry.json"),
    JSON.stringify({ lane: "codex", terminal_at: null, server_pid: 999_999_999, worker_pid: 424_242 }),
  );
  return { root, outsideDir, escapingId: path.join("..", "elsewhere", "codex-outside") };
}

test("a traversing id reads NOTHING — the id is a path segment, not a path", () => {
  // `id` arrives from clanker_wait/clanker_cancel as a bare z.string() and is
  // joined onto the runs root. Reading a stranger's telemetry.json is only the
  // first half: the record read here decides which directory cancel archives
  // into and which pid it considers signalling.
  const { root, escapingId } = rootWithOutsider();
  writeRun(root, "codex-inside", { lane: "codex", terminal_at: null });

  assert.equal(readForeignRun(escapingId, root, NOW), null, "../ must not resolve outside the runs root");
  assert.equal(readForeignRun("../elsewhere/codex-outside/", root, NOW), null, "a trailing slash changes nothing");
  assert.equal(readForeignRun("..", root, NOW), null);
  assert.equal(readForeignRun("/etc", root, NOW), null, "an absolute id resolves away from the root entirely");
  assert.equal(readForeignRun("codex-inside/../../elsewhere/codex-outside", root, NOW), null);
  // ...and the guard did not simply break reading, which is the way a
  // containment fix silently becomes an availability bug.
  // `run_dir` is now the REALPATH of the run directory, not the lexical join:
  // containment resolves symlinks (round-2 review codex-dcbfb), and handing
  // back the resolved path is the honest half of that — the caller is told
  // where the read actually landed. On macOS the temp root is itself a symlink
  // (/var -> /private/var), so comparing against a lexical join would be
  // comparing against a path nobody read.
  assert.equal(
    readForeignRun("codex-inside", root, NOW)?.run_dir,
    fs.realpathSync(path.join(root, "codex-inside")),
  );
});

test("mutant: a foreign record that drops the comment fields hides the account from the only reader left", async () => {
  const mutant = await loadMutantModule<typeof import("../src/foreign.js")>(
    "foreign-no-comment-projection",
    [{
      file: "foreign.ts",
      find:
        '    issue_comment_error: typeof telemetry.issue_comment_error === "string" ? telemetry.issue_comment_error : null,\n' +
        "    issue_comment_pending: telemetry.issue_comment_pending === true,\n",
      replace: "    issue_comment_error: null,\n    issue_comment_pending: false,\n",
    }],
    "foreign.ts",
  );
  const root = makeRunsRoot();
  writeRun(root, "codex-postfailed", {
    lane: "codex", terminal_at: "y", issue_comment_error: "#27: `gh` exited 4: HTTP 403", issue_comment_pending: true,
  });
  const run = mutant.readForeignRun("codex-postfailed", root, NOW)!;
  assert.equal(run.issue_comment_error, null, "the mutant reads the file and throws the account away…");
  assert.equal(run.issue_comment_pending, false, "…leaving the disk-poll reader exactly as blind as before");
});

test("isValidRunId accepts what manager.ts mints and refuses what moves the read", () => {
  // The shape comes from dispatchStartInternal:
  //   `${lane}-${(++counter).toString(36)}${randomBytes(2).toString("hex")}`
  // with lane drawn from LANE_NAMES. Verified against the machine's own cache:
  // every run directory there matches.
  for (const good of ["codex-1a2b3c", "gemini-zz00ff", "opencode-10a1", "cursor-1f", "codex-live-owner"]) {
    assert.equal(isValidRunId(good), true, `${good} is the shape the generator emits`);
  }
  for (const bad of [
    "../elsewhere", "..", ".", "", "codex", "a/b", "a\\b", "/abs/path", "codex-1a2b/../..",
    "codex 1a2b", "codex-1a2b\n", "codex-1a2b\0", "codex-.-1a2b", "-codex-1", "codex-",
  ]) {
    assert.equal(isValidRunId(bad), false, `${JSON.stringify(bad)} must not be usable as a path segment`);
  }
});

test("mutant: without both guards the traversing id really does read the outsider (the exploit is real)", async () => {
  // Proves the fixture above is an exploit and not a no-op: with the pre-fix
  // line restored, the same id returns a record whose run_dir — the directory
  // cancel archives into — sits outside the runs root, carrying the outsider's
  // chosen worker_pid.
  const name = "foreign-traversal-unguarded";
  const mutated = await loadMutantModule<typeof import("../src/foreign.js")>(name, [
    {
      file: "foreign.ts",
      find:
        "  if (!isValidRunId(id)) return null;\n" +
        "  const runDir = containedRunDir(runsRoot, id);\n" +
        "  if (runDir === null) return null;",
      replace: "  const runDir = path.join(runsRoot, id);",
    },
  ], "foreign.ts");
  const { root, outsideDir, escapingId } = rootWithOutsider();
  try {
    const leaked = mutated.readForeignRun(escapingId, root, NOW);
    assert.ok(leaked, "pre-fix, a traversing id resolves to a real record");
    assert.equal(path.resolve(leaked.run_dir), path.resolve(outsideDir), "…outside the runs root");
    assert.equal(leaked.worker_pid, 424_242, "…and the caller chose the pid cancel would consider signalling");
  } finally {
    dropMutant(name);
  }
});

test("mutant: either guard ALONE closes the traversal — the pair is not one guard written twice", async () => {
  // Defense in depth is only depth if each layer holds on its own. One mutant
  // deletes the id whitelist, the other deletes the resolved-path containment;
  // the traversing id must come back null in both.
  const cases = [
    {
      name: "foreign-traversal-pattern-only",
      mutation: {
        file: "foreign.ts",
        find: "  const runDir = containedRunDir(runsRoot, id);\n  if (runDir === null) return null;",
        replace: "  const runDir = path.join(runsRoot, id);",
      },
      why: "the id whitelist alone must refuse ../",
    },
    {
      name: "foreign-traversal-containment-only",
      mutation: {
        file: "foreign.ts",
        find: "  if (!isValidRunId(id)) return null;",
        replace: "  if (false) return null;",
      },
      why: "resolved-path containment alone must refuse ../",
    },
  ];
  for (const { name, mutation, why } of cases) {
    const mutated = await loadMutantModule<typeof import("../src/foreign.js")>(name, [mutation], "foreign.ts");
    const { root, escapingId } = rootWithOutsider();
    try {
      assert.equal(mutated.readForeignRun(escapingId, root, NOW), null, why);
    } finally {
      dropMutant(name);
    }
  }
});

test("a symlinked run dir does not escape the runs root — containment is realpath, not string prefix", () => {
  // Round-2 review (codex-dcbfb), reproduced live before the fix: `codex-link`
  // passed the id pattern AND lexical containment, then read an outside
  // telemetry whose `worker_pid` drives a real signal. A lexical check answers
  // "does this string sit under that string"; a symlink makes that question
  // the wrong one.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-foreign-symlink-"));
  const runs = path.join(base, "runs");
  const outside = path.join(base, "elsewhere", "codex-outside");
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(outside, "telemetry.json"),
    JSON.stringify({ lane: "codex", terminal_at: null, worker_pid: 424242, server_pid: 999999 }),
  );
  fs.symlinkSync(outside, path.join(runs, "codex-link"));
  assert.equal(readForeignRun("codex-link", runs, NOW), null, "the symlinked id reads nothing");

  // The honest case still works when the ROOT itself is a symlink — the ordinary
  // macOS /var -> /private/var shape must not make every real run look like an escape.
  const realRun = path.join(runs, "codex-real1");
  fs.mkdirSync(realRun, { recursive: true });
  fs.writeFileSync(path.join(realRun, "telemetry.json"), JSON.stringify({ lane: "codex", terminal_at: null }));
  const rootLink = path.join(base, "runs-link");
  fs.symlinkSync(runs, rootLink);
  assert.ok(readForeignRun("codex-real1", rootLink, NOW), "a symlinked runs root still reads its own runs");
});

test("an uppercase id is refused — the generator only ever mints lowercase", () => {
  // Round-2 review: `/i` admitted a shape manager.ts never produces, and on a
  // case-insensitive volume that is two names for one run — the ambiguity an
  // id guard exists to remove.
  assert.equal(isValidRunId("CODEX-1ABCD"), false);
  assert.equal(isValidRunId("Codex-1abcd"), false);
  assert.equal(isValidRunId("codex-1abcd"), true);
});

test("one run directory, one name — the owning process and the foreign read agree", async () => {
  // Round-3 review (codex-ee7b9). The symlink fix resolved the FOREIGN read
  // while dispatch kept minting a lexical join, so the same physical directory
  // had two names depending on who was asked — and `run_dir` is documented as
  // the absolute path a seat hands over precisely so nobody has to construct or
  // reconcile one. The runs root here is a symlink, which is what makes the two
  // forms differ at all (and is the ordinary macOS /var shape).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-onename-"));
  const real = path.join(base, "real-runs");
  const linked = path.join(base, "runs-link");
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, linked);
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), runsRoot: linked });
  try {
    const { id } = await m.dispatchStart({ lane: "codex", prompt: "one name", cwd: os.tmpdir(), readOnly: true });
    await until(() => m.status(id).status !== "running");
    const owned = m.status(id).run_dir;
    const seen = readForeignRun(id, linked, NOW)?.run_dir;
    assert.ok(seen, "the record is readable through the foreign path");
    assert.equal(owned, seen, `owned ${owned} vs foreign ${seen} — one directory must have one name`);
    assert.equal(path.isAbsolute(owned), true, "and the documented contract is an ABSOLUTE path");
  } finally {
    await m.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
