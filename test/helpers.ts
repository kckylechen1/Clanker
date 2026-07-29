// First, and above the `../src/constants.js` import below: constants.ts reads
// the root env vars at module scope, so isolation has to be applied before it
// is evaluated (#29). This does NOT make importing helpers sufficient — most
// test files import a src module before they import helpers — which is why
// every test file carries the same first import.
import "./isolate.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORKTREES_ROOT } from "../src/constants.js";
import type { LaneName, LaneRequestOptions, SpawnSpec } from "../src/types.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url));

/**
 * SpecResolver that points every lane at the scripted fake ACP agent, so the
 * real SDK client is exercised without any external CLI in PATH.
 */
export function fakeResolver(lane: LaneName, _opts: LaneRequestOptions, _runDir: string): SpawnSpec {
  return { command: process.execPath, args: [FAKE_AGENT], env: {}, warnings: [] };
}

export function fakeSpec(env: Record<string, string> = {}): SpawnSpec {
  return { command: process.execPath, args: [FAKE_AGENT], env, warnings: [] };
}

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MUTANTS_ROOT = path.join(REPO_ROOT, ".test-tmp", "mutants");

/** One textual edit applied to a copy of `src/<file>` before it is imported. */
export interface SrcMutation {
  /** File under src/, e.g. "manager.ts". */
  file: string;
  /** Exact text to replace; must occur EXACTLY once or the mutation is rejected. */
  find: string;
  /** Replacement text. */
  replace: string;
}

/**
 * A behavioral mutation-testing harness.
 *
 * Declaration-level tests (does the registry row say read_only=true?) stay green
 * under an implementation whose RUNTIME contradicts the declaration — cold
 * review demonstrated exactly that by making read-only dispatches report a
 * worktree they never created, with all eleven parity tests still passing. The
 * only way a test can prove it observes runtime is to be re-run against a
 * deliberately broken build and go red there.
 *
 * So: copy `src/` into `.test-tmp/mutants/<name>/src`, apply the edits, import
 * the copy's `manager.ts` (relative imports resolve inside the copy; package
 * imports resolve up to the repo's node_modules), and hand the caller a live,
 * mutated LaneManager it can run the SAME assertions against. Each edit must
 * match exactly once, so a mutation that silently stops applying — the classic
 * way a mutation harness rots into a no-op — fails loudly instead.
 */
export async function loadMutantManager(
  name: string,
  mutations: SrcMutation[],
): Promise<typeof import("../src/manager.js")> {
  return loadMutantModule<typeof import("../src/manager.js")>(name, mutations, "manager.ts");
}

/**
 * The same harness, entered at any module under `src/` rather than only
 * `manager.ts` — so a fix that lives in `worktree.ts` (base-ref order,
 * ownership marker) can be attacked at the exact function it changed instead of
 * only through the whole dispatch path. `entry` is the module the caller wants
 * back; the whole mutated `src/` tree is on disk either way, so relative
 * imports inside it resolve to mutated siblings.
 */
export async function loadMutantModule<M>(
  name: string,
  mutations: SrcMutation[],
  entry: string,
): Promise<M> {
  const root = materializeMutant(name, mutations);
  return (await import(pathToFileURL(path.join(root, "src", entry)).href)) as M;
}

/**
 * The same mutated `src/` tree, WITHOUT importing anything — the form the
 * sidecars need.
 *
 * `cursor-acp.ts` / `gemini-acp.ts` are standalone executables that connect an
 * ACP stream to stdio the moment they are imported, so a mutation harness
 * cannot reach them through `import`. It can SPAWN them: materialize the tree,
 * point a SpawnSpec at `<root>/src/<sidecar>.ts`, and run the same end-to-end
 * assertions against the broken build.
 *
 * Returns the mutant root; the caller joins `src/<file>` onto it.
 */
