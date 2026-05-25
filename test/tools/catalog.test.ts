import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { getStorybloqToolDefinitions } from "../../src/tools/storybloq-tool-definitions.js";

describe("Storybloq tool catalog", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "storybloq-catalog-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "Catalog Test" });
    return dir;
  }

  it("has unique names, descriptions, and access classifications", async () => {
    const root = await makeProject();
    const definitions = getStorybloqToolDefinitions(root);
    const names = definitions.map((definition) => definition.name);

    expect(names.length).toBeGreaterThan(50);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(["read", "write", "bootstrap", "lifecycle", "review"]).toContain(definition.access);
    }
  });
});
