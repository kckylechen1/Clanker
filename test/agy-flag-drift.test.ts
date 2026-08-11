/**
 * The gemini lane died on this machine, and not from anything in this repo.
 *
 * `agy` is the operator's own binary, updated on its own schedule, and the
 * build here (Mach-O arm64, 2026-05-20) had dropped three of the four flags the
 * lane passes. Go's `flag` package rejects an unknown flag by refusing the
 * ENTIRE command line before the program runs, so every dispatch came back as
 *
 *     Clanker: Gemini agy failed (exit 2): flags provided but not defined: -mode
 *
 * which reads like a backend crash and is nothing of the sort.
 *
 * Two things are being pinned here, and the second is the one that keeps this
 * fix from becoming its own silent-substitution bug:
 *
 *  1. A build that rejects a flag gets a command line without it, so the lane
 *     runs instead of dying at spawn.
 *  2. A model that could not be pinned is NOT reported as observed_model. The
 *     turn then runs on agy's own default — which this process cannot know —
 *     and `null` is the honest spelling of that. Naming the requested model
 *     anyway would file the run's verdict against a model nobody verified it
 *     ran on, which is precisely #25 and #54.
 *
 * And the default everywhere, on any doubt: the full pre-drift command line.
 * Dropping a flag happens only on positive evidence that the binary rejects it,
 * because the failure mode of guessing wrong is invisible.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneConnection } from "../src/acp-client.js";
import { buildSpawnSpec } from "../src/backends.js";
import {
  AGY_FLAGS_ENV,
  agyDegradationNotices,
  decodeAgyFlagSupport,
  encodeAgyFlagSupport,
  parseAgyUsage,
  probeAgyFlagSupport,
  ALL_AGY_FLAGS_SUPPORTED,
} from "../src/agy-flags.js";

const workspaceSandboxAvailable = (() => {
  if (process.platform !== "darwin") return false;
  try {
    fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

/**
 * `agy --help` from the build that broke the lane, verbatim.
 *
 * Kept as captured rather than reduced to the interesting lines: the parse has
 * to survive the real text, and one of its two known traps (`--print` vs
 * `--print-timeout`) only exists because both appear here.
 */
const DRIFTED_AGY_USAGE = `Usage of /Users/kc/.local/bin/agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  -i                              Short alias for --prompt-interactive
  --log-file                      Override CLI log file path
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --prompt                        Alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  changelog       Show changelog and release notes
  help            Show help for subcommands
  install         Configure environment paths and shell settings
  plugin          Manage plugins (install, uninstall, list, enable, disable)
  plugins         Alias for plugin
  update          Update CLI`;

/** The same shape with the three flags the lane wants restored — a pre-drift build. */
const FULL_AGY_USAGE = `${DRIFTED_AGY_USAGE}
  --mode                          Set the agent mode (plan, ask, code)
  --model                         Model to run
  --effort                        Reasoning effort`;

/**
 * A fake agy that parses like Go's `flag` package: any flag it does not declare
 * kills the whole command line, exactly as the real binary did.
 *
 * Both halves matter. Serving the drifted usage on `--help` is what the probe
 * reads; rejecting the flags is what makes a test that merely *passes* them
 * fail. A fake that accepted everything would let a broken fix look green.
 *
 * `--help` goes to STDERR with exit 0 because that is what the real binary
 * does, and a fake that printed to stdout instead is not a detail — the first
 * cut of the probe read stdout only, reported the drifted build as fully
 * healthy, and every test here still passed against a stdout-printing fake.
 * The fixture matches the binary; `usageOn` exists only for the probe test that
 * pins the other combinations.
 */
function strictFakeAgy(
  usage: string,
  declared: string[],
  usageOn: { stream: "stdout" | "stderr"; exit: number } = { stream: "stderr", exit: 0 },
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-strict-agy-"));
  const executable = path.join(dir, "agy");
  const known = ["--print", "--print-timeout", "--sandbox", ...declared];
  const redirect = usageOn.stream === "stderr" ? " >&2" : "";
  fs.writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then',
      `  cat${redirect} <<'USAGE'`,
      usage,
      "USAGE",
      `  exit ${usageOn.exit}`,
      "fi",
      'if [ -n "${CLANKER_AGY_CAPTURE:-}" ]; then printf \'%s\\n\' "$@" > "$CLANKER_AGY_CAPTURE"; fi',
      'for arg in "$@"; do',
      "  case \"$arg\" in",
      "    --*)",
      `      case " ${known.join(" ")} " in`,
      '        *" $arg "*) ;;',
      '        *) echo "flags provided but not defined: ${arg#-}" >&2; exit 2 ;;',
      "      esac",
      "      ;;",
      "  esac",
      "done",
      "echo grounded-result",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function sidecarSpec(agy: string, capture: string, env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: ["--import", path.resolve("node_modules/tsx/dist/esm/index.mjs"), path.resolve("src/gemini-acp.ts")],
    env: { CLANKER_AGY_PATH: agy, CLANKER_AGY_CAPTURE: capture, ...env },
    warnings: [],
  };
}

