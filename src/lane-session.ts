/**
 * The lane-agnostic side channel for a BACKEND-OWNED conversation id (#43).
 *
 * Some lanes keep their own conversation state on their own side and can be
 * told to continue it later — `cursor-agent --resume <session_id>` is the first
 * one, and it continues the conversation even when the resuming turn runs on a
 * DIFFERENT model (measured 2026-07-28: composer-2.5 was told a passphrase,
 * cursor-grok-4.5-high resumed the same session and answered with it). A
 * correction turn on such a lane is therefore not "another prompt on the live
 * session" — the live session is a one-shot CLI invocation that already
 * exited — it is a fresh spawn carrying that id.
 *
 * Two things this id is NOT:
 *
 *  - It is not ACP's `sessionId`. That one names the session THIS process holds
 *    with the sidecar and dies with the subprocess; this one names a
 *    conversation stored on the backend's side and outlives every process here.
 *  - It is not lane-specific telemetry. The cursor sidecar already reports its
 *    own `_meta["clanker.cursor"]` block (chat id, permission mode, api key
 *    source) for disk forensics; that block stays vendor-shaped. This key is
 *    the ONE field the lane-neutral machinery (run.ts, telemetry, the resume
 *    path in manager.ts) is allowed to read, so adding a second resumable lane
 *    means emitting this key from its sidecar and nothing else.
 *
 * The key travels on an ACP `session_info_update`'s `_meta`, which the protocol
 * reserves for exactly this ("clients and agents MAY attach additional
 * metadata"), so no schema is bent to carry it.
 */

/** `_meta` key carrying the backend's own conversation id. */
export const LANE_SESSION_META_KEY = "clanker.lane_session";

/** Build the `_meta` block a sidecar attaches to a session_info_update. */
export function laneSessionMeta(ref: string | undefined): Record<string, unknown> {
  return { [LANE_SESSION_META_KEY]: { ref } };
}

/**
 * Read the ref back out of an update's `_meta`, or `undefined` when the update
 * carries none.
 *
 * Deliberately strict, and deliberately silent about anything else: a lane that
 * reports no ref (or reports a non-string, or an empty one) must leave the
 * previously known ref ALONE rather than blank it out. A resumed turn whose own
 * init event is missing the id would otherwise erase the very ref it was
 * resumed from, and the next correction would have nothing to continue.
 */
export function laneSessionRefFrom(meta: Record<string, unknown> | null | undefined): string | undefined {
  const block = meta?.[LANE_SESSION_META_KEY];
  if (block === null || typeof block !== "object") return undefined;
  const ref = (block as { ref?: unknown }).ref;
  if (typeof ref !== "string") return undefined;
  return ref.trim() || undefined;
}
