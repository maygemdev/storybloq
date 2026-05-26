import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { deriveClaudeStatus } from "../../src/autonomous/session-types.js";
import { isProtectedBranch } from "../../src/autonomous/branch-affinity.js";
import { getStorybloqToolDefinitions } from "../../src/tools/storybloq-tool-definitions.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

let roots: string[] = [];

function createStoryRepo(branch = "feature/work-mode"): string {
  const root = mkdtempSync(join(tmpdir(), "story-work-mode-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "tickets"), { recursive: true });
  mkdirSync(join(root, ".story", "issues"), { recursive: true });
  mkdirSync(join(root, ".story", "handovers"), { recursive: true });
  mkdirSync(join(root, ".story", "snapshots"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2,
    project: "test-project",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: {
      reviewBackends: ["agent"],
      stages: {
        WRITE_TESTS: { enabled: false },
        TEST: { enabled: false },
        VERIFY: { enabled: false },
        BUILD: { enabled: false },
      },
    },
  }, null, 2));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "test-project",
    date: "2026-05-26",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test phase" }],
    blockers: [],
  }, null, 2));
  writeFileSync(join(root, ".story", "tickets", "TEST-T-001.json"), JSON.stringify({
    id: "TEST-T-001",
    title: "Test ticket",
    description: "Implement the test ticket.",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    createdDate: "2026-05-26",
    completedDate: null,
    blockedBy: [],
    parentTicket: null,
  }, null, 2));
  writeFileSync(join(root, "README.md"), "# test\n");
  execSync("git init", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  execSync("git add .", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
  if (branch !== "main") {
    execSync(`git checkout -b ${branch}`, { cwd: root, stdio: "ignore" });
  }
  return root;
}

function onlySessionId(root: string): string {
  const sessions = readdirSync(join(root, ".story", "sessions"));
  expect(sessions).toHaveLength(1);
  return sessions[0]!;
}

function readState(root: string, sessionId = onlySessionId(root)): Record<string, any> {
  return JSON.parse(readFileSync(join(root, ".story", "sessions", sessionId, "state.json"), "utf-8"));
}

afterEach(() => {
  for (const root of roots) {
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

describe("work mode branch guards", () => {
  it("uses exact protected branch matching", () => {
    expect(isProtectedBranch("main")).toBe(true);
    expect(isProtectedBranch("production")).toBe(true);
    expect(isProtectedBranch("main/feature-x")).toBe(false);
    expect(isProtectedBranch("develop-2")).toBe(false);
  });

  it("blocks auto mode on protected branches before creating a session", async () => {
    const root = createStoryRepo("main");
    const result = await handleAutonomousGuide(root, { sessionId: null, action: "start" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("protected branch 'main'");
  });

  it("blocks work mode when the worktree is dirty", async () => {
    const root = createStoryRepo();
    writeFileSync(join(root, "dirty.txt"), "dirty\n");

    const result = await handleAutonomousGuide(root, {
      sessionId: null,
      action: "start",
      mode: "work",
      ticketId: "TEST-T-001",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("work mode requires a clean worktree");
  });
});

describe("autonomous guide schema", () => {
  it("rejects non-namespaced ticket IDs at the tool boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "story-work-schema-"));
    roots.push(root);
    const guide = getStorybloqToolDefinitions(root).find((tool) => tool.name === "storybloq_autonomous_guide");
    expect(guide).toBeTruthy();
    expect(guide!.inputSchema!.ticketId!.safeParse("T-001").success).toBe(false);
    expect(guide!.inputSchema!.ticketId!.safeParse("TEST-T-001").success).toBe(true);
    const reportSchema = guide!.inputSchema!.report!;
    expect(reportSchema.safeParse({ completedAction: "ticket_picked", ticketId: "T-001" }).success).toBe(false);
    expect(reportSchema.safeParse({ completedAction: "ticket_picked", ticketId: "TEST-T-001" }).success).toBe(true);
  });
});

describe("work mode gates", () => {
  it("pauses at plan approval, executes, revises at ship gate, and validates pinned branch", async () => {
    const root = createStoryRepo();
    const start = await handleAutonomousGuide(root, {
      sessionId: null,
      action: "start",
      mode: "work",
      ticketId: "TEST-T-001",
    });
    expect(start.isError, start.content[0]!.text).not.toBe(true);
    const sessionId = onlySessionId(root);
    expect(readState(root, sessionId)).toMatchObject({
      mode: "work",
      state: "PLAN",
      work: { pinnedBranch: "feature/work-mode" },
    });

    writeFileSync(join(root, ".story", "sessions", sessionId, "plan.md"), "# Plan\n\nDo the thing.\n");
    const planWritten = await handleAutonomousGuide(root, {
      sessionId,
      action: "report",
      report: { completedAction: "plan_written" },
    });
    expect(planWritten.isError).not.toBe(true);
    expect(readState(root, sessionId).state).toBe("PLAN_REVIEW");

    const planApproved = await handleAutonomousGuide(root, {
      sessionId,
      action: "report",
      report: {
        completedAction: "plan_review_round",
        verdict: "approve",
        findings: [],
      },
    });
    expect(planApproved.content[0]!.text).toContain("Awaiting Plan Approval");
    expect(readState(root, sessionId).state).toBe("PENDING_PLAN_APPROVAL");
    expect(deriveClaudeStatus("PENDING_PLAN_APPROVAL")).toBe("waiting");

    execSync("git checkout -b other-branch", { cwd: root, stdio: "ignore" });
    const wrongBranch = await handleAutonomousGuide(root, { sessionId, action: "execute" });
    expect(wrongBranch.isError).toBe(true);
    expect(wrongBranch.content[0]!.text).toContain("pinned to branch 'feature/work-mode'");
    execSync("git checkout feature/work-mode", { cwd: root, stdio: "ignore" });

    const execute = await handleAutonomousGuide(root, { sessionId, action: "execute" });
    expect(execute.isError).not.toBe(true);
    expect(readState(root, sessionId).state).toBe("IMPLEMENT");

    writeFileSync(join(root, "feature.txt"), "implemented\n");
    const implementationDone = await handleAutonomousGuide(root, {
      sessionId,
      action: "report",
      report: { completedAction: "implementation_done" },
    });
    expect(implementationDone.isError).not.toBe(true);
    expect(readState(root, sessionId).state).toBe("CODE_REVIEW");

    const codeApproved = await handleAutonomousGuide(root, {
      sessionId,
      action: "report",
      report: {
        completedAction: "code_review_round",
        verdict: "approve",
        findings: [],
      },
    });
    expect(codeApproved.content[0]!.text).toContain("Ready to Ship");
    const pendingShip = readState(root, sessionId);
    expect(pendingShip.state).toBe("PENDING_SHIP");
    expect(pendingShip.work.changedFiles).toContain("feature.txt");
    expect(deriveClaudeStatus("PENDING_SHIP")).toBe("waiting");

    const revise = await handleAutonomousGuide(root, {
      sessionId,
      action: "revise",
      feedback: "Add a more explicit implementation.",
    });
    expect(revise.isError).not.toBe(true);
    expect(revise.content[0]!.text).toContain("Add a more explicit implementation.");
    expect(readState(root, sessionId).state).toBe("IMPLEMENT");
  });
});
