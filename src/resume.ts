/**
 * The backend-resume correction turn (#43) — everything about it that is a
 * DECISION rather than plumbing.
 *
 * Clanker has two shapes of correction turn, and they are not variants of one
 * thing:
 *
 *  - The supervised shape (manager.promptExisting's original path): the ACP
 *    session is still open, the worker still holds its own context in memory,
 *    and the correction is one more prompt on that session. Its window closes
 *    when the idle-TTL reaper closes the session, and once that has happened
 *    the only honest answer is "gone".
 *  - The resume shape (this file): the lane's backend holds the conversation,
 *    not this process. cursor-agent runs one CLI invocation per turn and exits;
 *    what survives is a chat id on Cursor's side. So the correction is a FRESH
 *    SPAWN carrying `--resume <id>` — and because the id is the backend's, the
 *    respawn may run a different model and still land in the same conversation
 *    (measured 2026-07-28: a passphrase stored by composer-2.5 was recalled by
 *    cursor-grok-4.5-high resuming the same session). That is the per-turn
 *    model hand-off #43 exists for.
 *
 * WHAT THE HAND-OFF IS NOT — the boundary the issue fixes as a precedent: a
 * relay is not a review. The second model reads the first one's entire context
 * and is anchored by its framing, which is precisely the wrong instrument for
 * catching the first one's blind spot (composer's signature failure is "tests
 * green, contract violated" — lane card #1368 — and a reviewer inside the
 * defendant's own session inherits the defendant's account of the evidence).
 * Continuation and polish: resume. Review and verification: a cold, separately
 * dispatched context. This file implements the first and must never be sold as
 * the second.
 */
import fs from "node:fs";
import { LANES_WITH_RESUME } from "./constants.js";
import type { LaneName, LaneRequestOptions } from "./types.js";

/** The subset of a LaneRun this planner reads; keeps it testable without one. */
export interface ResumableRun {
  readonly id: string;
  readonly lane: LaneName;
  readonly cwd: string;
  readonly requestOpts: LaneRequestOptions;
  readonly laneSessionRef?: string;
}

/** What the manager needs to build the respawn. */
export interface ResumeTurnPlan {
  /** The backend conversation the respawn continues. */
  ref: string;
  /** The model this turn was handed, when the correction named one. */
  model?: string;
  /** Spawn options for the respawn: this run's own options, plus the two above. */
  requestOpts: LaneRequestOptions;
}

/** Whether this lane's backend can continue its own conversation from an id. */
export function laneCanResume(lane: string): boolean {
  return LANES_WITH_RESUME.has(lane);
}

/**
 * Plan one resume turn, or refuse it with the reason.
 *
 * Every refusal below is a TRUE ANSWER, not a retry prompt — the same register
 * the supervised path's "the session is gone" sentence is written in. A
 * correction turn that cannot continue the original conversation must not
 * quietly become a fresh worker with no memory of the work it is being
 * corrected about; that is the failure this whole path exists to avoid, and it
 * would be invisible in the result (a plausible answer to the correction, built
 * on nothing).
 */
export function planResumeTurn(run: ResumableRun, model?: string): ResumeTurnPlan {
  if (!laneCanResume(run.lane)) {
    throw new Error(
      `run '${run.id}' is on lane '${run.lane}', which has no backend resume capability`,
    );
  }
  const ref = run.laneSessionRef?.trim();
  if (!ref) {
    throw new Error(
      `run '${run.id}' has no backend session ref recorded, so there is no conversation to resume — ` +
        `the lane never reported one (a turn that failed before the backend started never does). ` +
        `Report the blocker; a correction turn here would be a fresh worker with no memory of the work.`,
    );
  }
  // Refuse a flag-shaped ref HERE, not just at the sidecar's own argv gate
  // (cursor-acp refuseFlagShapedToken). The sidecar catch is the real
  // boundary and stays, but reaching it means the run has already been
  // re-opened and published as `running`, only to flip to `error` a moment
  // later — a caller polling that id sees a turn start and die for reasons
  // the synchronous call could have stated outright (Scope-B review,
  // gemini-ccfb4). Same shape, checked at the first place that holds it.
  if (ref.startsWith("-")) {
    throw new Error(
      `run '${run.id}' recorded a backend session ref '${ref}' that starts with '-'; it would reach the ` +
        `backend as a flag rather than as the value of --resume, so this run cannot be resumed`,
    );
  }
  // The respawn runs in the same directory the first turn did. For a write run
  // that is the managed worktree, and a CLEAN tree is reclaimed when the run
  // closes (manager.closeRun → removeIfClean) — so this is a real state, not a
  // defensive nicety, and it must be named rather than discovered as a spawn
  // failing in a directory that no longer exists.
  if (!fs.existsSync(run.cwd)) {
    throw new Error(
      `run '${run.id}' cannot take a resume turn: its working directory '${run.cwd}' no longer exists ` +
        `(a worktree with no changes is reclaimed when the run closes). Dispatch a fresh run instead.`,
    );
  }
  const requested = model?.trim();
  if (requested !== undefined && requested === "") {
    throw new Error(`run '${run.id}': a resume turn's model override cannot be empty`);
  }
  return {
    ref,
    ...(requested ? { model: requested } : {}),
    // The run's OWN options carry forward — above all `readOnly`, which is this
    // lane's read/write boundary (backends.ts derives cursor's `--mode` from
    // it). A correction turn re-spawns the same contract; it is not a second
    // dispatch, and nothing here may widen what the first one was granted.
    requestOpts: {
      ...run.requestOpts,
      ...(requested ? { model: requested } : {}),
      resumeRef: ref,
    },
  };
}
