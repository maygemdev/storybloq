import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = resolve(__dirname, "fixtures");

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function setTestNamespace(root: string, namespace = "TEST"): void {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(storyDir, ".local.json"), JSON.stringify({ namespace }, null, 2) + "\n");
}
