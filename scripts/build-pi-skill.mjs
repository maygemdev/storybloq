import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sourceDir = join(process.cwd(), "src", "skill");
const targetDir = join(process.cwd(), "dist", "skill");

function normalizeSkillName(value) {
  const name = (value ?? "story").trim().replace(/^\/+/, "");
  return name || "story";
}

function normalizeVersionSuffix(value) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("-") || trimmed.startsWith("+") ? trimmed : `-${trimmed}`;
}

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
const skillName = normalizeSkillName(process.env.STORYBLOQ_PI_COMMAND);
const versionSuffix = normalizeVersionSuffix(process.env.STORYBLOQ_VERSION_SUFFIX ?? "pi");
const storybloqVersion = `${pkg.version}${versionSuffix}`;

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(join(process.cwd(), "dist"), { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

const skillPath = join(targetDir, "SKILL.md");
const skill = readFileSync(skillPath, "utf-8");
writeFileSync(
  skillPath,
  skill
    .replace(/^name:\s*story\s*$/m, `name: ${skillName}`)
    .replaceAll("__STORYBLOQ_VERSION__", storybloqVersion),
  "utf-8",
);
