/**
 * #54: a backend that runs a DIFFERENT model than the one it was dispatched to
 * must say so in `warnings`, not only in a telemetry field nobody diffs.
 *
 * Why this matters more than it sounds: the failure is not "slower model". It
 * is MISATTRIBUTION. A cold review that actually ran on model B gets filed
 * under model A, and every later judgement about A — its lane card, whether it
 * is trusted for design work — is then built on B's output. This machine has
 * paid for that once already (an opencode lane silently served its bundled
 * model when `kimi-for-coding` auth failed; four dispatches of profile data had
 * to be thrown away) and #54 is the same lane doing it again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLASSIFICATION IS THE HARD PART, AND IT WAS DERIVED FROM DATA.
 *
 * Every case below is a shape that really occurs in ~/.cache/clanker/runs
 * (589 run directories, 527 with telemetry, scanned 2026-07-29), carrying the
 * run id it was taken from. The counts are why the rule is shaped this way —
 * of the 121 records that have both a resolved and an observed model (three
 * more are this suite's own fixtures, see fake-acp-agent.mjs), 74 differ as
 * strings and only 15 are real swaps:
 *
 *   26 records  caller passed a SHORTNAME or took a lane default, backend
 *               reported the expanded id (`kimi` -> `kimi-for-coding/k3`).
 *               Comparing `requested_model` would call 23 of them a swap.
 *               -> compare `resolved_model`.
 *   58 records  cursor reported its own DISPLAY NAME for the id it was given
 *               (`composer-2.5` -> `Composer 2.5`). -> case/separator folding.
 *    1 record   cursor's display name dropped a trailing qualifier
 *               (`cursor-grok-4.5-high` -> `Cursor Grok 4.5`, cursor-1b5da).
 *               -> token-prefix comparison, per cursor-acp.ts's own note that
 *               a reader "should compare model FAMILY, not string equality".
 *    0 records  provider prefix ALONE. Reachable but unobserved, and guarded
 *               anyway — #54 names it as the misjudgement that would turn the
 *               alarm into noise, and the opencode fix in backends.ts makes it
 *               the shape a corrected b3b5c dispatch would have had.
 *   15 records  GENUINE swaps: 9 opencode, 6 cursor. -> must fire.
 *
 * A false alarm here is not a small cost: a warning that fires on routine alias
 * expansion is noise, and an alarm nobody believes is not an alarm. That is the
 * one failure mode this rule is not allowed to have, so the negative cases
 * below are load-bearing assertions, not padding.
 */
import "./isolate.js";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { LaneManager, type WaitResult } from "../src/manager.js";
import { modelSwapWarning, sameModelFamily } from "../src/constants.js";
import { OS_WAIT_BUDGET_MS, dropMutant, fakeResolver, loadMutantManager, loadMutantModule } from "./helpers.js";

/** Real (resolved, observed) pairs from the corpus that MUST NOT warn, with their provenance. */
const SAME_MODEL: Array<[string, string, string]> = [
  // Alias expansion: the corpus's single largest mismatch class.
  ["kimi-for-coding/k3", "kimi-for-coding/k3", "opencode-139f7 +18 (requested_model was the shortname `kimi`)"],
  // Provider prefix only — the shape #54 names explicitly as the one that must
  // stay quiet: same model, different routing.
  ["gpt-5.6-sol", "openai/gpt-5.6-sol", "the shape opencode-b3b5c would have had if its dispatch had landed"],
  ["openai/gpt-5.6-luna", "opencode/gpt-5.6-luna", "two providers serving one model (opencode's registry has both)"],
  // Vendor display name: case + separators.
  ["composer-2.5", "Composer 2.5", "cursor-101ec +57"],
  // Vendor display name that dropped the effort qualifier.
  ["cursor-grok-4.5-high", "Cursor Grok 4.5", "cursor-1b5da"],
];

/** Real (resolved, observed) pairs from the corpus that MUST warn, with their provenance. */
const DIFFERENT_MODEL: Array<[string, string, string]> = [
  ["gpt-5.6-sol", "openai/gpt-5.6-terra-fast", "opencode-b3b5c — the run that opened #54"],
  ["kimi-for-coding/k3", "opencode/big-pickle", "opencode-14bb3 +3 — the kimi-k3 incident"],
  ["deepseek/deepseek-v4-pro", "opencode/big-pickle", "opencode-1cfc8"],
  ["gpt-5.6-luna", "opencode/big-pickle", "opencode-1f0e5"],
  ["gpt-5.5", "opencode/big-pickle", "opencode-11633, opencode-18341"],
  ["cursor-grok-4.5-high", "Composer 2.5", "cursor-11c10 +5"],
];

test("#54 corpus: alias expansion, provider prefixes and vendor display names are NOT swaps", () => {
  for (const [resolved, observed, provenance] of SAME_MODEL) {
    assert.ok(
      sameModelFamily(resolved, observed),
      `'${resolved}' vs '${observed}' must read as one model (${provenance})`,
    );
    assert.equal(
      modelSwapWarning(resolved, observed),
      null,
      `warning on '${resolved}' vs '${observed}' would be noise (${provenance})`,
    );
  }
});

