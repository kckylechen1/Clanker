import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  return import(pathToFileURL(path.join(root, "src", "manager.ts")).href);
}

/** Delete a mutant tree once its test is done (best-effort). */
export function dropMutant(name: string): void {
  fs.rmSync(path.join(MUTANTS_ROOT, name), { recursive: true, force: true });
}

/**
 * Poll `fn` until it returns true, or throw if the deadline passes first.
 *
 * A silent-timeout version of this used to return `false` here, but none of
 * the ~30 call sites across the suite checked the return value — a timeout
 * would fall through to a downstream assertion that failed with an unrelated
 * message instead of naming the condition that never became true. Fail loudly
 * at the point of the actual timeout instead (mirrors the `waitUntil` in
 * test/gemini-acp.test.ts:38-42).
 */
export async function until(fn: () => boolean, timeoutMs = 4000, stepMs = 20): Promise<true> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}
