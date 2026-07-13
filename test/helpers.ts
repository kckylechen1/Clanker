import { fileURLToPath } from "node:url";
import type { LaneName, LaneRequestOptions, SpawnSpec } from "../src/types.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url));

/**
 * SpecResolver that points every lane at the scripted fake ACP agent, so the
 * real SDK client is exercised without any external CLI in PATH.
 */
export function fakeResolver(lane: LaneName, _opts: LaneRequestOptions, _runDir: string): SpawnSpec {
  return { command: process.execPath, args: [FAKE_AGENT], env: {}, warnings: [] };
}

export function fakeSpec(env: Record<string, string> = {}): SpawnSpec {
  return { command: process.execPath, args: [FAKE_AGENT], env, warnings: [] };
}

/** Poll `fn` until it returns true or the deadline passes. */
export async function until(fn: () => boolean, timeoutMs = 4000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}
