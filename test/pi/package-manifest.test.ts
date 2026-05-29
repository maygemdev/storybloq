import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");

describe("Pi package manifest", () => {
  it("advertises Storybloq as a Pi package with existing skill and extension resources", async () => {
    const packageJson = JSON.parse(
      await readFile(join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as {
      keywords?: string[];
      pi?: { skills?: string[]; extensions?: string[] };
      files?: string[];
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.keywords).toContain("pi-package");
    expect(packageJson.pi?.skills).toEqual(["./dist/skill"]);
    expect(packageJson.pi?.extensions).toEqual(["./dist/pi-extension.js"]);
    expect(packageJson.files).toContain("dist");
    expect(packageJson.peerDependencies).toHaveProperty("@earendil-works/pi-coding-agent");
    expect(packageJson.peerDependencies).toHaveProperty("typebox");
    expect(packageJson.devDependencies).toHaveProperty("@earendil-works/pi-coding-agent");
    expect(packageJson.devDependencies).toHaveProperty("typebox");

    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "SKILL.md"))).toBe(true);
  });

  it("build config emits the declared Pi extension file", async () => {
    const tsupConfig = await readFile(join(PROJECT_ROOT, "tsup.config.ts"), "utf-8");
    expect(tsupConfig).toContain('"pi-extension": "src/pi/extension.ts"');
    expect(tsupConfig).toContain('"process.env.STORYBLOQ_PI_COMMAND"');
    expect(existsSync(join(PROJECT_ROOT, "src", "pi", "extension.ts"))).toBe(true);
  });

  it("build script emits the configured Pi skill alias", async () => {
    const script = await readFile(join(PROJECT_ROOT, "scripts", "build-pi-skill.mjs"), "utf-8");
    expect(script).toContain("STORYBLOQ_PI_COMMAND");
    expect(script).toContain("dist\", \"skill");
    expect(script).toContain("name: ${skillName}");
    expect(script).toContain("__STORYBLOQ_VERSION__");
  });

  it("build script stamps the Pi skill with the package version", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "storybloq-pi-skill-"));
    try {
      await writeFile(join(tempRoot, "package.json"), JSON.stringify({ version: "1.4.2-pi" }), "utf-8");
      await writeFile(
        join(tempRoot, "script.mjs"),
        await readFile(join(PROJECT_ROOT, "scripts", "build-pi-skill.mjs"), "utf-8"),
        "utf-8",
      );
      cpSync(join(PROJECT_ROOT, "src"), join(tempRoot, "src"), { recursive: true });
      execFileSync(process.execPath, [join(tempRoot, "script.mjs")], {
        cwd: tempRoot,
        env: { ...process.env, STORYBLOQ_PI_COMMAND: "story-dev" },
      });

      const skill = readFileSync(join(tempRoot, "dist", "skill", "SKILL.md"), "utf-8");
      expect(skill).toContain("name: story-dev");
      expect(skill).toContain("This Storybloq skill bundle version is `1.4.2-pi`");
      expect(skill).not.toContain("__STORYBLOQ_VERSION__");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
