import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { choosePermissionOption } from "../src/acp-client.js";
import { DIGEST_CHAR_BUDGET, isGlmModel, SERVER_VERSION, resolveOcModel } from "../src/constants.js";
import { buildSpawnSpec } from "../src/backends.js";
import { resolveNodeBinary } from "../src/node-binary.js";
import { LaneRun } from "../src/run.js";
import { fileURLToPath } from "node:url";
import { dropMutant, loadMutantModule } from "./helpers.js";

/**
 * Anchored to this file, not to `process.cwd()`. The version sites below are
 * repo-relative facts, and a gate that silently reads a different tree when the
 * runner's cwd moves is a gate that can pass for the wrong reason.
 */
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// ---- CP3: opencode model shortname single source ------------------------

/**
 * Every place this repo writes its own version number, welded together.
 *
 * THE LIST WAS WRONG. Release doctrine here has said "five places" since the
 * habit started; the real count is SIX. `package-lock.json` carries the version
 * twice (top level, and again in the `""` root entry `npm` writes for the
 * project itself) and nothing ever looked at either — so it sat at 0.4.4 while
 * the other five went to 0.4.5 and then 0.4.6, drifting silently across two
 * releases until two seats happened to trip over it independently.
 *
 * That is the shape worth fixing, not the digits: the old assertion pinned
 * SERVER_VERSION to a LITERAL and compared three files to it, so a site missing
 * from the list was a site nothing could catch, and a site missing from the
 * list is exactly what happened.
 *
 * So this reads all six FROM DISK and asserts they agree with each other. It
 * deliberately does NOT name a version string: a test carrying the literal has
 * to be edited on every bump, which makes the test one more site to keep in
 * sync — the very failure it exists to prevent. It pins the SHAPE (six sites,
 * all equal, semver) and lets the value float.
 */
/**
 * The five sites that live in FILES, read relative to `root`.
 *
 * Parameterised on `root` for one reason: it is the only way the mutation
 * self-check below can doctor a site. The mutation harness copies `src/` and
 * nothing else, so a src-level mutant cannot express "package-lock.json says
 * 0.4.4" — which is the exact failure that went unnoticed for two releases and
 * therefore the exact one the self-check has to be able to stage.
 */
function fileVersionSites(root: string): Array<[string, unknown]> {
  const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const lock = json("package-lock.json");
  return [
    ["package.json .version", json("package.json").version],
    ["package-lock.json .version", lock.version],
    ['package-lock.json .packages[""].version', lock.packages?.[""]?.version],
    ["plugin/.claude-plugin/plugin.json .version", json("plugin/.claude-plugin/plugin.json").version],
    ["codex-plugin/.codex-plugin/plugin.json .version", json("codex-plugin/.codex-plugin/plugin.json").version],
  ];
}

/** Which sites disagree with `expected`, named. Empty means the six are welded. */
function versionDisagreements(root: string, expected: string): string[] {
  const sites: Array<[string, unknown]> = [
    ["src/constants.ts SERVER_VERSION", expected],
    ...fileVersionSites(root),
  ];
  return sites
    .filter(([, v]) => v !== expected)
    .map(([where, v]) => `${where}=${JSON.stringify(v)}`);
}

/** The four JSON files carrying a version, as `root`-relative paths. */
const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "plugin/.claude-plugin/plugin.json",
  "codex-plugin/.codex-plugin/plugin.json",
];

test("all six version sites agree — and the list is six, not five", () => {
  const sites = fileVersionSites(REPO_ROOT);
  assert.equal(
    sites.length + 1,
    6,
    "the doctrine says six sites; adding a seventh without updating this count is the same bug again",
  );
  // Shape first: a site that reads as `undefined` would make every equality
  // below vacuously true, which is how a gate rots into decoration.
  for (const [where, value] of sites) {
    assert.ok(
      typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value),
      `${where} must carry a semver string, got ${JSON.stringify(value)}`,
    );
  }
  assert.ok(/^\d+\.\d+\.\d+$/.test(SERVER_VERSION), `SERVER_VERSION must be semver, got ${SERVER_VERSION}`);
  assert.deepEqual(
    versionDisagreements(REPO_ROOT, SERVER_VERSION),
    [],
    `every version site must equal SERVER_VERSION (${SERVER_VERSION}); a bump that misses one ships a plugin ` +
      `whose manifest disagrees with the server inside it — which is how package-lock.json sat at 0.4.4 ` +
      `through two releases`,
  );
});

