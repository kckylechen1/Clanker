import test from "node:test";
import assert from "node:assert/strict";
import { LANE_NAMES } from "../src/types.js";
import { laneEnum } from "../src/tools.js";

// ---- lane list single-source-of-truth ------------------------------------
//
// tools.ts builds its dispatch-shape lane enum directly from LANE_NAMES
// (src/types.ts). This test imports the *actual* laneEnum tools.ts hands to
// zod, so a future hand-edit that re-forks the lane set back into a separate
// literal list in tools.ts (recreating the drift this pass removed) fails
// here instead of silently drifting.

test("tools.ts laneEnum accepts exactly LANE_NAMES and rejects anything else", () => {
  for (const lane of LANE_NAMES) {
    assert.equal(laneEnum.parse(lane), lane, `laneEnum should accept '${lane}'`);
  }

  assert.equal(LANE_NAMES.length, 3, "lane set is still exactly the three known lanes");
  assert.deepEqual([...LANE_NAMES].sort(), ["codex", "grok", "opencode"]);

  assert.throws(() => laneEnum.parse("claude"), /Invalid enum value|invalid_value/);
  assert.throws(() => laneEnum.parse(""), /Invalid enum value|invalid_value/);
  assert.throws(() => laneEnum.parse("Codex"), /Invalid enum value|invalid_value/);
});
