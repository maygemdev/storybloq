import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput, WorkTestProof } from "../session-types.js";

function validateProof(proof: WorkTestProof | undefined): string | null {
  if (!proof) return "Regression test report is missing.";
  if (proof.applicable) {
    if (!proof.testPaths || proof.testPaths.length === 0) return "Regression test report must include at least one test path.";
    if (!proof.command?.trim()) return "Regression test report must include the targeted test command.";
    if (!proof.failureSummary?.trim()) return "Regression test report must include the expected failure summary.";
    return null;
  }
  if (!proof.notApplicableReason?.trim()) return "Regression test report must explain why an automated test is not applicable.";
  if (!proof.manualVerification?.trim()) return "Regression test report must include manual verification steps.";
  return null;
}

export class RegressionTestStage implements WorkflowStage {
  readonly id = "REGRESSION_TEST";

  async enter(ctx: StageContext): Promise<StageResult> {
    const target = ctx.state.ticket?.id ?? ctx.state.currentIssue?.id ?? "current work";
    return {
      instruction: [
        "# Add Regression Test",
        "",
        `Code review found a functional bug for **${target}**. Before fixing it, add or update a focused test that fails against the current code and demonstrates the reviewed bug.`,
        "",
        "Run the targeted command and verify the test fails for the expected reason. If the finding cannot be tested automatically, record why and include manual verification steps before fixing.",
        "",
        "When done, call `storybloq_autonomous_guide` with:",
        "```json",
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "regression_test_written", "regressionTest": { "applicable": true, "testPaths": ["path/to/test"], "command": "npm test -- path/to/test", "failureSummary": "fails because ..." } } }`,
        "```",
      ].join("\n"),
      reminders: [
        "Do not fix the code until the failing regression test or non-testable rationale is recorded.",
        "The next step after this stage is IMPLEMENT.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    if (report.completedAction !== "regression_test_written") {
      return {
        action: "retry",
        instruction: 'Unexpected action at REGRESSION_TEST. Report completedAction: "regression_test_written" with regressionTest details.',
      };
    }

    const error = validateProof(report.regressionTest);
    if (error) return { action: "retry", instruction: error };

    ctx.updateDraft({
      work: {
        pinnedBranch: ctx.state.work?.pinnedBranch ?? ctx.state.git.branch ?? null,
        changedFiles: ctx.state.work?.changedFiles ?? [],
        shipChangePolicy: ctx.state.work?.shipChangePolicy ?? null,
        reproduction: ctx.state.work?.reproduction,
        regressionTest: report.regressionTest!,
      },
    });

    return { action: "goto", target: "IMPLEMENT" };
  }
}