test("MUTANT: doctoring any single version site — including either half of package-lock — goes red", () => {
  // One staged mutant per file, run against a throwaway copy of the tree. The
  // package-lock case is the load-bearing one: before this test that site had
  // no reader at all, so "the suite is green" and "the lock is correct" were
  // unrelated facts.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-version-mutant-"));
  for (const rel of VERSION_FILES) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  // Baseline: the untouched copy must be quiet, or every red below proves
  // nothing about the doctoring.
  assert.deepEqual(versionDisagreements(root, SERVER_VERSION), [], "the pristine copy must agree with itself");

  const bogus = "9.9.9";
  for (const rel of VERSION_FILES) {
    const target = path.join(root, rel);
    const pristine = fs.readFileSync(target, "utf8");
    const doc = JSON.parse(pristine);
    doc.version = bogus;
    fs.writeFileSync(target, JSON.stringify(doc, null, 2));
    const found = versionDisagreements(root, SERVER_VERSION);
    assert.ok(
      found.some((f) => f.startsWith(rel + " ")),
      `doctoring ${rel} must be reported by name, got ${JSON.stringify(found)}`,
    );
    fs.writeFileSync(target, pristine);
  }

  // The lock's SECOND copy, the one npm writes for the project itself. It is
  // the half a hand-edit of line 3 would miss, so it gets its own mutant.
  const lockPath = path.join(root, "package-lock.json");
  const pristineLock = fs.readFileSync(lockPath, "utf8");
  const lock = JSON.parse(pristineLock);
  lock.packages[""].version = bogus;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  assert.ok(
    versionDisagreements(root, SERVER_VERSION).some((f) => f.includes('packages[""]')),
    "the lock's inner project entry must be checked separately from its top-level version",
  );
  fs.writeFileSync(lockPath, pristineLock);

  // And the sixth site, which is code rather than a file.
  assert.ok(
    versionDisagreements(root, bogus).some((f) => f.startsWith("package.json ")),
    "a SERVER_VERSION that agrees with nothing must be reported too",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("CP3: resolveOcModel expands shortnames and passes full ids through", () => {
  assert.equal(resolveOcModel("glm"), "zhipuai-coding-plan/glm-5.2");
  assert.equal(resolveOcModel("ds"), "deepseek/deepseek-v4-pro");
  assert.equal(resolveOcModel("kimi"), "kimi-for-coding/k3");
  assert.equal(resolveOcModel("free"), "opencode/deepseek-v4-flash-free");
  assert.equal(resolveOcModel("composer"), "xai/grok-composer-2.5-fast");
  assert.equal(resolveOcModel("grok45"), "xai/grok-4.5");
  assert.equal(resolveOcModel("anthropic/claude"), "anthropic/claude");
  assert.equal(resolveOcModel("unknown"), "unknown");
  assert.equal(resolveOcModel(undefined), undefined);
});

test("GLM supervision recognizes every model under the configured provider", () => {
  assert.equal(isGlmModel("glm"), true);
  assert.equal(isGlmModel(" zhipuai-coding-plan/GLM-5.2 "), true);
  assert.equal(isGlmModel("zhipuai-coding-plan/glm-5.3-future"), true);
  assert.equal(isGlmModel("other-provider/glm-5.2"), false);
  assert.equal(isGlmModel("composer"), false);
});

test("CP3: opencode lane pins the resolved model and dedicated worker in inline config", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-"));
  const spec = buildSpawnSpec("opencode", { model: "glm" }, runDir);
  assert.ok(spec.env.OPENCODE_CONFIG, "OPENCODE_CONFIG env is set");
  assert.ok(spec.env.OPENCODE_CONFIG_CONTENT, "highest-precedence inline config is set");
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.model, "zhipuai-coding-plan/glm-5.2");
  assert.equal(cfg.default_agent, "clanker-worker");
  assert.equal(cfg.agent?.["clanker-worker"]?.mode, "primary");
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.task, "deny");
  assert.deepEqual(cfg, JSON.parse(fs.readFileSync(spec.env.OPENCODE_CONFIG, "utf8")));
});

test("opencode read-only lane denies delegation, skills, external paths, edits, and shell", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-default-"));
  // Pin the model even for read-only work so an interactive OpenCode default
  // cannot silently select a different provider.
  const spec = buildSpawnSpec("opencode", { readOnly: true, model: "kimi" }, runDir);
  assert.ok(spec.env.OPENCODE_CONFIG, "OPENCODE_CONFIG env is set");
  assert.equal(spec.env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(spec.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.model, "kimi-for-coding/k3", "the caller's explicit model is pinned into the config");
  assert.equal(cfg.default_agent, "clanker-worker");
  assert.equal(cfg.agent?.["clanker-worker"]?.mode, "primary");
  assert.deepEqual(cfg.agent?.["clanker-worker"]?.permission, {
    // The MCP namespace: OpenCode flattens injected MCP tools to
    // `${server}_${tool}`, so this glob — not `task`/`skill`, which only match
    // the native tools of those names — is what stops a lane from reaching
    // `tachi_task`/`tachi_skill`. Observed live before this was added.
    "*_*": "deny",
    task: "deny",
    skill: "deny",
    external_directory: "deny",
    edit: "deny",
    bash: "deny",
  });
});

test("opencode write lane keeps worktree-local edit and shell enabled", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-write-"));
  const spec = buildSpawnSpec("opencode", { readOnly: false, model: "kimi" }, runDir);
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.edit, "allow");
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.bash, "allow");
  assert.equal(cfg.agent?.["clanker-worker"]?.permission?.external_directory, "deny");
});

