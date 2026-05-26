import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput, WorkTestProof } from "../session-types.js";

function validateProof(proof: WorkTestProof | undefined, label: string): string | null {
  if (!proof) return `${label} report is missing.`;
  if (proof.applicable) {
    if (!proof.testPaths || proof.testPaths.length === 0) return `${label} must include at least one test path.`;
    if (!proof.command?.trim()) return `${label} must include the targeted test command.`;
    if (!proof.failureSummary?.trim()) return `${label} must include the expected failure summary.`;
    return null;
  }
  if (!proof.notApplicableReason?.trim()) return `${label} must explain why an automated test is not applicable.`;
  if (!proof.manualVerification?.trim()) return `${label} must include manual verification steps.`;
  return null;
}

export class ReproduceIssueStage implements WorkflowStage {
  readonly id = "REPRODUCE_ISSUE";

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    const issue = ctx.state.currentIssue;
    if (!issue) return { action: "goto", target: "PICK_TICKET" };

    let details = `**${issue.id}**: ${issue.title} (severity: ${issue.severity})`;
    try {
      const { state } = await ctx.loadProject();
      const fullIssue = state.issues.find((i) => i.id === issue.id);
      if (fullIssue) {
        details = [
          `**${fullIssue.id}**: ${fullIssue.title}`,
          "",
          `Severity: ${fullIssue.severity}`,
          fullIssue.impact ? `Impact: ${fullIssue.impact}` : "",
          fullIssue.components.length > 0 ? `Components: ${fullIssue.components.join(", ")}` : "",
          fullIssue.location.length > 0 ? `Location: ${fullIssue.location.join(", ")}` : "",
        ].filter(Boolean).join("\n");
      }
    } catch {
      // Best-effort context only; the session already carries enough to proceed.
    }

    return {
      instruction: [
        "# Reproduce Issue",
        "",
        details,
        "",
        "Before planning the fix, add one or more focused tests that reproduce this issue when an automated test is applicable.",
        "Run the targeted command and verify the test fails for the expected reason, not from a syntax error or invalid test setup.",
        "",
        "If no automated reproduction is applicable, record why and include manual verification steps.",
        "",
        "When done, call `storybloq_autonomous_guide` with:",
        "```json",
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_reproduced", "reproduction": { "applicable": true, "testPaths": ["path/to/test"], "command": "npm test -- path/to/test", "failureSummary": "fails because ..." } } }`,
        "```",
      ].join("\n"),
      reminders: [
        "Do not plan or implement the fix until the reproduction result is recorded.",
        "If automated reproduction is not applicable, include notApplicableReason and manualVerification.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    if (report.completedAction !== "issue_reproduced") {
      return {
        action: "retry",
        instruction: 'Unexpected action at REPRODUCE_ISSUE. Report completedAction: "issue_reproduced" with reproduction details.',
      };
    }

    const error = validateProof(report.reproduction, "Reproduction");
    if (error) return { action: "retry", instruction: error };

    const reproduction = report.reproduction!;
    ctx.updateDraft({
      work: {
        pinnedBranch: ctx.state.work?.pinnedBranch ?? ctx.state.git.branch ?? null,
        changedFiles: ctx.state.work?.changedFiles ?? [],
        shipChangePolicy: ctx.state.work?.shipChangePolicy ?? null,
        reproduction,
        regressionTest: ctx.state.work?.regressionTest,
      },
    });

    const issue = ctx.state.currentIssue;
    return {
      action: "goto",
      target: "PLAN",
      result: {
        instruction: [
          `# Plan for ${issue?.id ?? "issue"}: ${issue?.title ?? ""}`,
          "",
          reproduction.applicable
            ? [
                "The issue has a failing reproduction test.",
                `Test path(s): ${(reproduction.testPaths ?? []).join(", ")}`,
                `Command: ${reproduction.command}`,
                `Failure summary: ${reproduction.failureSummary}`,
              ].join("\n")
            : [
                "Automated reproduction was recorded as not applicable.",
                `Reason: ${reproduction.notApplicableReason}`,
                `Manual verification: ${reproduction.manualVerification}`,
              ].join("\n"),
          "",
          `Write the fix plan as markdown at \`.story/sessions/${ctx.state.sessionId}/plan.md\`. Include the reproduction evidence above.`,
          "",
          "When done, call `storybloq_autonomous_guide` with:",
          "```json",
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          "```",
        ].join("\n"),
        reminders: [
          "Write the plan as a markdown file -- do not use Claude Code's plan mode.",
          "The plan must reference the reproduction test or non-applicable rationale.",
        ],
        transitionedFrom: "REPRODUCE_ISSUE",
      },
    };
  }
}
