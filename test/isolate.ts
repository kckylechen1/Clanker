/**
 * Host-isolation floor for the test suite. **Must be the first import in every
 * `test/*.test.ts`** — `test/isolation-contract.test.ts` enforces that.
 *
 * Why it exists (2026-07-29, #29): isolation used to hold on exactly one path,
 * `npm test`, whose script injects `CLANKER_RUNS_ROOT` /
 * `CLANKER_WORKTREES_ROOT` / `CLANKER_LEDGER_DIR`. The command everyone
 * actually types while debugging a single file —
 *
 *     node --import tsx/esm --test test/<one>.test.ts
 *
 * — carries none of them, so `src/constants.ts` and `src/ledger.ts` fall back
 * to `~/.cache/clanker/` and `~/.agents/dispatch-ledger/`, and the tests write
 * into the REAL host state. That is not merely untidy: it left 34 leaked
 * worktrees under `~/.cache/clanker/worktrees`, which is the exact surface the
 * orphan scan (#32) and worktree retention read to decide what is a live tree.
 * A test's leftover tree and a genuinely retained deliverable look identical
 * there.
 *
 * The rule this module encodes is the same one the rest of the repo uses:
 * **default safe, deviate loudly.** An unset root is redirected under the
 * repo's own `.test-tmp/` and announced on stderr; an explicitly set root is
 * left exactly as the caller set it (so `npm test` keeps full control, and a
 * test that wants its own scratch root still gets it).
 *
 * Why an import and not a `--import` preload: the preload only exists on the
 * command lines we already control, which is precisely the assumption that
 * failed. Ordering is load-bearing — `src/constants.ts` and `src/ledger.ts`
 * read `process.env` at module scope, and ESM evaluates a module's imports in
 * source order, depth-first. Putting this module ahead of the first `import`
 * statement in a test file guarantees its body runs before any `src/` module is
 * evaluated. Putting it inside `helpers.ts` alone would NOT: most test files
 * import `../src/manager.js` before `./helpers.js`, and `helpers.ts` itself
 * imports `../src/constants.js`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The env vars that decide whether a test writes to scratch or to the host. */
export const ISOLATED_ROOTS: Readonly<Record<string, string>> = {
  CLANKER_RUNS_ROOT: path.join(REPO_ROOT, ".test-tmp", "runs"),
  CLANKER_WORKTREES_ROOT: path.join(REPO_ROOT, ".test-tmp", "worktrees"),
  CLANKER_LEDGER_DIR: path.join(REPO_ROOT, ".test-tmp", "ledger"),
};

/**
 * Names of the roots this process had to default. Empty when the caller (e.g.
 * `npm test`) set all three itself.
 */
export const DEFAULTED_ROOTS: readonly string[] = applyIsolation();

function applyIsolation(): string[] {
  const defaulted: string[] = [];
  for (const [name, fallback] of Object.entries(ISOLATED_ROOTS)) {
    // Blank counts as unset, matching src/ledger.ts's #37 D2 handling: an
    // unset shell var interpolated into a quoted arg arrives as "".
    if (process.env[name]?.trim()) continue;
    process.env[name] = fallback;
    defaulted.push(name);
  }
  if (defaulted.length > 0) {
    console.warn(
      `[clanker-test] host isolation was not set up by the caller; defaulting ` +
        `${defaulted.join(", ")} under ${path.join(REPO_ROOT, ".test-tmp")}. ` +
        `Without this these tests would write into ~/.cache/clanker and ` +
        `~/.agents/dispatch-ledger (#29). Use \`npm test\` for the full run.`,
    );
  }
  return defaulted;
}