test("OpenCode crew pins Kimi and delegates orchestration to the installed profile", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-crew-"));
  const spec = buildSpawnSpec("opencode", { model: "kimi", readOnly: false, profile: "kimi-crew" }, runDir);
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.model, "kimi-for-coding/k3");
  assert.equal(cfg.default_agent, "kimi-crew");
  assert.equal(cfg.agent, undefined, "Clanker does not inline or override the installed crew profile");
  assert.equal(spec.env.OPENCODE_DISABLE_CLAUDE_CODE, undefined, "crew preserves installed child profiles and skills");
  assert.equal(spec.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, undefined, "crew preserves external skill discovery");
  assert.deepEqual(cfg, JSON.parse(fs.readFileSync(spec.env.OPENCODE_CONFIG, "utf8")));
  assert.equal(spec.command, "opencode");
  assert.deepEqual(spec.args, ["acp"]);
});

// ---- vault-exec wiring: GLM's bare API key never touches the ambient env -
// Restored verbatim from 0.2.5 (26e9c9f test/units.test.ts:117-140). 69988a3
// replaced these two with their inverse ("spawns OpenCode directly") when it
// deleted wrapWithVaultExec one day after that wiring was merged (9cc0733);
// #19 reverses that deletion, so the assertion goes back to the stricter form.

test("GLM's opencode spawn is wrapped in tachi vault exec, original command intact after --", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-glm-vault-"));
  const spec = buildSpawnSpec("opencode", { model: "glm" }, runDir);
  assert.equal(spec.command, "tachi");
  assert.equal(spec.args[0], "vault");
  assert.equal(spec.args[1], "exec");
  assert.equal(spec.args[2], "--keychain");
  assert.equal(spec.args[3], "--require");
  assert.equal(spec.args[4], "ZHIPUAI_API_KEY");
  assert.equal(spec.args[5], "--");
  // Everything the un-wrapped opencode lane would have spawned (command +
  // args) survives intact after the `--` separator, byte-for-byte.
  assert.deepEqual(spec.args.slice(6), ["opencode", "acp"]);
  // env (OPENCODE_CONFIG/_CONTENT etc.) is untouched by the wrap — `tachi vault
  // exec` inherits it and injects only the vaulted var into the child.
  assert.ok(spec.env.OPENCODE_CONFIG_CONTENT, "opencode config env survives the wrap");
});

test("GLM full model id (not just the 'glm' shortname) also triggers the vault wrap", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-glm-full-"));
  const spec = buildSpawnSpec("opencode", { model: "zhipuai-coding-plan/glm-5.2" }, runDir);
  assert.equal(spec.command, "tachi");
  assert.deepEqual(spec.args.slice(0, 6), ["vault", "exec", "--keychain", "--require", "ZHIPUAI_API_KEY", "--"]);
});

// A read-only GLM dispatch carries the same bare API key as a write one, and
// the profile that starts it (oc-review) declares no secrets. The wrap must
// therefore stay keyed on the MODEL, not on the profile's declaration.
test("read-only GLM is wrapped too, even from a profile that declares no secrets", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-glm-ro-"));
  const spec = buildSpawnSpec("opencode", { model: "glm", readOnly: true, secrets: [] }, runDir);
  assert.equal(spec.command, "tachi");
  assert.deepEqual(spec.args.slice(0, 6), ["vault", "exec", "--keychain", "--require", "ZHIPUAI_API_KEY", "--"]);
});

test("OpenCode model aliases all use the same direct ACP spawn", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-nonglm-"));
  for (const model of ["kimi", "ds", "composer", "anthropic/claude"]) {
    const spec = buildSpawnSpec("opencode", { model }, runDir);
    assert.equal(spec.command, "opencode", `model='${model}' must use OpenCode directly`);
    assert.deepEqual(spec.args, ["acp"]);
  }
});

// An omitted model would let OpenCode's interactive config choose a provider
// that differs from the request Clanker records.
test("opencode spawn without an explicit model fails closed", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-no-model-"));
  assert.throws(
    () => buildSpawnSpec("opencode", { readOnly: true }, runDir),
    /opencode lane requires an explicit model id/,
    "read-only omission must fail closed rather than use an interactive default",
  );
  assert.throws(
    () => buildSpawnSpec("opencode", { readOnly: false }, runDir),
    /opencode lane requires an explicit model id/,
  );
  assert.throws(
    () => buildSpawnSpec("opencode", { model: "   " }, runDir),
    /opencode lane requires an explicit model id/,
    "a blank/whitespace-only model must not slip through as 'provided'",
  );
});

/**
 * #54's ROOT CAUSE, as distinct from #54's alarm.
 *
 * The dispatch that opened #54 named `gpt-5.6-sol` and got
 * `openai/gpt-5.6-terra-fast`. It was not OpenCode overriding a valid choice:
 * OpenCode's namespace has no bare model ids at all, so the id Clanker wrote
 * into opencode-config.json (still on disk at
 * ~/.cache/clanker/runs/opencode-b3b5c/opencode-config.json) resolved to
 * nothing and OpenCode fell back — silently. The corpus separates the two
 * cases with no overlap: prefixed ids were honored 36 times out of 41, bare
 * ids 0 times out of 4, and `openai/gpt-5.6-luna` vs bare `gpt-5.6-luna` is
 * the same model going both ways.
 *
 * A model id that cannot say which provider serves it is therefore not a
 * model id, and the honest failure is a refusal at spawn — where the caller
 * can still fix it — rather than a verdict filed against a model that never
 * ran.
 */