/** One turn: what the session advertised, what agy was actually invoked with, and the output. */
async function runTurn(spec: ReturnType<typeof sidecarSpec>, capture: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-drift-workspace-"));
  const conn = await LaneConnection.connect({ spec, cwd, readOnly: true });
  try {
    const turn = conn.session.prompt("find evidence");
    turn.catch(() => {});
    let final = "";
    for (;;) {
      const update = await conn.session.nextUpdate();
      if (update.kind === "stop") break;
      if (update.update.sessionUpdate === "agent_message_chunk" && update.update.content.type === "text") {
        final += update.update.content.text;
      }
    }
    await turn;
    const options = conn.session.newSessionResponse.configOptions ?? [];
    const pick = (category: string): string | undefined => {
      const found = options.find((option) => option.category === category);
      return found === undefined ? undefined : String(found.currentValue);
    };
    return {
      final,
      argv: fs.readFileSync(capture, "utf8"),
      reportedModel: pick("model"),
      reportedEffort: pick("thought_level"),
      stderr: conn.stderr(),
    };
  } finally {
    conn.close();
  }
}

function captureFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clanker-drift-capture-")), "capture");
}

test("the drifted build's real --help is read as rejecting --mode, --model and --effort", () => {
  assert.deepEqual(parseAgyUsage(DRIFTED_AGY_USAGE), { mode: false, model: false, effort: false });
});

test("a build that still declares them is read as supporting them", () => {
  assert.deepEqual(parseAgyUsage(FULL_AGY_USAGE), { mode: true, model: true, effort: true });
});

test("--print-timeout does not satisfy a search for --print", () => {
  // The trap the `(?![\w-])` guard exists for: `\b` sits between `t` and `-`,
  // so the naive test finds `--print` inside `--print-timeout` and a build that
  // had actually dropped `--print` would still look like it had it. Here that
  // mistake is load-bearing twice over — `--print` is the sentinel, so reading
  // it as present would make the parser trust a usage block it cannot read.
  const timeoutOnly = "Usage:\n  --print-timeout   Timeout for print mode wait\n  --model  Model to run";
  assert.deepEqual(parseAgyUsage(timeoutOnly), ALL_AGY_FLAGS_SUPPORTED, "no --print means no trustworthy reading");
});

test("an unreadable or unrecognizable --help falls back to the full command line, never a stripped one", () => {
  // Every one of these is "no evidence", and no evidence must never be read as
  // evidence of absence: silently dropping --model on a build that supports it
  // would unpin the model of every dispatch with nothing to show for it.
  for (const [label, usage] of [
    ["undefined", undefined],
    ["empty", ""],
    ["not a usage block", "agy: please run `agy login` first"],
    ["a wrapper script's noise", "loading...\n\n"],
  ] as const) {
    assert.deepEqual(parseAgyUsage(usage), ALL_AGY_FLAGS_SUPPORTED, `${label} must fall back to full support`);
  }
});

test("the probe reads a real binary on whichever stream and exit code it answers with", () => {
  const drifted = { mode: false, model: false, effort: false };

  // The combination that actually matters: the real agy prints its whole usage
  // to STDERR and exits 0. Reading stdout alone (execFileSync's return value)
  // sees an empty string, concludes "no evidence", and reports this drifted
  // build as fully healthy — a fix that fixes nothing, green the whole way.
  assert.deepEqual(probeAgyFlagSupport(strictFakeAgy(DRIFTED_AGY_USAGE, [])), drifted, "stderr + exit 0 is the real agy");

  // The other three combinations are all still complete answers to the
  // question, and a nonzero exit is not a failed probe.
  for (const usageOn of [
    { stream: "stdout", exit: 0 },
    { stream: "stdout", exit: 2 },
    { stream: "stderr", exit: 2 },
  ] as const) {
    assert.deepEqual(
      probeAgyFlagSupport(strictFakeAgy(DRIFTED_AGY_USAGE, [], usageOn)),
      drifted,
      `usage on ${usageOn.stream} with exit ${usageOn.exit} must still be read`,
    );
  }

  assert.deepEqual(probeAgyFlagSupport(strictFakeAgy(FULL_AGY_USAGE, ["--mode", "--model", "--effort"])), ALL_AGY_FLAGS_SUPPORTED);
});

