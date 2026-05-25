/**
 * T-185: Compact session report tests.
 */
import { describe, it, expect } from "vitest";
import { formatCompactReport, type CompactReportData } from "../../src/core/session-report-formatter.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "SESSION_END", revision: 1, status: "completed",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: "normal", waitingForRetry: false, lastGuideCall: now,
    startedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    guideCallCount: 20,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [],
    ...overrides,
  } as FullSessionState;
}

describe("formatCompactReport", () => {
  it("produces duration, ticket count, issue count, review stats", () => {
    const state = makeState({
      completedTickets: [
        { id: "TEST-T-001", title: "First", commitHash: "aaa" },
        { id: "TEST-T-002", title: "Second", commitHash: "bbb" },
      ],
      resolvedIssues: ["TEST-ISS-001"],
      reviews: {
        plan: [{ round: 1, reviewer: "codex", verdict: "approve", findingCount: 3, criticalCount: 0, majorCount: 1, suggestionCount: 2, timestamp: new Date().toISOString() }],
        code: [{ round: 1, reviewer: "agent", verdict: "approve", findingCount: 5, criticalCount: 1, majorCount: 2, suggestionCount: 2, timestamp: new Date().toISOString() }],
      },
      contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 2, compactionCount: 3, eventsLogBytes: 0 },
    });

    const report = formatCompactReport({ state });
    expect(report).toContain("## Session Report");
    expect(report).toContain("**Tickets:** 2");
    expect(report).toContain("**Issues:** 1");
    expect(report).toContain("**Reviews:** 2 rounds (8 findings)");
    expect(report).toContain("**Compactions:** 3");
    expect(report).toContain("TEST-T-001");
    expect(report).toContain("TEST-T-002");
  });

  it("includes per-ticket timing when available (T-187)", () => {
    const state = makeState({
      completedTickets: [
        { id: "TEST-T-001", title: "Timed", commitHash: "aaa",
          startedAt: "2026-04-04T10:00:00.000Z",
          completedAt: "2026-04-04T10:30:00.000Z" },
      ],
    });

    const report = formatCompactReport({ state });
    expect(report).toContain("30m");
    expect(report).toContain("**Avg time per ticket:** 30m");
  });

  it("shows What's Left when remainingWork provided", () => {
    const state = makeState();
    const data: CompactReportData = {
      state,
      remainingWork: {
        tickets: [{ id: "TEST-T-010", title: "Next task" }],
        issues: [{ id: "TEST-ISS-005", title: "Bug fix", severity: "high" }],
      },
    };

    const report = formatCompactReport(data);
    expect(report).toContain("### What's Left");
    expect(report).toContain("TEST-T-010: Next task");
    expect(report).toContain("TEST-ISS-005: Bug fix (high)");
  });

  it("handles empty session (0 tickets, 0 issues)", () => {
    const state = makeState();
    const report = formatCompactReport({ state });
    expect(report).toContain("## Session Report");
    expect(report).toContain("**Tickets:** 0");
    expect(report).toContain("**Issues:** 0");
    expect(report).not.toContain("### Completed");
    expect(report).not.toContain("### What's Left");
  });

  it("uses endedAt for duration when provided", () => {
    const start = "2026-04-04T10:00:00.000Z";
    const end = "2026-04-04T12:15:00.000Z";
    const state = makeState({ startedAt: start, lastGuideCall: start });

    const report = formatCompactReport({ state, endedAt: end });
    expect(report).toContain("2h 15m");
  });

  it("handles tickets without timing data gracefully", () => {
    const state = makeState({
      completedTickets: [
        { id: "TEST-T-001", title: "No timing", commitHash: "aaa" },
      ],
    });

    const report = formatCompactReport({ state });
    expect(report).toContain("TEST-T-001");
    expect(report).toContain("--"); // no duration
    expect(report).not.toContain("**Avg time per ticket:**");
  });
});