test("#54 corpus: every real substitution fires, and the text says which model to attribute the run to", () => {
  for (const [resolved, observed, provenance] of DIFFERENT_MODEL) {
    const warning = modelSwapWarning(resolved, observed);
    assert.ok(warning, `'${resolved}' vs '${observed}' is a real swap and must warn (${provenance})`);
    // Both ids in full: the reader's next action is deciding which model this
    // run's output gets recorded against, and "model mismatch" alone does not
    // tell them which of the two won.
    assert.ok(warning.includes(resolved), `warning must name what was dispatched: ${warning}`);
    assert.ok(warning.includes(observed), `warning must name what actually ran: ${warning}`);
    assert.match(warning, /attribute/i, `warning must say what to DO with the fact: ${warning}`);
  }
});

test("#54: an unreported observed_model is missing evidence, not evidence of a swap", () => {
  // 78 corpus records name a resolved model and carry no observed one at all.
  // Warning on those would mean the alarm fires mostly on lanes that simply do
  // not report, which is how an alarm decays into background noise.
  assert.equal(modelSwapWarning("openai/gpt-5.5", null), null);
  assert.equal(modelSwapWarning("openai/gpt-5.5", undefined), null);
  assert.equal(modelSwapWarning("openai/gpt-5.5", "   "), null);
  assert.equal(modelSwapWarning(null, "opencode/big-pickle"), null);
});

// ---- end to end: does it actually reach a clanker_wait caller? -------------

function managerOpts(resolveSpec = fakeResolver) {
  return {
    resolveSpec,
    disableReaper: true,
    baseRepo: os.tmpdir(),
    stallThresholdMs: 300_000,
    sessionTtlMs: 600_000,
    turnTimeoutMs: 2_700_000,
  };
}

async function waitTerminal(m: LaneManager, id: string): Promise<WaitResult> {
  const deadline = Date.now() + OS_WAIT_BUDGET_MS;
  let last!: WaitResult;
  while (Date.now() < deadline) {
    last = await m.wait(id, 200);
    if (last.status !== "running") return last;
  }
  return last;
}

/** Dispatch asking for `model`, have the fake backend report `observed`, return the terminal wait. */
async function runReporting(m: LaneManager, model: string, observed: string): Promise<WaitResult> {
  const { id } = await m.dispatchStart({
    lane: "codex",
    prompt: `OBSERVE_MODEL ${observed}`,
    cwd: os.tmpdir(),
    readOnly: true,
    model,
  });
  return await waitTerminal(m, id);
}

test("#54 end to end: a swapped model reaches the wait caller as a warning", async () => {
  const m = new LaneManager(managerOpts());
  try {
    const result = await runReporting(m, "gpt-5.6-sol", "openai/gpt-5.6-terra-fast");
    assert.equal(result.telemetry?.observed_model, "openai/gpt-5.6-terra-fast");
    const warning = (result.warnings ?? []).find((w) => w.includes("model swap"));
    assert.ok(warning, `expected a swap warning on the wait result, got ${JSON.stringify(result.warnings)}`);
    assert.ok(warning.includes("gpt-5.6-sol") && warning.includes("openai/gpt-5.6-terra-fast"), warning);
  } finally {
    await m.shutdown();
  }
});

test("#54 end to end: the same dispatch honored — provider prefix only — stays quiet", async () => {
  const m = new LaneManager(managerOpts());
  try {
    const result = await runReporting(m, "gpt-5.6-sol", "openai/gpt-5.6-sol");
    assert.equal(result.telemetry?.observed_model, "openai/gpt-5.6-sol");
    assert.deepEqual(
      (result.warnings ?? []).filter((w) => w.includes("model swap")),
      [],
      "a provider prefix is not a swap; warning here would make the real alarm unbelievable",
    );
  } finally {
    await m.shutdown();
  }
});

test("#54 end to end: the warning is raised while the run is still LIVE, not only at terminal", async () => {
  // A dispatcher who only learns about the swap after the run finishes has
  // already paid for it. `observed_model` is knowable the moment the backend
  // reports it, so the warning is derived on every wait rather than latched at
  // the terminal flip — and this asserts on a wait whose status is `running`.
  const m = new LaneManager(managerOpts());
  try {
    const { id } = await m.dispatchStart({
      lane: "codex",
      // The fake agent reports the model and then falls through to
      // STALL_ACTIVITY, so the run stays alive and streaming with the swap
      // already visible.
      prompt: "OBSERVE_MODEL opencode/big-pickle then STALL_ACTIVITY",
      cwd: os.tmpdir(),
      readOnly: true,
      model: "kimi-for-coding/k3",
    });
    const deadline = Date.now() + OS_WAIT_BUDGET_MS;
    let live: WaitResult | undefined;
    while (Date.now() < deadline) {
      const w = await m.wait(id, 200);
      if ((w.warnings ?? []).some((x) => x.includes("model swap"))) { live = w; break; }
      if (w.status !== "running") break;
    }
    assert.ok(live, "no swap warning appeared on a live run before the budget ran out");
    assert.equal(live.status, "running", "the point of this test is a NON-terminal wait carrying the warning");
    await m.cancel(id);
  } finally {
    await m.shutdown();
  }
});

