import { LANE_NAMES, type LaneName } from "./types.js";

export type ClankerHost = "claude" | "codex" | "standalone";

const HOSTS: readonly ClankerHost[] = ["claude", "codex", "standalone"];

/**
 * Lanes a `host=codex` server may drive — DERIVED from the one rule below
 * (`hostLaneBlockedReason`: codex cannot dispatch itself) rather than kept as a
 * second hand-maintained list. Two lists of the same rule drift: a new lane
 * added to LANE_NAMES and forgotten here would be silently unreachable from the
 * Codex adapter, with no test naming the lane to catch it.
 */
const CODEX_LANES: readonly LaneName[] = LANE_NAMES.filter((lane) => lane !== "codex");

export function parseHostArgs(args: readonly string[]): ClankerHost {
  let host: ClankerHost | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== "--host" && !arg.startsWith("--host=")) continue;
    if (host !== undefined) throw new Error("duplicate --host option");
    const value = arg === "--host" ? args[++i] : arg.slice("--host=".length);
    if (!value || !HOSTS.includes(value as ClankerHost)) {
      throw new Error(`invalid --host '${value ?? ""}'; expected one of ${HOSTS.join(", ")}`);
    }
    host = value as ClankerHost;
  }
  return host ?? "standalone";
}

export function laneNamesForHost(host: ClankerHost): readonly LaneName[] {
  return host === "codex" ? CODEX_LANES : LANE_NAMES;
}

/** One source of truth for host self-dispatch policy and its loud reason. */
export function hostLaneBlockedReason(host: ClankerHost, lane: LaneName): string | undefined {
  if (host === "codex" && lane === "codex") {
    return "host=codex cannot dispatch the codex ACP lane (self-dispatch is prohibited)";
  }
  return undefined;
}
