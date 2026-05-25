import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalConfigSchema, type LocalConfig } from "../models/local-config.js";
import { atomicWrite } from "./project-loader.js";
import { ensureGitignoreEntries } from "./init.js";
import { ProjectLoaderError } from "./errors.js";

const LOCAL_CONFIG_FILE = ".local.json";

export async function loadLocalConfig(root: string): Promise<LocalConfig> {
  const filePath = join(root, ".story", LOCAL_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectLoaderError(
        "not_found",
        "No namespace configured. Run `storybloq namespace set <NS>` first.",
      );
    }
    throw new ProjectLoaderError(
      "io_error",
      `Failed to read ${LOCAL_CONFIG_FILE}: ${(err as Error).message}`,
      err,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProjectLoaderError(
      "invalid_input",
      `Malformed JSON in ${LOCAL_CONFIG_FILE}`,
    );
  }
  const parsed = LocalConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid ${LOCAL_CONFIG_FILE}: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

export async function writeLocalConfig(
  root: string,
  config: LocalConfig,
): Promise<void> {
  const storyDir = join(root, ".story");
  await ensureGitignoreEntries(join(storyDir, ".gitignore"), [LOCAL_CONFIG_FILE]);
  const filePath = join(storyDir, LOCAL_CONFIG_FILE);
  const json = JSON.stringify(config, null, 2) + "\n";
  await atomicWrite(filePath, json);
}

export async function getNamespace(root: string): Promise<string> {
  const config = await loadLocalConfig(root);
  return config.namespace;
}
