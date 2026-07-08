/**
 * Channel two (spec §3) — inbox / cockpit projection seam.
 *
 * Per the 2026-07-06 owner adjudication this iteration ships only the interface
 * seam and a no-op sink. The real inbox.push wiring (persistent todo entries the
 * cockpit subscribes to) lands in Step 2 once channel one's harness bubble-up is
 * decided by the Step 0 prototype test.
 *
 * TODO(step2): implement an InboxSink backed by the existing delivery substrate
 * (dogfooded inbox) and call sink.projectPlan(...) from LaneManager on every
 * plan change, keyed by run id, so N Clankers render as N todo rows.
 */
import type { LaneName, PlanState } from "./types.js";

export interface PlanProjection {
  id: string;
  lane: LaneName;
  plan: PlanState;
  planSummary: string;
}

export interface InboxSink {
  projectPlan(projection: PlanProjection): void;
}

/** No-op sink used until channel two is implemented. */
export const noopInbox: InboxSink = {
  projectPlan() {
    /* seam only — see TODO(step2) above */
  },
};