test("opencode spawn refuses a model id with no provider — bare ids resolve to nothing and fall back silently", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-bare-model-"));
  // The exact id from run opencode-b3b5c.
  assert.throws(
    () => buildSpawnSpec("opencode", { model: "gpt-5.6-sol", readOnly: true }, runDir),
    /names no provider/,
    "the id that opened #54 must not reach OpenCode a second time",
  );
  assert.throws(
    () => buildSpawnSpec("opencode", { model: "gpt-5.5" }, runDir),
    /names no provider/,
  );
  // The message has to be actionable: a caller who only sees "rejected" fixes
  // it by picking a different lane, which is how #53 and #54 combine into
  // "no reliable way to name a model at all".
  assert.throws(
    () => buildSpawnSpec("opencode", { model: "gpt-5.6-sol" }, runDir),
    /openai\/gpt-5\.6-sol/,
    "the refusal must show the caller the spelling that would have worked",
  );
  // Fully-qualified ids and every shortname that expands to one still pass:
  // the guard is about the SHAPE reaching OpenCode, not about a whitelist.
  for (const model of ["openai/gpt-5.6-sol", "kimi", "ds", "glm", "free", "composer", "grok45"]) {
    assert.ok(buildSpawnSpec("opencode", { model, readOnly: true }, runDir), `model='${model}' must still spawn`);
  }
});

test("MUTANT: guarding the caller's raw model instead of the resolved one refuses every shortname", async () => {
  // The one way this guard can rot into a bug: applied BEFORE alias expansion,
  // it reads `kimi` as "no provider" and rejects the corpus's single most
  // common opencode dispatch. Order is the whole content of the fix, so the
  // test has to be able to see the order.
  const name = "oc-bare-model-guard-order";
  try {
    const mutant = await loadMutantModule<typeof import("../src/backends.js")>(name, [{
      file: "backends.ts",
      find: 'if (model && !model.includes("/")) {',
      replace: 'if (opts.model && !opts.model.includes("/")) {',
    }], "backends.ts");
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oc-bare-mutant-"));
    assert.throws(
      () => mutant.buildSpawnSpec("opencode", { model: "kimi", readOnly: true }, runDir),
      /names no provider/,
      "the mutant must break the alias path — otherwise this test never observed guard-vs-alias order",
    );
    // And still refuse the real bare id, so the mutation is isolating order
    // rather than disabling the guard.
    assert.throws(
      () => mutant.buildSpawnSpec("opencode", { model: "gpt-5.6-sol", readOnly: true }, runDir),
      /names no provider/,
    );
  } finally {
    dropMutant(name);
  }
});

test("codex and grok lane spawn commands remain direct", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-oauth-lanes-"));
  const codexSpec = buildSpawnSpec("codex", {}, runDir);
  // resolveNodeBinary(), not process.execPath: since #37 the spawn command is
  // the recorded-and-still-existing node, so THAT is the true source this
  // assertion has to follow.
  assert.equal(codexSpec.command, resolveNodeBinary());
  const grokSpec = buildSpawnSpec("grok", { readOnly: true }, runDir);
  assert.equal(grokSpec.command, "grok");
});

// ---- grok process-local containment -------------------------------------

test("grok read-only lane overrides permissive user config with native containment", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-read-"));
  const spec = buildSpawnSpec("grok", { readOnly: true, effort: "high" }, runDir);
  assert.equal(spec.command, "grok");
  assert.deepEqual(spec.args, [
    "--sandbox",
    "read-only",
    "--permission-mode",
    "default",
    "--no-subagents",
    "agent",
    "--no-leader",
    "--model",
    "grok-4.5",
    "--reasoning-effort",
    "high",
    "stdio",
  ]);
});

test("grok write lane requests native workspace sandbox and honors a model override", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-grok-write-"));
  const spec = buildSpawnSpec("grok", { readOnly: false, model: "grok-preview" }, runDir);
  assert.deepEqual(spec.args, [
    "--sandbox",
    "workspace",
    "--permission-mode",
    "default",
    "--no-subagents",
    "agent",
    "--no-leader",
    "--model",
    "grok-preview",
    "stdio",
  ]);
});

// ---- codex sandbox override (review-seat workspace-write tier) ----------
//
// Verified against codex-acp 1.1.2 source (src/AgentMode.ts): INITIAL_AGENT_MODE
// accepts three ids ("read-only" | "agent" | "agent-full-access"), not the two
// this lane previously exposed. `sandbox` maps codex-acp's own sandboxMode
// vocabulary ("read-only" | "workspace-write" | "danger-full-access") onto
// those ids and takes precedence over the readOnly-derived legacy default.

test("codex sandbox='workspace-write' maps to INITIAL_AGENT_MODE=agent (the review-seat middle tier)", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  const spec = buildSpawnSpec("codex", { readOnly: true, sandbox: "workspace-write" }, runDir);
  assert.equal(spec.env.INITIAL_AGENT_MODE, "agent");
  assert.deepEqual(spec.warnings, []);
});

