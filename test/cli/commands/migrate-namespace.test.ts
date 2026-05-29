import { describe, it, expect, afterEach } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleMigrateNamespace } from "../../../src/cli/commands/migrate-namespace.js";
import { initProject } from "../../../src/core/init.js";

async function setupProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migrate-namespace-test-"));
  await initProject(dir, { name: "test" });
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("storybloq migrate-namespace", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("rewrites structured refs and strict free-text mentions across project memory and docs", async () => {
    const dir = await setupProject();
    tmpDirs.push(dir);

    await writeJson(join(dir, ".story", "tickets", "T-001.json"), {
      id: "T-001",
      title: "Build T-001",
      description: "Depends on T-002 and api:T-003. Keep DEV01-T-004, T-XXX, and fooT-007.",
      type: "task",
      status: "open",
      phase: null,
      order: 1,
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: ["T-002"],
      parentTicket: "T-002",
      crossNodeBlockedBy: ["api:T-002"],
    });
    await writeJson(join(dir, ".story", "tickets", "T-002.json"), {
      id: "T-002",
      title: "Blocker",
      description: "Blocks T-001.",
      type: "task",
      status: "open",
      phase: null,
      order: 2,
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    });
    await writeJson(join(dir, ".story", "issues", "ISS-001.json"), {
      id: "ISS-001",
      title: "Bug",
      status: "open",
      severity: "medium",
      components: [],
      impact: "Breaks T-001 and relates to ISS-002.",
      resolution: "See api:ISS-001.",
      location: [],
      discoveredDate: "2026-01-01",
      resolvedDate: null,
      relatedTickets: ["T-001"],
    });
    await writeJson(join(dir, ".story", "notes", "N-001.json"), {
      id: "N-001",
      title: "Note for T-001",
      content: "Remember T-001, but keep T-XXX and TEST-T-999.",
      tags: [],
      status: "active",
      createdDate: "2026-01-01",
      updatedDate: "2026-01-01",
    });
    await writeJson(join(dir, ".story", "lessons", "L-001.json"), {
      id: "L-001",
      title: "Lesson",
      content: "When fixing T-001, check ISS-001.",
      context: "Regression from api:T-002.",
      source: "manual",
      tags: [],
      reinforcements: 0,
      lastValidated: "2026-01-01",
      createdDate: "2026-01-01",
      updatedDate: "2026-01-01",
      supersedes: null,
      status: "active",
    });
    await writeJson(join(dir, ".story", "roadmap.json"), {
      title: "Roadmap",
      date: "2026-01-01",
      phases: [
        {
          id: "p1",
          label: "P1",
          name: "Phase",
          description: "Phase for T-001.",
        },
      ],
      blockers: [
        {
          name: "ISS-001",
          note: "Blocked by ISS-001.",
        },
      ],
    });
    await writeFile(join(dir, ".story", "handovers", "2026-01-01-start.md"), "Handover for T-001 and api:ISS-001.\n");
    await mkdir(join(dir, "docs", "plans"), { recursive: true });
    await writeFile(join(dir, "README.md"), "Read T-001, ISS-001, DEV01-T-001, and T-XXX.\n");
    await writeFile(join(dir, "docs", "plans", "plan.md"), "Plan references T-002a and fooT-007.\n");

    const result = await handleMigrateNamespace("TEST", dir, { dryRun: false });

    expect(result.errorCode).toBeUndefined();
    expect(result.output).toContain("Migration complete.");
    expect(result.output).toContain("text file updates");
    expect(await exists(join(dir, ".story", "tickets", "T-001.json"))).toBe(false);
    expect(await exists(join(dir, ".story", "tickets", "TEST-T-001.json"))).toBe(true);

    const ticket = await readJson(join(dir, ".story", "tickets", "TEST-T-001.json"));
    expect(ticket.id).toBe("TEST-T-001");
    expect(ticket.blockedBy).toEqual(["TEST-T-002"]);
    expect(ticket.parentTicket).toBe("TEST-T-002");
    expect(ticket.crossNodeBlockedBy).toEqual(["api:TEST-T-002"]);
    expect(ticket.description).toBe("Depends on TEST-T-002 and api:TEST-T-003. Keep DEV01-T-004, T-XXX, and fooT-007.");

    const issue = await readJson(join(dir, ".story", "issues", "TEST-ISS-001.json"));
    expect(issue.relatedTickets).toEqual(["TEST-T-001"]);
    expect(issue.impact).toBe("Breaks TEST-T-001 and relates to TEST-ISS-002.");
    expect(issue.resolution).toBe("See api:TEST-ISS-001.");

    const note = await readJson(join(dir, ".story", "notes", "N-001.json"));
    expect(note.content).toBe("Remember TEST-T-001, but keep T-XXX and TEST-T-999.");

    const lesson = await readJson(join(dir, ".story", "lessons", "L-001.json"));
    expect(lesson.content).toBe("When fixing TEST-T-001, check TEST-ISS-001.");
    expect(lesson.context).toBe("Regression from api:TEST-T-002.");

    const roadmap = await readJson(join(dir, ".story", "roadmap.json"));
    expect((roadmap.phases as Array<{ description: string }>)[0]!.description).toBe("Phase for TEST-T-001.");
    expect((roadmap.blockers as Array<{ name: string; note: string }>)[0]!.name).toBe("TEST-ISS-001");
    expect((roadmap.blockers as Array<{ name: string; note: string }>)[0]!.note).toBe("Blocked by TEST-ISS-001.");

    await expect(readFile(join(dir, ".story", "handovers", "2026-01-01-start.md"), "utf-8"))
      .resolves.toBe("Handover for TEST-T-001 and api:TEST-ISS-001.\n");
    await expect(readFile(join(dir, "README.md"), "utf-8"))
      .resolves.toBe("Read TEST-T-001, TEST-ISS-001, DEV01-T-001, and T-XXX.\n");
    await expect(readFile(join(dir, "docs", "plans", "plan.md"), "utf-8"))
      .resolves.toBe("Plan references TEST-T-002a and fooT-007.\n");

    const local = await readJson(join(dir, ".story", ".local.json"));
    expect(local.namespace).toBe("TEST");
  });

  it("dry-run scans text without entity renames and leaves files untouched", async () => {
    const dir = await setupProject();
    tmpDirs.push(dir);

    const ticketPath = join(dir, ".story", "tickets", "TEST-T-001.json");
    await writeJson(ticketPath, {
      id: "TEST-T-001",
      title: "Namespaced",
      description: "Still mentions T-009 and ISS-002.",
      type: "task",
      status: "open",
      phase: null,
      order: 1,
      createdDate: "2026-01-01",
      completedDate: null,
      blockedBy: [],
      parentTicket: null,
    });
    const handoverPath = join(dir, ".story", "handovers", "2026-01-01-start.md");
    await writeFile(handoverPath, "Still has T-009.\n");

    const beforeTicket = await readFile(ticketPath, "utf-8");
    const beforeHandover = await readFile(handoverPath, "utf-8");

    const result = await handleMigrateNamespace("TEST", dir, { dryRun: true });

    expect(result.errorCode).toBeUndefined();
    expect(result.output).toContain("Dry run");
    expect(result.output).toContain("0 entities to rename");
    expect(result.output).toContain("text file updates");
    await expect(readFile(ticketPath, "utf-8")).resolves.toBe(beforeTicket);
    await expect(readFile(handoverPath, "utf-8")).resolves.toBe(beforeHandover);
    expect(await exists(join(dir, ".story", ".local.json"))).toBe(false);
  });
});
