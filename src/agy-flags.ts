/**
 * What THIS machine's `agy` build actually accepts on its command line.
 *
 * `agy` is not a pinned dependency of this repository the way
 * `@agentclientprotocol/codex-acp` is — it is a binary the operator installs
 * and updates on its own schedule, and its flag set has moved underneath us.
 * The build on this machine (Mach-O arm64, dated 2026-05-20) declares thirteen
 * flags, and three of the four the gemini lane was passing are not among them:
 *
 *     $ agy --mode plan --print-timeout 2s --print hi
 *     flags provided but not defined: -mode plan
 *     (same for --model and --effort; exit 2, nothing runs)
 *
 * That is Go's `flag` package refusing the whole command line before agy does
 * any work, so EVERY gemini dispatch died at spawn with an error
 * (`agy failed (exit 2): flags provided but not defined: -mode`) that reads
 * like a backend crash rather than a version mismatch. Hardcoding the flags
 * out would fix this machine and silently downgrade any operator whose agy
 * still has them, which is the same class of invisible-substitution bug #25
 * and #54 are about — so the lane asks the binary instead of assuming.
 *
 * WHO asks: backends.ts, once, while it is already resolving the agy path and
 * building the sidecar's environment. The answer travels to the sidecar in
 * `CLANKER_AGY_FLAGS` exactly like CLANKER_GEMINI_MODEL and friends. The
 * sidecar deliberately does NOT probe on its own — it would mean executing the
 * backend binary an extra time per process, inside the one component whose job
 * is to spawn it exactly once per turn.
 *
 * The default at every layer, when there is no trustworthy answer, is FULL
 * SUPPORT: exactly today's command line. An unreadable `--help`, an
 * unrecognizable usage block, or a missing env var must never be allowed to
 * quietly strip the model pin off a dispatch. Dropping a flag happens only on
 * positive evidence that the binary rejects it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/**
 * The three argv knobs the gemini lane wants but cannot assume.
 *
 * `--print`, `--print-timeout` and `--sandbox` are deliberately absent: they
 * are present in every agy build seen so far, and the lane has no meaningful
 * behavior without `--print` at all. `--print` doubles as this probe's sentinel
 * (see `parseAgyUsage`).
 */
export interface AgyFlagSupport {
  /** `--mode plan` — agy's own read-only posture. Defense in depth only; see gemini-acp.ts. */
  readonly mode: boolean;
  /** `--model <id>` — without it the lane cannot pin a model and must not claim one. */
  readonly model: boolean;
  /** `--effort <level>` — without it a requested reasoning effort cannot be honored. */
  readonly effort: boolean;
}

const OPTIONAL_FLAGS = ["mode", "model", "effort"] as const;

/** The pre-drift command line: what every agy build was assumed to accept. */
export const ALL_AGY_FLAGS_SUPPORTED: AgyFlagSupport = { mode: true, model: true, effort: true };

/** The env var carrying a resolved `AgyFlagSupport` from backends.ts to the sidecar. */
export const AGY_FLAGS_ENV = "CLANKER_AGY_FLAGS";

/** Long enough for a cold 140MB binary to page in, short enough not to hang a dispatch. */
const PROBE_TIMEOUT_MS = 10_000;

const cache = new Map<string, AgyFlagSupport>();

/**
 * Probe result cached per binary IDENTITY, not per path.
 *
 * The MCP server is a resident process that outlives operator tooling upgrades
 * — this whole defect exists because agy changed on disk. Keying the cache on
 * size+mtime as well as path means an `agy update` under a running server
 * re-probes instead of serving an answer about a binary that no longer exists.
 * A path we cannot stat is probed every time rather than cached under a
 * guessed identity.
 */
export function agyFlagSupport(agyPath: string): AgyFlagSupport {
  const key = binaryIdentity(agyPath);
  if (key === undefined) return probeAgyFlagSupport(agyPath);
  const cached = cache.get(key);
  if (cached) return cached;
  const support = probeAgyFlagSupport(agyPath);
  cache.set(key, support);
  return support;
}