test("a binary that cannot be executed at all leaves the command line untouched", () => {
  // A missing agy is the spawn's problem to report, with its own error. It is
  // not a reason to start dropping flags.
  assert.deepEqual(probeAgyFlagSupport(path.join(os.tmpdir(), "clanker-no-such-agy")), ALL_AGY_FLAGS_SUPPORTED);
});

test("the env handoff distinguishes 'nothing supported' from 'nobody said'", () => {
  const none = { mode: false, model: false, effort: false };
  assert.equal(encodeAgyFlagSupport(none), "mode=0,model=0,effort=0");
  assert.deepEqual(decodeAgyFlagSupport(encodeAgyFlagSupport(none)), none);
  assert.deepEqual(decodeAgyFlagSupport(encodeAgyFlagSupport(ALL_AGY_FLAGS_SUPPORTED)), ALL_AGY_FLAGS_SUPPORTED);
  // The distinction the encoding exists for: an all-false support map must not
  // round-trip through anything an unset variable could be confused with.
  assert.deepEqual(decodeAgyFlagSupport(undefined), ALL_AGY_FLAGS_SUPPORTED, "unset means a hand-run, not a stripped one");
  // Unstated per flag is read the same way as unstated entirely.
  assert.deepEqual(decodeAgyFlagSupport("model=0"), { mode: true, model: false, effort: true });
});

test("a dispatch that cannot pin its model says so, and one that can stays quiet", () => {
  const none = agyDegradationNotices({ mode: false, model: false, effort: false }, { requestedEffort: "high" });
  assert.equal(none.length, 3);
  assert.match(none.join("\n"), /does not accept --model/);
  assert.match(none.join("\n"), /observed_model is reported as unknown/);
  assert.match(none.join("\n"), /'high'/, "an effort that was actually requested must be named");
  // The --mode notice must state the boundary is intact, because the reader's
  // question on seeing it is "did this lane just become write-capable".
  assert.match(none.join("\n"), /read-only boundary is unchanged/);

  // Effort is only a loss if one was asked for.
  const noEffortAsked = agyDegradationNotices({ mode: true, model: true, effort: false });
  assert.deepEqual(noEffortAsked, []);
  assert.deepEqual(agyDegradationNotices(ALL_AGY_FLAGS_SUPPORTED, { requestedEffort: "high" }), []);
});

test("REPRODUCTION: the pre-fix command line is exactly what a drifted agy rejects", { skip: !workspaceSandboxAvailable }, async () => {
  // The discriminative half. This spec omits CLANKER_AGY_FLAGS, so the sidecar
  // builds the full pre-drift command line — which is what shipped, and what
  // every gemini dispatch on this machine was doing when it died.
  const capture = captureFile();
  const agy = strictFakeAgy(DRIFTED_AGY_USAGE, []);
  await assert.rejects(
    runTurn(sidecarSpec(agy, capture), capture),
    /flags provided but not defined: -mode/,
    "if this stops failing, the fake agy stopped reproducing the bug and the test below proves nothing",
  );
});

test("a drifted build gets a command line it accepts, and the turn runs", { skip: !workspaceSandboxAvailable }, async () => {
  const capture = captureFile();
  const agy = strictFakeAgy(DRIFTED_AGY_USAGE, []);
  const { final, argv, stderr } = await runTurn(
    sidecarSpec(agy, capture, { [AGY_FLAGS_ENV]: "mode=0,model=0,effort=0", CLANKER_GEMINI_EFFORT: "high" }),
    capture,
  );
  assert.equal(final, "grounded-result", "the lane must actually complete a turn");

  for (const dropped of ["--mode", "--model", "--effort"]) {
    assert.doesNotMatch(argv, new RegExp(`^${dropped}$`, "m"), `${dropped} must not reach a build that rejects it`);
  }
  // Everything the lane's contract does NOT get to drop is still there. The
  // sandbox flag especially: a "portability fix" that quietly removed a
  // restriction would be a worse bug than the one being fixed.
  for (const kept of ["--sandbox", "--print", "--print-timeout"]) {
    assert.match(argv, new RegExp(`^${kept}$`, "m"), `${kept} must survive`);
  }
  assert.match(stderr, /does not accept --model/, "the degradation belongs in the run's own evidence");
});

