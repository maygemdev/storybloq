import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const existingGitConfigCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10);
const gitConfigCount = Number.isFinite(existingGitConfigCount) && existingGitConfigCount >= 0
  ? existingGitConfigCount
  : 0;
const hasDefaultBranchConfig = Array.from({ length: gitConfigCount }).some(
  (_, index) => process.env[`GIT_CONFIG_KEY_${index}`] === "init.defaultBranch",
);

if (!hasDefaultBranchConfig) {
  process.env[`GIT_CONFIG_KEY_${gitConfigCount}`] = "init.defaultBranch";
  process.env[`GIT_CONFIG_VALUE_${gitConfigCount}`] = "main";
  process.env.GIT_CONFIG_COUNT = String(gitConfigCount + 1);
}

if (process.platform !== "win32") {
  const testBin = resolve(dirname(fileURLToPath(import.meta.url)), "bin");
  process.env.PATH = [testBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
}
