import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "plugin/skills/using-clanker");
const destination = resolve(root, "codex-plugin/skills/using-clanker");

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });

console.log("Synced using-clanker skill to Codex plugin adapter");