test("a model that was never pinned is reported as unknown, not as the one that was asked for", { skip: !workspaceSandboxAvailable }, async () => {
  const capture = captureFile();
  const agy = strictFakeAgy(DRIFTED_AGY_USAGE, []);
  const { reportedModel, reportedEffort } = await runTurn(
    sidecarSpec(agy, capture, {
      [AGY_FLAGS_ENV]: "mode=0,model=0,effort=0",
      CLANKER_GEMINI_MODEL: "gemini-3.1-pro-high",
      CLANKER_GEMINI_EFFORT: "high",
    }),
    capture,
  );
  // The whole point of the second half of this fix. The turn ran on agy's own
  // default; this process does not know what that is. `undefined` here becomes
  // observed_model null, which constants.ts:modelSwapWarning reads as missing
  // evidence — while "gemini-3.1-pro-high" would have been a fabricated
  // reading that agrees with resolved_model and hides the substitution.
  assert.equal(reportedModel, undefined, "an unpinnable model must not be claimed");
  assert.equal(reportedEffort, undefined, "an unappliable effort must not be claimed");
});

test("a build that still has the flags is driven exactly as before", { skip: !workspaceSandboxAvailable }, async () => {
  const capture = captureFile();
  const agy = strictFakeAgy(FULL_AGY_USAGE, ["--mode", "--model", "--effort"]);
  const { final, argv, reportedModel, reportedEffort } = await runTurn(
    sidecarSpec(agy, capture, {
      [AGY_FLAGS_ENV]: "mode=1,model=1,effort=1",
      CLANKER_GEMINI_MODEL: "gemini-3.1-pro-high",
      CLANKER_GEMINI_EFFORT: "high",
    }),
    capture,
  );
  assert.equal(final, "grounded-result");
  assert.match(argv, /^--mode$/m);
  assert.match(argv, /^plan$/m);
  assert.match(argv, /^--model$/m);
  assert.match(argv, /^gemini-3\.1-pro-high$/m);
  assert.match(argv, /^--effort$/m);
  assert.equal(reportedModel, "gemini-3.1-pro-high", "a pinned model is still reported");
  assert.equal(reportedEffort, "high");
});

test("the gemini spawn spec carries the probe's answer and warns about what was lost", { skip: !workspaceSandboxAvailable }, () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-drift-spec-"));
  const previous = process.env.CLANKER_AGY_PATH;
  try {
    process.env.CLANKER_AGY_PATH = strictFakeAgy(DRIFTED_AGY_USAGE, []);
    const spec = buildSpawnSpec("gemini", { readOnly: true, effort: "high" }, runDir);
    assert.equal(spec.env[AGY_FLAGS_ENV], "mode=0,model=0,effort=0");
    // The requested values still travel: the sidecar needs them the moment the
    // operator's agy regains the flags, and dropping them here would turn a
    // temporary binary regression into a permanent loss of the request.
    assert.equal(spec.env.CLANKER_GEMINI_MODEL, "gemini-3.6-flash-high");
    assert.equal(spec.env.CLANKER_GEMINI_EFFORT, "high");
    assert.equal(spec.warnings.some((w) => /lane 'gemini'.*does not accept --model/.test(w)), true);
    assert.equal(spec.warnings.some((w) => /does not accept --effort.*'high'/.test(w)), true);

    process.env.CLANKER_AGY_PATH = strictFakeAgy(FULL_AGY_USAGE, ["--mode", "--model", "--effort"]);
    const healthy = buildSpawnSpec("gemini", { readOnly: true, effort: "high" }, runDir);
    assert.equal(healthy.env[AGY_FLAGS_ENV], "mode=1,model=1,effort=1");
    assert.deepEqual(healthy.warnings, [], "a build with every flag has nothing to warn about");
  } finally {
    if (previous === undefined) delete process.env.CLANKER_AGY_PATH;
    else process.env.CLANKER_AGY_PATH = previous;
  }
});