function binaryIdentity(agyPath: string): string | undefined {
  try {
    const stat = fs.statSync(agyPath);
    return `${agyPath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Uncached probe. Exported for the tests, which must not share a cache between fake binaries. */
export function probeAgyFlagSupport(agyPath: string): AgyFlagSupport {
  return parseAgyUsage(readAgyUsage(agyPath));
}

/**
 * Turn `agy --help` output into a support map.
 *
 * The sentinel is `--print`: if the text does not declare the one flag every
 * agy build has and this lane cannot run without, then whatever came back is
 * not a usage block this function understands — a wrapper script, a login
 * prompt, an empty pipe — and the honest reading is "no evidence", which means
 * the full command line, not a stripped one.
 */
export function parseAgyUsage(usage: string | undefined): AgyFlagSupport {
  if (!usage || !declaresFlag(usage, "print")) return ALL_AGY_FLAGS_SUPPORTED;
  return {
    mode: declaresFlag(usage, "mode"),
    model: declaresFlag(usage, "model"),
    effort: declaresFlag(usage, "effort"),
  };
}

/**
 * Does the usage text declare `--<flag>` as a flag of its own?
 *
 * The trailing `(?![\w-])` is load-bearing, and the reason is on the very
 * binary this was written for: agy's help lists both `--print` and
 * `--print-timeout`. A plain substring or `\b` test for `--print` matches the
 * `--print-timeout` line too (`\b` sits between `t` and `-`), so a build that
 * had dropped `--print` would still look like it had it. `-` must continue the
 * name, not end it. The leading lookbehind keeps `--model` from matching inside
 * a longer `---model`-style token.
 */
function declaresFlag(usage: string, flag: string): boolean {
  return new RegExp(`(?<![\\w-])--${flag}(?![\\w-])`).test(usage);
}

/**
 * Run `agy --help` and return whatever it printed, on BOTH streams, whatever it
 * exited with.
 *
 * Both halves of that are load-bearing, and both were learned from the binary
 * rather than assumed:
 *
 *  - The real agy prints its entire usage to STDERR and exits 0. A first cut
 *    of this used `execFileSync`, whose return value is stdout alone — it read
 *    an empty string, concluded "no evidence", and fell back to the full
 *    command line, i.e. it reported the drifted build as healthy and would have
 *    shipped a fix that fixed nothing.
 *  - Go's flag package, on other builds, prints usage and exits 2. A nonzero
 *    exit is not a failed probe: the program answered the question.
 *
 * `spawnSync` is what reports stdout, stderr and status uniformly across all
 * four combinations. Only a genuinely empty result becomes `undefined`.
 */
function readAgyUsage(agyPath: string): string | undefined {
  const probe = spawnSync(agyPath, ["--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
  });
  // Could not be executed at all (missing, not executable, timed out): no
  // evidence, and no evidence means the untouched command line.
  if (probe.error) return undefined;
  const text = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.trim();
  return text || undefined;
}

/**
 * Encode for the sidecar's environment as an explicit per-flag map
 * (`mode=0,model=0,effort=1`) rather than a list of the supported ones.
 *
 * A list would spell "nothing is supported" as the empty string, which is the
 * one value that cannot be told apart from "this var was never set" with any
 * confidence across a spawn — and those two must mean opposite things here
 * (drop everything vs. keep everything). Every flag naming itself and its
 * answer also makes the decision readable in a process listing.
 */
export function encodeAgyFlagSupport(support: AgyFlagSupport): string {
  return OPTIONAL_FLAGS.map((flag) => `${flag}=${support[flag] ? 1 : 0}`).join(",");
}

/**
 * Decode what backends.ts resolved. An absent var means the sidecar is running
 * outside a Clanker dispatch (a hand-run, a test harness), where the safe
 * reading is the full pre-drift command line. A flag missing from an otherwise
 * valid string is read the same way, per flag: unstated is not "unsupported".
 */
export function decodeAgyFlagSupport(encoded: string | undefined): AgyFlagSupport {
  if (encoded === undefined) return ALL_AGY_FLAGS_SUPPORTED;
  const stated = new Map<string, string>();
  for (const field of encoded.split(",")) {
    const [name, value] = field.split("=");
    if (name && value !== undefined) stated.set(name.trim(), value.trim());
  }
  const supported = (flag: string): boolean => stated.get(flag) !== "0";
  return { mode: supported("mode"), model: supported("model"), effort: supported("effort") };
}

/**
 * The operator-facing account of what this agy build cannot do, one sentence
 * per lost knob, or `[]` when nothing was lost.
 *
 * Lives here rather than in either caller because backends.ts (dispatch-time
 * `warnings`) and gemini-acp.ts (stderr evidence on the run itself) must not
 * describe the same degradation two different ways — the gemini relay card is
 * one of the five that do not report `warnings` at all (see 3e42b8b), so the
 * stderr copy is the one some readers will ever see.
 *
 * `requestedEffort` is passed because an unsupported `--effort` only costs the
 * operator something when they actually asked for an effort level.
 */
export function agyDegradationNotices(
  support: AgyFlagSupport,
  opts: { readonly requestedEffort?: string | undefined } = {},
): string[] {
  const notices: string[] = [];
  if (!support.model) {
    notices.push(
      "this agy build does not accept --model, so the gemini lane cannot pin a model: the turn runs on agy's " +
        "own default and observed_model is reported as unknown rather than as the model that was requested",
    );
  }
  if (!support.effort && opts.requestedEffort) {
    notices.push(
      `this agy build does not accept --effort, so the requested reasoning effort '${opts.requestedEffort}' ` +
        "is not applied and is not reported as observed_effort",
    );
  }
  if (!support.mode) {
    notices.push(
      "this agy build does not accept --mode, so agy is not additionally asked for its own plan-mode posture; " +
        "the lane's read-only boundary is unchanged and still enforced by the fail-closed sandbox-exec profile " +
        "that denies file-write* across the workspace and its sibling worktrees",
    );
  }
  return notices;
}