test("codex sandbox='read-only' and 'danger-full-access' map to the matching INITIAL_AGENT_MODE ids", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  assert.equal(buildSpawnSpec("codex", { sandbox: "read-only" }, runDir).env.INITIAL_AGENT_MODE, "read-only");
  assert.equal(
    buildSpawnSpec("codex", { sandbox: "danger-full-access" }, runDir).env.INITIAL_AGENT_MODE,
    "agent-full-access",
  );
});

test("codex with no sandbox override defaults writes to workspace-write", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  assert.equal(buildSpawnSpec("codex", { readOnly: true }, runDir).env.INITIAL_AGENT_MODE, "read-only");
  assert.equal(buildSpawnSpec("codex", { readOnly: false }, runDir).env.INITIAL_AGENT_MODE, "agent");
});

test("codex sandbox override takes precedence over readOnly when both are set", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  // readOnly: true would legacy-derive "read-only", but sandbox explicitly asks for the middle tier.
  const spec = buildSpawnSpec("codex", { readOnly: true, sandbox: "workspace-write" }, runDir);
  assert.equal(spec.env.INITIAL_AGENT_MODE, "agent");
});

test("grok/opencode warn and ignore the codex-only sandbox override", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-sandbox-"));
  const grokSpec = buildSpawnSpec("grok", { sandbox: "workspace-write" }, runDir);
  assert.ok(grokSpec.warnings.some((w) => /sandbox/.test(w)), `expected a sandbox warning, got ${JSON.stringify(grokSpec.warnings)}`);
  const ocSpec = buildSpawnSpec("opencode", { sandbox: "workspace-write", model: "kimi" }, runDir);
  assert.ok(ocSpec.warnings.some((w) => /sandbox/.test(w)), `expected a sandbox warning, got ${JSON.stringify(ocSpec.warnings)}`);
});

// NOTE (rebase merge resolution, 2026-07-18): the npx `@<version>`-pin test
// that used to live here ("codex lane spawns a version-pinned codex-acp,
// never @latest") is gone — this lane no longer spawns via npx at all (see
// "codex lane spawns codex-acp's local dist/index.js directly, not npx"
// below). Version pinning is now `package.json`'s exact dependency version,
// asserted by nothing here (it's enforced by `npm ci`/lockfile, not the spawn
// spec) — see the file header note in src/backends.ts.

// ---- codex multi_agent_v2 reserved-tool guard (2026-07-13 incident) -----
//
// codex-acp only runs Codex in app-server mode, which registers a
// collaboration.spawn_agent tool whenever multi_agent_v2 is on; the backend
// rejected that reserved schema for both the default and sol-override codex
// lanes as a turn-1, zero-tool-call HTTP 400. Clanker dispatches are solo by
// contract, so this must be off for every codex session regardless of model.

test("codex lane always disables multi_agent_v2 in CODEX_CONFIG, with no model override", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-"));
  const spec = buildSpawnSpec("codex", {}, runDir);
  assert.ok(spec.env.CODEX_CONFIG, "CODEX_CONFIG env is set even with no model/effort opts");
  const cfg = JSON.parse(spec.env.CODEX_CONFIG);
  assert.equal(cfg.features?.multi_agent_v2?.enabled, false);
});

// ---- codex lane pins model/effort so ~/.codex/config.toml can't silently
// swap the running model out from under a dispatch (2026-07-26 incident:
// an out-of-band config.toml edit swapped every codex dispatch onto
// gpt-5.3-codex-spark with zero signal, because an omitted model/effort
// used to fall back to whatever that file said). ------------------------

test("codex lane defaults model/effort in CODEX_CONFIG when no override is given", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-default-model-"));
  const spec = buildSpawnSpec("codex", {}, runDir);
  const cfg = JSON.parse(spec.env.CODEX_CONFIG);
  // Asserted against the Captain-pinned literals, not the imported constant —
  // comparing against the constant it was pulled from would make this
  // tautological (it would still pass if DEFAULT_CODEX_MODEL itself drifted).
  assert.equal(cfg.model, "gpt-5.5", "omitting model must NOT fall back to ~/.codex/config.toml");
  assert.equal(cfg.model_reasoning_effort, "xhigh");
});

test("codex lane keeps multi_agent_v2 disabled alongside a model override (e.g. sol lane)", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-sol-"));
  const spec = buildSpawnSpec("codex", { model: "gpt-5.6-sol" }, runDir);
  const cfg = JSON.parse(spec.env.CODEX_CONFIG);
  assert.equal(cfg.model, "gpt-5.6-sol");
  assert.equal(cfg.features?.multi_agent_v2?.enabled, false);
});

test("codex lane's explicit model/effort override wins over the pinned default", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-override-"));
  const spec = buildSpawnSpec("codex", { model: "gpt-5.6-sol", effort: "medium" }, runDir);
  const cfg = JSON.parse(spec.env.CODEX_CONFIG);
  assert.equal(cfg.model, "gpt-5.6-sol", "an explicit model must not be overwritten by the default");
  assert.equal(cfg.model_reasoning_effort, "medium", "an explicit effort must not be overwritten by the default");
});

