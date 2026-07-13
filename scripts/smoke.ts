/**
 * Real-lane smoke test — a genuine ACP handshake + micro prompt against a
 * lane, so a lane's health is verified before trusting it with a real
 * dispatch batch. A lane not in PATH / not authenticated is reported as
 * such — that is a real result, not a harness failure.
 *
 * Two modes:
 *
 *   npm run smoke
 *     Full regression battery: all 3 lanes, "Reply DONE", ~120s budget/lane
 *     (default). Exit code 1 if any lane fails.
 *
 *   npm run smoke -- <lane> [model]
 *     Single-lane canary: one 1-turn "Reply PONG" dispatch, ~30s budget
 *     (default) — the pre-flight check to run before a real dispatch batch,
 *     not a full regression sweep. Optional [model] exercises a model
 *     override on that lane (e.g. `npm run smoke -- codex gpt-5.6-sol` to
 *     canary the sol-override path specifically). Exit code 1 on failure.
 *
 * Env: CLANKER_SMOKE_TIMEOUT_MS overrides the per-lane timeout.
 */
import { LaneManager } from "../src/manager.js";
import { LANE_NAMES, type LaneName } from "../src/types.js";

const FULL_BATTERY_PROMPT = "Reply with exactly the word DONE and nothing else.";
const CANARY_PROMPT = "Reply with exactly the word PONG and nothing else.";

const FULL_BATTERY_TIMEOUT_MS = Number.parseInt(process.env.CLANKER_SMOKE_TIMEOUT_MS ?? "120000", 10);
const CANARY_TIMEOUT_MS = Number.parseInt(process.env.CLANKER_SMOKE_TIMEOUT_MS ?? "30000", 10);

interface Row {
  lane: LaneName;
  ok: boolean;
  status: string;
  ms: number;
  final: string;
  note: string;
}

const DEFAULT_MODEL: Partial<Record<LaneName, string>> = {
  // Exercises the opencode OPENCODE_CONFIG model mechanism (hard requirement).
  opencode: "zhipuai-coding-plan/glm-5.2",
};

async function runLane(
  lane: LaneName,
  prompt: string,
  expect: RegExp,
  timeoutMs: number,
  model?: string,
): Promise<Row> {
  const m = new LaneManager({ disableReaper: true, baseRepo: process.cwd() });
  const t0 = Date.now();
  try {
    const { id, warnings } = await m.dispatchStart({
      lane,
      prompt,
      cwd: process.cwd(),
      readOnly: true,
      model: model ?? DEFAULT_MODEL[lane],
    });
    const deadline = Date.now() + timeoutMs;
    let status = "running";
    let final = "";
    let error = "";
    let failureClass: string | undefined;
    while (Date.now() < deadline) {
      const r = await m.wait(id, 3000);
      status = r.status;
      if (r.status !== "running") {
        final = r.final_message ?? "";
        error = r.error ?? "";
        failureClass = r.failure_class;
        break;
      }
    }
    if (status === "running") {
      await m.cancel(id).catch(() => {});
      return row(lane, false, "timeout", t0, "", `no completion within ${timeoutMs}ms`, warnings);
    }
    const ok = status === "done" && expect.test(final);
    const note = error || (ok ? "" : "unexpected final message");
    return row(lane, ok, status, t0, final, failureClass ? `${note} [${failureClass}]` : note, warnings);
  } catch (e) {
    return row(lane, false, "error", t0, "", e instanceof Error ? e.message : String(e), []);
  } finally {
    await m.shutdown().catch(() => {});
  }
}

function row(
  lane: LaneName,
  ok: boolean,
  status: string,
  t0: number,
  final: string,
  note: string,
  warnings: string[],
): Row {
  const w = warnings.length ? ` [warnings: ${warnings.join("; ")}]` : "";
  return { lane, ok, status, ms: Date.now() - t0, final: final.slice(0, 120).replace(/\n/g, "\\n"), note: note + w };
}

function printRows(rows: Row[]): void {
  console.log("\n=== LANE SMOKE RESULTS ===");
  console.log("lane      | result | status   | ms     | final / note");
  console.log("----------|--------|----------|--------|-------------------------------");
  for (const r of rows) {
    const detail = r.final ? `final="${r.final}"` : r.note;
    console.log(
      `${r.lane.padEnd(9)} | ${(r.ok ? "PASS" : "FAIL").padEnd(6)} | ${r.status.padEnd(8)} | ${String(r.ms).padEnd(6)} | ${detail}`,
    );
    if (r.final && r.note) console.log(`${" ".repeat(41)}| note: ${r.note}`);
  }
  const passed = rows.filter((r) => r.ok).length;
  console.log(`\n${passed}/${rows.length} Clankers passed.`);
}

/** Single-lane pre-flight canary — the fast path meant for `npm run smoke -- <lane>`. */
async function runCanary(lane: LaneName, model: string | undefined): Promise<void> {
  const label = model ? `${lane} (model=${model})` : lane;
  process.stderr.write(`[smoke] ${label}: dispatching 1-turn canary (PONG)...\n`);
  const r = await runLane(lane, CANARY_PROMPT, /\bPONG\b/i, CANARY_TIMEOUT_MS, model);
  process.stderr.write(`[smoke] ${label}: ${r.ok ? "PASS" : "FAIL"} (${r.status}, ${r.ms}ms)\n`);
  printRows([r]);
  process.exitCode = r.ok ? 0 : 1;
}

/** Full 3-lane regression sweep — `npm run smoke` with no args. */
async function runFullBattery(): Promise<void> {
  const backends: LaneName[] = ["codex", "opencode", "grok"];
  const rows: Row[] = [];
  for (const lane of backends) {
    process.stderr.write(`\n[smoke] ${lane}: dispatching read-only micro prompt...\n`);
    const r = await runLane(lane, FULL_BATTERY_PROMPT, /\bDONE\b/i, FULL_BATTERY_TIMEOUT_MS);
    rows.push(r);
    process.stderr.write(`[smoke] ${lane}: ${r.ok ? "PASS" : "FAIL"} (${r.status}, ${r.ms}ms)\n`);
  }
  printRows(rows);
  if (rows.some((r) => !r.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [laneArg, modelArg] = process.argv.slice(2);
  if (laneArg) {
    if (!(LANE_NAMES as readonly string[]).includes(laneArg)) {
      console.error(`unknown lane '${laneArg}'; expected one of ${LANE_NAMES.join(", ")}`);
      process.exitCode = 2;
      return;
    }
    await runCanary(laneArg as LaneName, modelArg);
    return;
  }
  await runFullBattery();
}

main().catch((e) => {
  console.error("smoke fatal:", e);
  process.exit(1);
});
