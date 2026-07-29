/**
 * #19-F11 — the committed bundle IS the deployment.
 *
 * `plugin/.mcp.json` and `codex-plugin/.mcp.json` launch
 * `node dist/clanker-mcp.mjs`. Nothing compiles at install time, so the host
 * runs the bundle exactly as committed: `src/` is the reviewed source, but
 * `plugin/dist/` is the shipped server. Review one and merge the other and the
 * merge is a no-op on the running system.
 *
 * That is not hypothetical. #19 was reviewed three times with the bundles last
 * rebuilt in `7c16b3a`, before the first #19 commit. Everything the issue
 * claimed to change was absent from the artifact that would have been
 * deployed: the generic `clanker_start` entrance F1 deleted was still
 * registered (with caller-controlled `lane`/`read_only`/`sandbox`/`profile`),
 * no `clanker_start_<profile-id>` tool existed at all, F9's `result.md` was
 * never written, and F10's `run_dir`/`result_path`/`result_bytes` were missing
 * from the wait result the seats are told to read.
 *
 * `npm test` does not bundle and nothing compared the two, so the drift was
 * invisible to every gate in the repo — three cold reviews of `src/` could not
 * see it, because `src/` was right. The gate therefore has to compare
 * artifacts, not source:
 *
 *   1. Rebuild each artifact from the current source into a temp dir and
 *      require the committed file to be byte-identical. This catches drift of
 *      any kind, including drift in code nobody thought to grep for.
 *   2. Assert the properties #19 exists to establish, ON THE ARTIFACT. The
 *      byte-compare above is complete but mute; these name what a stale bundle
 *      would actually cost, so a failure reads as "the deployed server still
 *      has the forgeable entrance" instead of "1041233 bytes != 1039876".
 *
 * Both build definitions come from `scripts/bundle.ts`, the same module
 * `npm run bundle` executes, so the gate cannot disagree with the build about
 * how the artifacts are produced.
 */
import "./isolate.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUNDLES, PLUGIN_DIST_DIRS, REPO_ROOT, buildBundle } from "../scripts/bundle.js";

test("#19-F11: every committed plugin bundle is what the current source builds", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-bundle-sync-"));
  try {
    for (const bundle of BUNDLES) {
      // One rebuild per artifact, compared against every plugin's copy: the
      // hosts differ only by a runtime `--host` flag, so the bytes must not
      // differ at all.
      const rebuilt = fs.readFileSync(buildBundle(bundle, path.join(tmp, bundle.name)));
      for (const dir of PLUGIN_DIST_DIRS) {
        const committed = fs.readFileSync(path.join(REPO_ROOT, dir, bundle.name));
        assert.ok(
          committed.equals(rebuilt),
          `${dir}/${bundle.name} is not what ${bundle.entry} currently builds ` +
            `(committed ${committed.length} bytes, rebuilt ${rebuilt.length}). ` +
            `The plugins run the committed file, so this is a stale deployment: run 'npm run bundle' and commit the result.`,
        );
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#19-F11: the bundle a host would launch has the narrow entrances and the verdict file", () => {
  for (const dir of PLUGIN_DIST_DIRS) {
    const artifact = `${dir}/clanker-mcp.mjs`;
    const code = fs.readFileSync(path.join(REPO_ROOT, artifact), "utf8");
    // `assert.ok` rather than `assert.match`: the subject is a megabyte, and a
    // failing `match` prints all of it. A gate whose output nobody can read is
    // a gate people learn to skim past.
    const present = (pattern: RegExp): boolean => pattern.test(code);

    // F1: the generic entrance is gone from the deployed surface. A tool that
    // takes `profile` as a parameter reaches every profile, including
    // supervised ones on a host where they must not exist — one such tool
    // makes the whole narrow-registry property decoration.
    assert.ok(
      !present(/registerTool\(\s*"clanker_start"/),
      `${artifact} still registers the generic clanker_start entrance that src/tools.ts deleted`,
    );
    // ...and the narrow per-profile tools are there instead. The tool name is
    // built per registry row, so what a correct bundle contains is the
    // template, not any one literal name.
    assert.ok(
      present(/registerTool\(`clanker_start_\$\{/),
      `${artifact} registers no clanker_start_<profile-id> tools; the deployed server would have no dispatch entrance`,
    );

    // F9/F10: the run directory gets a readable verdict, and wait tells the
    // seat where it is. Without these the seats' instructions point at a file
    // the server never writes.
    assert.ok(present(/writeResultFileOnce/), `${artifact} never writes result.md (F9 absent from the deployment)`);
    assert.ok(
      present(/result_path/),
      `${artifact} returns no result_path (F10's backend half absent from the deployment)`,
    );
  }
});