// ---- codex lane: local dependency, not npx (2026-07-17 cold-start fix) --
//
// npx -y @agentclientprotocol/codex-acp cold-starts in ~35s per lane spawn
// (registry/package resolution round trip). Source mode resolves the pinned
// local dependency; installed plugins use the self-contained codex-acp.mjs
// sidecar built from it. CODEX_PATH tells either form which system `codex`
// binary to run, since --ignore-scripts skipped the dependency's own binary
// download.

test("codex lane resolves the pinned local codex-acp dependency in source mode, not npx", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-npx-"));
  const spec = buildSpawnSpec("codex", {}, runDir);
  assert.equal(spec.command, resolveNodeBinary(), "spawns via the running node binary, not `npx`");
  assert.equal(spec.args.length, 1, "single arg: the resolved entry script path");
  assert.ok(
    spec.args[0].endsWith(path.join("@agentclientprotocol", "codex-acp", "dist", "index.js")),
    `expected codex-acp's local dist/index.js, got: ${spec.args[0]}`,
  );
  assert.ok(fs.existsSync(spec.args[0]), "resolved entry script actually exists on disk");
});

test("packaged codex-acp sidecar is self-contained and executable", () => {
  // Single source of truth for the pinned version is package.json's exact
  // dependency declaration (see the NOTE above "codex lane resolves the
  // pinned local codex-acp dependency..."), not a literal hardcoded here —
  // a hardcoded version goes stale the moment the dependency is bumped,
  // and that staleness reads as a false regression, not a real one.
  const pinnedVersion = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).dependencies[
    "@agentclientprotocol/codex-acp"
  ];
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(pinnedVersion),
    `expected package.json to pin an exact codex-acp version, got: ${pinnedVersion}`,
  );
  const result = spawnSync(process.execPath, ["plugin/dist/codex-acp.mjs", "--version"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || "codex-acp sidecar did not execute");
  assert.match(
    result.stdout,
    new RegExp(`^@agentclientprotocol/codex-acp ${pinnedVersion.replace(/\./g, "\\.")}\\s*$`),
    `expected the packaged sidecar version to match package.json's pinned dependency (${pinnedVersion}), got: ${result.stdout}`,
  );
});

// NOTE (2026-07-25 hardening): under `npm test`, `node_modules/.bin` is on
// PATH ahead of everything else, and `node_modules/.bin/codex` is a real
// symlink to `@openai/codex`'s bin (a Clanker devDependency-of-a-dependency,
// not something the host needs installed). That means the test below
// structurally always exercises the "found on PATH" branch of
// resolveSystemCodexPath() and can never observe whether the *host* has
// codex installed — it verifies "resolves to an absolute, existing file",
// not "the host has codex". The fallback branch (nothing executable found,
// return the bare "codex" string) is covered separately below by sealing
// PATH down to an empty directory.

test("codex lane resolves CODEX_PATH to an absolute, existing file when PATH provides a `codex` executable — not the bare alias name", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-path-"));
  const spec = buildSpawnSpec("codex", {}, runDir);
  assert.ok(spec.env.CODEX_PATH, "CODEX_PATH env is set");
  assert.notEqual(spec.env.CODEX_PATH, "codex", "must resolve past the bare name to an absolute path");
  assert.ok(path.isAbsolute(spec.env.CODEX_PATH), "CODEX_PATH is an absolute path");
  assert.ok(fs.existsSync(spec.env.CODEX_PATH), "CODEX_PATH points at a file that actually exists");
});

test("codex lane falls back to the bare 'codex' name when PATH has no executable codex on it", () => {
  // Seal PATH down to a single, freshly created, guaranteed-empty directory
  // (not a subtractive filter of the real PATH, and not a subprocess with
  // an inherited shell environment) so this only ever tests
  // resolveSystemCodexPath()'s own PATH-scanning logic, in-process.
  const sealedBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-no-codex-bin-"));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = sealedBinDir;
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-codex-fallback-"));
    const spec = buildSpawnSpec("codex", {}, runDir);
    assert.equal(
      spec.env.CODEX_PATH,
      "codex",
      "with nothing executable found on PATH, resolution must fall back to the bare name (leaving the ENOENT to codex-acp), not throw or fabricate a path",
    );
  } finally {
    process.env.PATH = savedPath;
  }
});

// ---- CP5: read-only never auto-approves ---------------------------------

test("CP5: read-only with only an allow option declines (cancelled), never selects allow", () => {
  const res = choosePermissionOption([{ optionId: "a", kind: "allow_once" }], true);
  assert.equal(res.outcome.outcome, "cancelled");
});

test("CP5: read-only selects an available reject option", () => {
  const res = choosePermissionOption(
    [
      { optionId: "r", kind: "reject_once" },
      { optionId: "a", kind: "allow_once" },
    ],
    true,
  );
  assert.equal(res.outcome.outcome, "selected");
  assert.equal(res.outcome.outcome === "selected" ? res.outcome.optionId : "", "r");
});

