import { describe, it, expect, afterEach } from "vitest";
import {
  handleHandoverList,
  handleHandoverLatest,
  handleHandoverGet,
  handleHandoverCreate,
  normalizeSlug,
} from "../../../src/cli/commands/handover.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { extractHandoverNamespace } from "../../../src/core/handover-parser.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";
import { mkdtemp, writeFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

describe("handleHandoverList", () => {
  it("returns handover filenames", async () => {
    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-03-19-session.md", "2026-03-18-session.md"] }),
    });
    const result = await handleHandoverList(ctx);
    expect(result.output).toContain("2026-03-19-session.md");
    expect(result.output).toContain("2026-03-18-session.md");
  });

  it("returns empty message when no handovers", async () => {
    const ctx = makeCtx();
    const result = await handleHandoverList(ctx);
    expect(result.output).toContain("No handovers");
  });

  it("returns valid JSON", async () => {
    const ctx = makeCtx({
      format: "json",
      state: makeState({ handoverFilenames: ["2026-03-19-session.md"] }),
    });
    const result = await handleHandoverList(ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data).toContain("2026-03-19-session.md");
  });
});

describe("handleHandoverLatest", () => {
  it("returns latest handover content", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(join(handoversDir, "2026-03-19-session.md"), "# Session Notes\nHello world");

    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-03-19-session.md"] }),
      handoversDir,
    });
    const result = await handleHandoverLatest(ctx);
    expect(result.output).toContain("Hello world");
  });

  it("returns not_found when no handovers", async () => {
    const ctx = makeCtx();
    const result = await handleHandoverLatest(ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });
});

describe("handleHandoverGet", () => {
  it("returns specific handover content", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(join(handoversDir, "2026-03-19-session.md"), "# My Session");

    const ctx = makeCtx({ handoversDir });
    const result = await handleHandoverGet("2026-03-19-session.md", ctx);
    expect(result.output).toContain("My Session");
  });

  it("returns not_found for missing file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });

    const ctx = makeCtx({ handoversDir });
    const result = await handleHandoverGet("nonexistent.md", ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });

  it("returns JSON for handover content", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(join(handoversDir, "2026-03-19-session.md"), "content here");

    const ctx = makeCtx({ handoversDir, format: "json" });
    const result = await handleHandoverGet("2026-03-19-session.md", ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.filename).toBe("2026-03-19-session.md");
    expect(parsed.data.content).toBe("content here");
  });
});

describe("normalizeSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(normalizeSlug("Phase 5B Wrapup")).toBe("phase-5b-wrapup");
  });

  it("strips special characters", () => {
    expect(normalizeSlug("test!@#$%^&*()")).toBe("test");
  });

  it("collapses consecutive hyphens", () => {
    expect(normalizeSlug("a---b")).toBe("a-b");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeSlug("-test-")).toBe("test");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(80);
    expect(normalizeSlug(long).length).toBeLessThanOrEqual(60);
  });

  it("throws on empty result", () => {
    expect(() => normalizeSlug("###")).toThrow(CliValidationError);
    expect(() => normalizeSlug("")).toThrow(CliValidationError);
    expect(() => normalizeSlug("   ")).toThrow(CliValidationError);
  });
});

describe("handleHandoverCreate", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("creates a handover file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleHandoverCreate("# Session\nDone.", "session", "md", dir);
    expect(result.output).toContain("Created handover:");
    expect(result.output).toMatch(/01-session\.md/);

    const files = await readdir(join(dir, ".story", "handovers"));
    const created = files.find((f) => f.includes("01-session.md"));
    expect(created).toBeDefined();

    const content = await readFile(join(dir, ".story", "handovers", created!), "utf-8");
    expect(content).toBe("# Session\nDone.");
  });

  it("adds namespace metadata when a namespace scope is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleHandoverCreate("# Session\nDone.", "session", "md", dir, {
      namespace: "DEV01",
    });
    const filename = result.output.match(/Created handover: (.+)$/)?.[1];
    expect(filename).toBeDefined();

    const content = await readFile(join(dir, ".story", "handovers", filename!), "utf-8");
    expect(extractHandoverNamespace(content)).toBe("DEV01");
    expect(content).toContain("# Session");
  });

  it("generates globally monotonic sequence numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const r1 = await handleHandoverCreate("First", "session", "md", dir);
    expect(r1.output).toMatch(/01-session\.md/);

    const r2 = await handleHandoverCreate("Second", "notes", "md", dir);
    expect(r2.output).toMatch(/02-notes\.md/);

    const r3 = await handleHandoverCreate("Third", "session", "md", dir);
    expect(r3.output).toMatch(/03-session\.md/);
  });

  it("normalizes slug in filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleHandoverCreate("Content", "Phase 5B Wrapup!", "md", dir);
    expect(result.output).toMatch(/01-phase-5b-wrapup\.md/);
  });

  it("returns JSON format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleHandoverCreate("# Notes", "session", "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.filename).toMatch(/01-session\.md/);
  });

  it("rejects empty content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await expect(
      handleHandoverCreate("", "session", "md", dir),
    ).rejects.toThrow("empty");
  });

  it("rejects whitespace-only content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await expect(
      handleHandoverCreate("   \n  ", "session", "md", dir),
    ).rejects.toThrow("empty");
  });

  it("rejects invalid slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await expect(
      handleHandoverCreate("content", "###", "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("sequenced files sort after legacy files on same date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    // Simulate a legacy handover (no sequence number)
    const handoversDir = join(dir, ".story", "handovers");
    await writeFile(join(handoversDir, "2026-03-21-legacy-notes.md"), "old content");

    // Create a new sequenced handover
    await handleHandoverCreate("new content", "session", "md", dir);

    const files = await readdir(handoversDir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();
    // Legacy file: 2026-03-21-legacy-notes.md
    // Sequenced: 2026-03-21-01-session.md
    // In reverse lex, "l" > "0" so legacy sorts first. But our custom sort
    // should put sequenced files first. Verify via listHandovers.
    const { listHandovers } = await import("../../../src/core/handover-parser.js");
    const warnings: Array<{ type: string; file: string; message: string }> = [];
    const sorted = await listHandovers(handoversDir, dir, warnings);
    // Sequenced file should be first (newest)
    expect(sorted[0]).toMatch(/01-session\.md/);
  });

  it("handover latest returns most recently created regardless of slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await handleHandoverCreate("First", "zzz", "md", dir);
    await handleHandoverCreate("Second", "aaa", "md", dir);

    // Second created file (02-aaa) should sort after first (01-zzz) in reverse lex
    // because 02 > 01, so handover latest returns the second-created file
    const files = await readdir(join(dir, ".story", "handovers"));
    const sorted = files.filter((f) => f.endsWith(".md")).sort().reverse();
    expect(sorted[0]).toMatch(/02-aaa\.md/);
  });
});