// ---- mutation self-checks -------------------------------------------------
//
// Each breaks exactly one clause of the rule and asserts the suite goes RED
// there. A classification test that stays green against a build with the
// classification removed is not testing the classification.

test("MUTANT: comparing requested_model instead of resolved_model turns alias expansion into false alarms", async () => {
  const name = "swap-compares-requested";
  try {
    const mutant = await loadMutantManager(name, [{
      file: "manager.ts",
      find: "const swap = modelSwapWarning(telemetry.resolved_model, telemetry.observed_model);",
      replace: "const swap = modelSwapWarning(telemetry.requested_model, telemetry.observed_model);",
    }]);
    const m = new mutant.LaneManager(managerOpts()) as unknown as LaneManager;
    try {
      // NOT a swap: this is the corpus's most common correct dispatch — caller
      // names an alias, backend reports the expanded id.
      const { id } = await m.dispatchStart({
        lane: "opencode",
        prompt: "OBSERVE_MODEL kimi-for-coding/k3",
        cwd: os.tmpdir(),
        readOnly: true,
        model: "kimi",
      });
      const result = await waitTerminal(m, id);
      assert.ok(
        (result.warnings ?? []).some((w) => w.includes("model swap")),
        "the mutant must go LOUD on a correct alias expansion — if it stays quiet, this test never " +
          "observed the requested-vs-resolved choice at all",
      );
    } finally {
      await m.shutdown();
    }
  } finally {
    dropMutant(name);
  }
});

test("MUTANT: dropping the provider-prefix fold makes an honored dispatch fire", async () => {
  const name = "swap-keeps-provider";
  try {
    const mutant = await loadMutantModule<typeof import("../src/constants.js")>(name, [{
      file: "constants.ts",
      find: 'const withoutProvider = id.slice(id.lastIndexOf("/") + 1);',
      replace: "const withoutProvider = id;",
    }], "constants.ts");
    assert.equal(
      mutant.sameModelFamily("gpt-5.6-sol", "openai/gpt-5.6-sol"),
      false,
      "without the prefix fold these must read as different models — else the fold was never load-bearing",
    );
    assert.ok(
      mutant.modelSwapWarning("gpt-5.6-sol", "openai/gpt-5.6-sol"),
      "the mutant must raise exactly the false alarm #54 forbids",
    );
    // The genuine swap must still fire in the mutant, so this mutation isolates
    // the prefix rule rather than breaking the check outright.
    assert.ok(mutant.modelSwapWarning("gpt-5.6-sol", "openai/gpt-5.6-terra-fast"));
  } finally {
    dropMutant(name);
  }
});

test("MUTANT: dropping the display-name fold makes every cursor run a false alarm", async () => {
  const name = "swap-case-sensitive";
  try {
    const mutant = await loadMutantModule<typeof import("../src/constants.js")>(name, [{
      file: "constants.ts",
      find: 'return withoutProvider.toLowerCase().replace(/[\\s_]+/g, "-").split("-").filter((t) => t.length > 0);',
      replace: 'return withoutProvider.split("-").filter((t) => t.length > 0);',
    }], "constants.ts");
    assert.ok(
      mutant.modelSwapWarning("composer-2.5", "Composer 2.5"),
      "the mutant must fire on the 58 corpus records that are one model reported in two spellings",
    );
    assert.ok(mutant.modelSwapWarning("gpt-5.6-sol", "openai/gpt-5.6-terra-fast"), "real swaps must still fire");
  } finally {
    dropMutant(name);
  }
});

test("MUTANT: string equality instead of family comparison fires on the cursor display name", async () => {
  const name = "swap-string-equality";
  try {
    const mutant = await loadMutantModule<typeof import("../src/constants.js")>(name, [{
      file: "constants.ts",
      find: "  return shorter.every((token, i) => token === longer[i]);",
      replace: "  return shorter.length === longer.length && shorter.every((token, i) => token === longer[i]);",
    }], "constants.ts");
    assert.ok(
      mutant.modelSwapWarning("cursor-grok-4.5-high", "Cursor Grok 4.5"),
      "the mutant must fire on cursor-1b5da, which cursor-acp.ts documents as one model",
    );
    assert.ok(mutant.modelSwapWarning("gpt-5.6-sol", "openai/gpt-5.6-terra-fast"), "real swaps must still fire");
  } finally {
    dropMutant(name);
  }
});