test("CP5: write mode selects the first allow option", () => {
  const res = choosePermissionOption(
    [
      { optionId: "a1", kind: "allow_once" },
      { optionId: "a2", kind: "allow_always" },
    ],
    false,
  );
  assert.equal(res.outcome.outcome, "selected");
  assert.equal(res.outcome.outcome === "selected" ? res.outcome.optionId : "", "a1");
});

test("CP5: empty options always cancel", () => {
  assert.equal(choosePermissionOption([], false).outcome.outcome, "cancelled");
  assert.equal(choosePermissionOption([], true).outcome.outcome, "cancelled");
});

// ---- CP4: digest is capped at the char budget ---------------------------

test("CP4: a large event burst yields a digest at/under the char budget with a truncation marker", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({
    id: "unit-1",
    lane: "codex",
    cwd: os.tmpdir(),
    runDir,
    readOnly: true,
  });
  run.beginTurn("overflow");
  for (let i = 0; i < 80; i++) {
    run.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: `t${i}`,
      title: `overflow tool call number ${i} with a deliberately longish title`,
      status: "completed",
    } as unknown as SessionUpdate);
  }
  const digest = run.drainDigest();
  assert.ok(digest.length > 0, "digest is non-empty");
  assert.ok(
    digest.length <= DIGEST_CHAR_BUDGET + 2,
    `digest length ${digest.length} should be <= budget ${DIGEST_CHAR_BUDGET} (+2 marker)`,
  );
  assert.ok(digest.startsWith("…"), "over-budget digest starts with the truncation marker");
  run.closeStreams();
});

test("terminal events after session close remain ordered and do not reopen artifact streams", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-close-"));
  const run = new LaneRun({
    id: "unit-close-streams",
    lane: "codex",
    cwd: os.tmpdir(),
    runDir,
    readOnly: true,
  });
  run.beginTurn("finish after teardown");
  await run.markClosed();
  await run.completeTurn();

  const streams = run as unknown as { eventsStream: unknown; chunksStream: unknown };
  assert.equal(streams.eventsStream, null);
  assert.equal(streams.chunksStream, null);
  const eventTypes = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { t: string }).t);
  assert.deepEqual(eventTypes.slice(-2), ["session_closed", "turn_done"]);
});

test("identical normalized plans are activity but not a second significant digest", () => {
  const run = new LaneRun({ id: "plan-dedupe", lane: "codex", cwd: os.tmpdir(),
    runDir: fs.mkdtempSync(path.join(os.tmpdir(), "clanker-plan-")), readOnly: true });
  const first = { sessionUpdate: "plan", entries: [{ content: "one", status: "in_progress", priority: "high" }] } as unknown as SessionUpdate;
  run.onUpdate(first);
  run.drainDigest();
  run.onUpdate(first);
  assert.equal(run.hasUnreportedSignificant(), false);
  run.onUpdate({ sessionUpdate: "plan", entries: [{ content: "one", status: "completed", priority: "high" }] } as unknown as SessionUpdate);
  assert.equal(run.hasUnreportedSignificant(), true);
});

// ---- clanker_wait quiet-mode debounce: significant vs trivial events -----

test("hasUnreportedSignificant: trivial tool_call/location events don't count as significant", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-1", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("grep the repo");
  run.drainDigest(); // consume the (significant) turn_start entry first
  assert.equal(run.hasUnreportedSignificant(), false, "no significant event pending after drain");

  // A run of grep/read-shaped tool calls — exactly the "every grep fires an
  // event" noise clanker_wait's quiet mode exists to not wake on.
  for (let i = 0; i < 5; i++) {
    run.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: `t${i}`,
      title: `grep -n foo file${i}.ts`,
      status: "completed",
      locations: [{ path: `${os.tmpdir()}/file${i}.ts` }],
    } as unknown as SessionUpdate);
  }
  assert.equal(run.hasUnreported(), true, "seq did advance (there is a digest to drain)");
  assert.equal(
    run.hasUnreportedSignificant(),
    false,
    "tool_call + file-location echoes alone are not significant",
  );
  run.closeStreams();
});

test("hasUnreportedSignificant: a plan update is significant", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-2", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("do the plan thing");
  run.drainDigest();
  run.onUpdate({
    sessionUpdate: "plan",
    entries: [{ content: "step one", priority: "high", status: "in_progress" }],
  } as unknown as SessionUpdate);
  assert.equal(run.hasUnreportedSignificant(), true, "a plan change is significant");
  run.drainDigest();
  assert.equal(run.hasUnreportedSignificant(), false, "drain resets the significant cursor");
  run.closeStreams();
});

test("hasUnreportedSignificant: a failed tool_call_update is significant", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-3", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("do a thing that fails");
  run.drainDigest();
  run.onUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t-fail",
    title: "risky op",
    status: "in_progress",
  } as unknown as SessionUpdate);
  assert.equal(run.hasUnreportedSignificant(), false, "tool_call start alone is trivial");
  run.onUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-fail",
    status: "failed",
  } as unknown as SessionUpdate);
  assert.equal(run.hasUnreportedSignificant(), true, "a tool error is significant");
  run.closeStreams();
});