export function materializeMutant(name: string, mutations: SrcMutation[]): string {
  if (mutations.length === 0) throw new Error(`mutant '${name}' declares no mutation`);
  const root = path.join(MUTANTS_ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "src"), path.join(root, "src"), { recursive: true });
  for (const mutation of mutations) {
    const target = path.join(root, "src", mutation.file);
    const before = fs.readFileSync(target, "utf8");
    const occurrences = before.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `mutant '${name}': anchor for src/${mutation.file} matched ${occurrences} times, expected exactly 1 — ` +
          `the source moved and this mutation would prove nothing. Anchor:\n${mutation.find}`,
      );
    }
    fs.writeFileSync(target, before.replace(mutation.find, mutation.replace));
  }
  return root;
}

/**
 * Every existing worktree directory belonging to `branch`, whichever run
 * created it.
 *
 * A worktree path is `<sanitized branch>-<run id tail>` (#3), so a test that
 * wants to assert "no tree was created for this branch" can no longer name the
 * path in advance — and asserting on ONE derived path would pass while a tree
 * for a different run id sat right next to it.
 */
export function worktreesForBranch(branch: string): string[] {
  const safe = branch.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!fs.existsSync(WORKTREES_ROOT)) return [];
  return fs
    .readdirSync(WORKTREES_ROOT)
    .filter((entry) => entry === safe || entry.startsWith(safe + "-"))
    .map((entry) => path.join(WORKTREES_ROOT, entry));
}

/** Delete a mutant tree once its test is done (best-effort). */
export function dropMutant(name: string): void {
  fs.rmSync(path.join(MUTANTS_ROOT, name), { recursive: true, force: true });
}

/**
 * The suite's budget for waiting on something this process does NOT schedule:
 * a spawned worker reaching a state, a signal being delivered, a process group
 * being reaped, a file becoming visible. 15s (#29).
 *
 * The triage rule, and the reason this is a named constant rather than a number
 * per call site: a budget that waits on the OS has no upper bound this process
 * can compute, so its only job is to be far enough above the worst plausible
 * scheduling delay that a red result means "the thing never happened" and not
 * "the machine was busy". Every wall-clock red this repo has had was of that
 * second kind — gemini's process-group reclaim (2s), enforced-contract's
 * waitTerminal (5s, measured 8/12 red under parallel load), the cancel grace
 * (40ms) — each raised singly, after CI had already gone red.
 *
 * A budget is an UPPER BOUND, not a sleep: `until` returns the moment the
 * condition holds, so a healthy machine pays nothing for the headroom, and the
 * assertion stays "it happens", never "it happens fast".
 *
 * The other class — a deadline on work this process itself schedules (a timer
 * it set, a promise it holds, in-memory state) — stays tight on purpose, and so
 * does any assertion whose SUBJECT is a duration ("this wait must return before
 * its budget", "cancel must not resolve before the grace"). Those keep their
 * literal number and a comment saying why; do not fold them in here.
 */
export const OS_WAIT_BUDGET_MS = 15_000;

/**
 * Poll `fn` until it returns true, or throw if the deadline passes first.
 *
 * Every call site in this suite waits on a spawned fake-agent process, a pid's
 * liveness, or a file appearing — all OS-bound — so the default is
 * OS_WAIT_BUDGET_MS and call sites pass no number at all. An explicit budget
 * here therefore means "this site is deliberately different", which is what
 * makes the exceptions greppable.
 *
 * A silent-timeout version of this used to return `false` here, but none of
 * the ~30 call sites across the suite checked the return value — a timeout
 * would fall through to a downstream assertion that failed with an unrelated
 * message instead of naming the condition that never became true. Fail loudly
 * at the point of the actual timeout instead (mirrors the `waitUntil` in
 * test/gemini-acp.test.ts).
 */
export async function until(fn: () => boolean, timeoutMs = OS_WAIT_BUDGET_MS, stepMs = 20): Promise<true> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}
