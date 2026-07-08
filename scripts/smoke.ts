/**
 * Real-lane smoke test. For each lane, performs a genuine ACP handshake and a
 * read-only micro prompt ("Reply exactly DONE"), with a per-lane timeout, then
 * prints a verbatim pass/fail row. A lane not in PATH / not authenticated is
 * reported as such — that is a real result, not a harness failure.
 *
 * Run: npm run smoke   (optionally: CLANKER_SMOKE_TIMEOUT_MS=120000)
 */
import { LaneManager } from "../src/manager.js";
import type { LaneName } from "../src/types.js";

const PROMPT = "Reply with exactly the word DONE and nothing else.";
const TIMEOUT_MS = Number.parseInt(process.env.CLANKER_SMOKE_TIMEOUT_MS ?? "120000", 10);

interface Row {
  lane: LaneName;
  ok: boolean;
  status: string;
  ms: number;
  final: string;
  note: string;
}

const MODEL: Partial<Record<LaneName, string>> = {
  // Exercises the opencode OPENCODE_CONFIG model mechanism (hard requirement).
  opencode: "zhipuai-coding-plan/glm-5.2",
};

async function runLane(lane: LaneName): Promise<Row> {
  const m = new LaneManager({ disableReaper: true, baseRepo: process.cwd() });
  const t0 = Date.now();
  try {
    const { id, warnings } = await m.dispatchStart({
      lane,
      prompt: PROMPT,
      cwd: process.cwd(),
      readOnly: true,
      model: MODEL[lane],
    });
    const deadline = Date.now() + TIMEOUT_MS;
    let status = "running";
    let final = "";
    let error = "";
    while (Date.now() < deadline) {
      const r = await m.wait(id, 3000);
      status = r.status;
      if (r.status !== "running") {
        final = r.final_message ?? "";
        error = r.error ?? "";
        break;
      }
    }
    if (status === "running") {
      await m.cancel(id).catch(() => {});
      return row(lane, false, "timeout", t0, "", `no completion within ${TIMEOUT_MS}ms`, warnings);
    }
    const ok = status === "done" && /\bDONE\b/i.test(final);
    return row(lane, ok, status, t0, final, error || (ok ? "" : "unexpected final message"), warnings);
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

async function main(): Promise<void> {
  const backends: LaneName[] = ["codex", "opencode", "grok"];
  const rows: Row[] = [];
  for (const lane of backends) {
    process.stderr.write(`\n[smoke] ${lane}: dispatching read-only micro prompt...\n`);
    const r = await runLane(lane);
    rows.push(r);
    process.stderr.write(`[smoke] ${lane}: ${r.ok ? "PASS" : "FAIL"} (${r.status}, ${r.ms}ms)\n`);
  }

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

main().catch((e) => {
  console.error("smoke fatal:", e);
  process.exit(1);
});