test("suspectedStallEdge fires once per stall episode, not on every call while still silent", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-run-"));
  const run = new LaneRun({ id: "unit-quiet-4", lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("go quiet");
  // Threshold -1 guarantees "stalled" is true from t=0 regardless of clock
  // granularity, isolating the edge-vs-level distinction from real timing.
  assert.equal(run.suspectedStallEdge(-1), true, "first observation of a stall fires the edge");
  assert.equal(
    run.suspectedStallEdge(-1),
    false,
    "a second call with no new event in between must NOT re-fire (busy-poll guard)",
  );
  assert.equal(
    run.suspectedStallEdge(-1),
    false,
    "and a third call still must not re-fire — this is what protected against the busy-spin regression",
  );
  // A real event clears the edge so a later stall can fire again.
  run.onUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t-after-stall",
    title: "still alive",
    status: "completed",
  } as unknown as SessionUpdate);
  assert.equal(run.suspectedStallEdge(-1), true, "a fresh event re-arms the stall edge");
  run.closeStreams();
});

// ---- #48: a vendor refusal must not reach a terminal `done` ---------------

/** The turn's whole output, verbatim from run codex-45fd0 (gpt-5.5, 2026-07-29). */
const REFUSAL_PAGE_45FD0 =
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your " +
  "request. To get authorized for security work, join the Trusted Access for Cyber program: " +
  "https://chatgpt.com/cyber";

function refusalRun(id: string, message: string): { run: LaneRun; runDir: string } {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `clanker-${id}-`));
  const run = new LaneRun({ id, lane: "codex", cwd: os.tmpdir(), runDir, readOnly: true });
  run.beginTurn("ADVERSARIAL COLD REVIEW: prove the remediation wrong");
  run.onUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: message },
  } as unknown as SessionUpdate);
  return { run, runDir };
}

test("#48: a turn whose whole output is a vendor refusal page goes terminal ERROR, not done", async () => {
  // The turn SUCCEEDS at the protocol layer — stop_reason end_turn, which is
  // why completeTurn() is the entry point and why this was invisible: it
  // produced `status: done` with a result_path, exactly like a clean read-only
  // review. A dispatcher reading that books a review that never happened.
  const { run, runDir } = refusalRun("unit-vendor-refusal", REFUSAL_PAGE_45FD0);
  await run.completeTurn();

  assert.equal(run.turnStatus, "error", "the terminal state must be loud, never `done`");
  assert.equal(run.failureClass, "CLANKER-VENDOR-REFUSAL");
  assert.ok(run.error && run.error.length > 0, "and it carries an error a dispatcher can read");

  // The page itself survives verbatim: the reader has to be able to see WHAT
  // the vendor said, not just that something went wrong.
  const resultMd = fs.readFileSync(path.join(runDir, "result.md"), "utf8");
  assert.match(resultMd, /^- status: error$/m);
  assert.match(resultMd, /failure_class: CLANKER-VENDOR-REFUSAL/);
  assert.ok(
    resultMd.includes(REFUSAL_PAGE_45FD0),
    "result.md must still carry the refusal page verbatim under ## final_message",
  );
  run.closeStreams();
});

test("#48: an ordinary short verdict still completes as done", async () => {
  // The false-positive control, and the reason the criterion is lexical: this
  // run is shorter and faster than the refusal on every structural axis the
  // telemetry carries (run codex-a581b answered `0.4.3` in 12s; codex-45fd0
  // refused in 15s). A criterion built on duration or tool count destroys it.
  const { run, runDir } = refusalRun("unit-short-verdict", "0.4.3");
  await run.completeTurn();

  assert.equal(run.turnStatus, "done");
  assert.equal(run.failureClass, undefined);
  assert.match(fs.readFileSync(path.join(runDir, "result.md"), "utf8"), /^- status: done$/m);
  run.closeStreams();
});

test("mutant: without the completeTurn guard, the refusal page ships as a clean `done` verdict", async () => {
  // The regression this whole class exists to prevent, restored line for line.
  // A declaration-level test would stay green under it — result.md still
  // exists, still has a final_message, still has a result_path — which is
  // precisely how the real incident got past every automated check.
  const name = "run-no-vendor-refusal-guard";
  const mutated = await loadMutantModule<typeof import("../src/run.js")>(name, [
    {
      file: "run.ts",
      find: "    const refusal = classifyVendorRefusal(finalMessage);",
      replace: "    const refusal = undefined as ReturnType<typeof classifyVendorRefusal>;",
    },
  ], "run.ts");
  try {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-mutant-refusal-"));
    const run = new mutated.LaneRun({
      id: "unit-vendor-refusal-mutant",
      lane: "codex",
      cwd: os.tmpdir(),
      runDir,
      readOnly: true,
    });
    run.beginTurn("ADVERSARIAL COLD REVIEW: prove the remediation wrong");
    run.onUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: REFUSAL_PAGE_45FD0 },
    } as unknown as SessionUpdate);
    await run.completeTurn();

    assert.equal(run.turnStatus, "done", "pre-fix, a refusal page is indistinguishable from a verdict");
    assert.equal(run.failureClass, undefined);
    assert.match(fs.readFileSync(path.join(runDir, "result.md"), "utf8"), /^- status: done$/m);
    run.closeStreams();
  } finally {
    dropMutant(name);
  }
});
