import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
import type { Finding, GuideReportInput } from "../session-types.js";
import { requiredRounds, nextReviewer } from "../review-depth.js";
import { clearCache } from "../review-lenses/cache.js";
import { gitDiffNames, gitStatus } from "../git-inspector.js";
import { accumulateVerificationCounters } from "../review-lenses/verification-log.js";
import { writeReviewVerdict, readReviewVerdict, buildTier1Verdict, type ReviewVerdictArtifact } from "../review-verdict.js";
import {
  nativeCodexReportInstruction,
  nativeCodexReviewCommand,
  reviewBackendsForClient,
  shouldUseNativeCodexReview,
} from "./codex-native.js";

function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) return null;
  const raw = line.slice(3).trim();
  if (!raw) return null;
  const arrow = raw.indexOf(" -> ");
  return arrow >= 0 ? raw.slice(arrow + 4).trim() : raw;
}

function isManagedSessionPath(filePath: string): boolean {
  return filePath.startsWith(".story/sessions/") || filePath === ".story/status.json";
}

async function currentWorktreeChangedFiles(root: string, mergeBase?: string | null): Promise<string[]> {
  const files = new Set<string>();
  const status = await gitStatus(root);
  if (status.ok) {
    for (const line of status.data) {
      const filePath = parsePorcelainPath(line);
      if (filePath && !isManagedSessionPath(filePath)) files.add(filePath);
    }
  }
  if (mergeBase) {
    const diffNames = await gitDiffNames(root, mergeBase);
    if (diffNames.ok) {
      for (const filePath of diffNames.data) {
        if (!isManagedSessionPath(filePath)) files.add(filePath);
      }
    }
  }
  return [...files].sort();
}

const FUNCTIONAL_FINDING_CATEGORIES = new Set([
  "behavior",
  "validation",
  "error-handling",
  "state",
  "security",
  "concurrency",
  "regression",
  "api",
  "data",
  "test-quality",
]);

function isFunctionalFinding(finding: Finding): boolean {
  const category = finding.category.toLowerCase();
  return FUNCTIONAL_FINDING_CATEGORIES.has(category) ||
    (finding.recommendedNextState === "IMPLEMENT" && (finding.severity === "critical" || finding.severity === "major"));
}

function hasNonTestableRationale(notes: string | undefined): boolean {
  return !!notes && /(not testable|not applicable|cannot be tested|no automated test|manual verification)/i.test(notes);
}

/**
 * CODE_REVIEW stage — independent reviewer evaluates the implementation.
 *
 * enter(): Instruction to run code review with specified backend.
 * report(): Process verdict → advance (FINALIZE), retry (next round),
 *           back (IMPLEMENT for changes, PLAN for redirect).
 *
 * Multi-write: CODE_REVIEW → PLAN redirect resets both review histories.
 * StageContext handles state consistency across these writes.
 */
export class CodeReviewStage implements WorkflowStage {
  readonly id = "CODE_REVIEW";

  async enter(ctx: StageContext): Promise<StageResult> {
    const backends = reviewBackendsForClient(ctx.state.config);
    const codeReviews = ctx.state.reviews.code;
    const roundNum = codeReviews.length + 1;
    const reviewer = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const risk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk ?? "low";
    const rounds = requiredRounds(risk as "low" | "medium" | "high");
    const mergeBase = ctx.state.git.mergeBase;
    const isIssueFix = !!ctx.state.currentIssue;
    const issueHeader = isIssueFix
      ? `Issue Fix Code Review (${ctx.state.currentIssue!.id})`
      : "Code Review";

    const diffCommand = mergeBase
      ? `\`git diff ${mergeBase}\``
      : `\`git diff HEAD\` AND \`git ls-files --others --exclude-standard\``;
    const diffReminder = mergeBase
      ? `Run: git diff ${mergeBase} — pass FULL output to reviewer.`
      : "Run: git diff HEAD + git ls-files --others --exclude-standard — pass FULL output to reviewer.";

    if (!ctx.state.currentReviewStartedAt) {
      ctx.writeState({ currentReviewStartedAt: new Date().toISOString() });
    }

    // Lenses backend: multi-lens parallel review
    if (reviewer === "lenses") {
      return {
        instruction: [
          `# Multi-Lens ${issueHeader} — Round ${roundNum} of ${rounds} minimum`,
          "",
          `Capture the diff with: ${diffCommand}`,
          "",
          "This round uses the **multi-lens review orchestrator**. It fans out to specialized review agents (Clean Code, Security, Error Handling, and more) in parallel, then synthesizes findings into a single verdict.",
          "",
          "1. Capture the full diff and changed file list (`git diff --name-only`)",
          "2. Call `storybloq_review_lenses_prepare` with the diff, changedFiles, stage: CODE_REVIEW, and ticketDescription",
          "3. Spawn all lens subagents in parallel (each prompt is returned by the prepare tool)",
          "4. Collect results and call `storybloq_review_lenses_synthesize` with the lens results, plus the diff and changedFiles from step 1 and the sessionId (enables automatic origin classification and issue filing for pre-existing findings)",
          "5. Run the merger agent with the returned mergerPrompt, then call `storybloq_review_lenses_judge`",
          "6. Run the judge agent and report the final SynthesisResult verdict and findings",
          "",
          "When done, report verdict and findings.",
        ].join("\n"),
        reminders: [
          diffReminder,
          "Do NOT compress or summarize the diff.",
          "Lens subagents run in parallel with read-only tools (Read, Grep, Glob).",
          "Pre-existing issues in surrounding code are automatically classified and filed by the synthesize tool when you pass diff, changedFiles, and sessionId. Check filedIssues in the synthesize response.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

    if (shouldUseNativeCodexReview(reviewer, ctx.state.config)) {
      const command = nativeCodexReviewCommand("code", ctx.state.sessionId);
      return {
        instruction: [
          `# Native Codex ${issueHeader} - Round ${roundNum} of ${rounds} minimum`,
          "",
          `Capture baseline context with: ${diffCommand}`,
          "",
          "Run native Codex code review:",
          "```bash",
          command,
          "```",
          "",
          nativeCodexReportInstruction(ctx.state.sessionId),
        ].join("\n"),
        reminders: [
          diffReminder,
          "The helper writes the diff to .story/sessions/<id>/review/diff.patch and runs Codex with read-only sandboxing.",
          "If native Codex fails, fall back to the next configured reviewer if available; otherwise use agent review and include 'codex unavailable' in notes.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

    return {
      instruction: [
        `# ${issueHeader} — Round ${roundNum} of ${rounds} minimum`,
        "",
        `Capture the diff with: ${diffCommand}`,
        "",
        "**IMPORTANT:** Pass the FULL unified diff to the reviewer. For diffs over ~500 lines, use file-scoped chunks (`git diff <mergebase> -- <filepath>`) across separate calls (pass the same session_id). Do NOT summarize or truncate any individual chunk.",
        "",
        `Run a code review using **${reviewer}**.`,
        "When done, report verdict and findings.",
      ].join("\n"),
      reminders: [
        diffReminder,
        "Do NOT compress or summarize the diff.",
        "If the reviewer flags pre-existing issues unrelated to your changes, file them as issues using storybloq_issue_create with severity and impact. Do not fix them in this ticket.",
        ...(reviewer === "codex" ? ["If codex is unavailable (usage limit, error, etc.), fall back to agent review and include 'codex unavailable' in your report notes."] : []),
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    if (report.completedAction === "skip_ticket") {
      const ticketId = ctx.state.ticket?.id ?? ctx.state.currentIssue?.id ?? "unknown";
      const reason = report.notes ?? "Ticket cannot be completed in this session.";

      if (ctx.state.ticket) {
        try {
          const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
          await withProjectLock(ctx.root, { strict: false }, async ({ state: ps }) => {
            const ticket = ps.ticketByID(ticketId);
            if (ticket && (ticket as Record<string, unknown>).claimedBySession === ctx.state.sessionId) {
              writeTicketUnlocked(ctx.root, { ...ticket, status: "open", claimedBySession: undefined } as Record<string, unknown>);
            }
          });
        } catch { /* best-effort */ }
      }

      if (ctx.state.currentIssue) {
        try {
          const { withProjectLock, writeIssueUnlocked } = await import("../../core/project-loader.js");
          await withProjectLock(ctx.root, { strict: false }, async ({ state: ps }) => {
            const issue = ps.issueByID(ctx.state.currentIssue!.id);
            if (issue && issue.status === "inprogress") {
              const claim = (issue as Record<string, unknown>).claimedBySession;
              if (!claim || claim === ctx.state.sessionId) {
                await writeIssueUnlocked({ ...issue, status: "open" as const, claimedBySession: null }, ctx.root);
              }
            }
          });
        } catch { /* best-effort */ }
      }

      ctx.updateDraft({ ticket: undefined, currentIssue: null, reviews: { plan: [], code: [] } });
      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: [
            `# Ticket Skipped: ${ticketId}`,
            "",
            `**Reason:** ${reason}`,
            "",
            "Write a handover documenting why this ticket was skipped and what the next session should know.",
            "",
            'Call `storybloq_autonomous_guide` with completedAction: "handover_written" and include the content in handoverContent.',
          ].join("\n"),
          reminders: [],
          transitionedFrom: "CODE_REVIEW",
        },
      };
    }

    const verdict = report.verdict;
    if (!verdict || !["approve", "revise", "request_changes", "reject"].includes(verdict)) {
      return { action: "retry", instruction: 'Invalid verdict. Re-submit with verdict: "approve", "revise", "request_changes", or "reject".' };
    }

    const codeReviews = [...ctx.state.reviews.code];
    const roundNum = codeReviews.length + 1;
    const findings = report.findings ?? [];
    const backends = reviewBackendsForClient(ctx.state.config);
    const computedReviewer = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    // ISS-102: Use actual reviewer from report, infer from notes, or fall back to computed
    const reviewerBackend = report.reviewer
      ?? (computedReviewer === "codex" && report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes) ? "agent" : null)
      ?? computedReviewer;
    codeReviews.push({
      round: roundNum,
      reviewer: reviewerBackend,
      verdict,
      findingCount: findings.length,
      criticalCount: findings.filter((f) => f.severity === "critical").length,
      majorCount: findings.filter((f) => f.severity === "major").length,
      suggestionCount: findings.filter((f) => f.severity === "suggestion").length,
      codexSessionId: report.reviewerSessionId,
      timestamp: new Date().toISOString(),
    });

    // ISS-098: Detect codex unavailability from agent notes
    // ISS-110: Store timestamp instead of just boolean for TTL-based expiry
    if (report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes)) {
      ctx.writeState({ codexUnavailable: true, codexUnavailableSince: new Date().toISOString() });
    }

    const risk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk ?? "low";
    const minRounds = requiredRounds(risk as "low" | "medium" | "high");
    // ISS-073: Only count unresolved findings (open/contested) as contradictory with approve
    const hasCriticalOrMajor = findings.some(
      (f) => (f.severity === "critical" || f.severity === "major") &&
        f.disposition !== "addressed" && f.disposition !== "deferred",
    );

    // Check for PLAN redirect
    const planRedirect = findings.some((f) => f.recommendedNextState === "PLAN");

    // Guard contradictory approve payloads (ISS-035)
    if (verdict === "approve" && hasCriticalOrMajor) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict." };
    }
    if (verdict === "approve" && planRedirect) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but findings recommend replanning. Re-run the review or correct the verdict." };
    }

    const requiresRegressionTest = ctx.state.mode === "work" &&
      verdict !== "approve" &&
      findings.some((f) => f.disposition !== "addressed" && f.disposition !== "deferred" && isFunctionalFinding(f)) &&
      !hasNonTestableRationale(report.notes);

    let nextAction: "PLAN" | "IMPLEMENT" | "REGRESSION_TEST" | "FINALIZE" | "CODE_REVIEW";
    if (planRedirect && verdict !== "approve") {
      nextAction = "PLAN";
    } else if (requiresRegressionTest) {
      nextAction = "REGRESSION_TEST";
    } else if (verdict === "reject" || verdict === "revise" || verdict === "request_changes") {
      nextAction = "IMPLEMENT";
    } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
      nextAction = "FINALIZE";
    } else if (roundNum >= 5) {
      nextAction = "FINALIZE";
    } else {
      nextAction = "CODE_REVIEW";
    }

    // T-263: Build and write review verdict artifact
    const target = ctx.state.ticket?.id ?? ctx.state.currentIssue?.id ?? "unknown";
    const criticalCount = findings.filter((f) => f.severity === "critical").length;
    const majorCount = findings.filter((f) => f.severity === "major").length;
    const minorCount = findings.filter((f) => f.severity === "minor").length;
    const suggestionCount = findings.filter((f) => f.severity === "suggestion").length;
    const startedAt = ctx.state.currentReviewStartedAt;
    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    const summary = report.notes || `Code review ${verdict}: ${findings.length} finding(s) (${criticalCount} critical, ${majorCount} major)`;
    const artifact: ReviewVerdictArtifact = {
      target,
      stage: "code",
      round: roundNum,
      reviewer: reviewerBackend,
      verdict,
      findingsCount: findings.length,
      severityCounts: { critical: criticalCount, major: majorCount, minor: minorCount, suggestion: suggestionCount },
      startedAt: startedAt ?? new Date().toISOString(),
      durationMs,
      summary,
      findings,
      timestamp: new Date().toISOString(),
    };
    const writeResult = writeReviewVerdict(ctx.dir, artifact);

    if (writeResult.status === "skipped") {
      return { action: "retry", instruction: "Review artifact write failed (lock contention or I/O error). Re-report your review verdict." };
    }

    let tier1Verdict = buildTier1Verdict(artifact);
    if (writeResult.status === "exists") {
      const recovered = readReviewVerdict(ctx.dir, writeResult.contentHash);
      if (!recovered) {
        return { action: "retry", instruction: "Review artifact recovery failed (content mismatch). Re-report your review verdict." };
      }
      tier1Verdict = buildTier1Verdict(recovered);
    }

    // T-208: Issue-fix context
    const isIssueFix = !!ctx.state.currentIssue;

    // CODE_REVIEW -> PLAN: full reset with verdict artifact
    if (nextAction === "PLAN") {
      clearCache(ctx.dir);
      ctx.writeState({
        reviews: { plan: [], code: [] },
        lensReviewHistory: [],
        ticket: ctx.state.ticket ? { ...ctx.state.ticket, realizedRisk: undefined } : ctx.state.ticket,
        lastReviewVerdict: tier1Verdict,
        currentReviewStartedAt: null,
      });

      ctx.appendEvent("code_review", {
        round: roundNum,
        verdict,
        findingCount: findings.length,
        redirectedTo: isIssueFix && ctx.state.mode !== "work" ? "ISSUE_FIX" : "PLAN",
      });

      await ctx.fileDeferredFindings(findings, "code");

      if (isIssueFix && ctx.state.mode !== "work") {
        return { action: "goto", target: "ISSUE_FIX" };
      }
      return { action: "back", target: "PLAN", reason: "plan_redirect" };
    }

    // Normal transitions + T-181 lens history (single atomic write)
    const stateUpdate: Record<string, unknown> = {
      reviews: { ...ctx.state.reviews, code: codeReviews },
      lastReviewVerdict: tier1Verdict,
      currentReviewStartedAt: null,
    };
    if (reviewerBackend === "lenses" && findings.length > 0) {
      const updated = buildLensHistoryUpdate(
        findings,
        ctx.state.lensReviewHistory ?? [],
        ctx.state.ticket?.id ?? "unknown",
        "CODE_REVIEW",
      );
      if (updated) stateUpdate.lensReviewHistory = updated;
    }
    ctx.writeState(stateUpdate);

    accumulateVerificationCounters({ sessionDir: ctx.dir, state: ctx.state, writeState: ctx.writeState.bind(ctx) });

    ctx.appendEvent("code_review", {
      round: roundNum,
      verdict,
      findingCount: findings.length,
    });

    await ctx.fileDeferredFindings(findings, "code");

    if (nextAction === "REGRESSION_TEST") {
      const functionalFindings = findings.filter((f) => f.disposition !== "addressed" && f.disposition !== "deferred" && isFunctionalFinding(f));
      return {
        action: "goto",
        target: "REGRESSION_TEST",
        result: {
          instruction: [
            "# Add Regression Test",
            "",
            "Code review found functional behavior that must be proven with a failing test before implementation resumes.",
            "",
            ...functionalFindings.slice(0, 5).map((f) => `- [${f.severity}] ${f.category}: ${f.description}`),
            "",
            "Add or update a focused regression test, run the targeted command, and verify it fails for the expected reason.",
            "",
            "When done, call `storybloq_autonomous_guide` with:",
            "```json",
            `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "regression_test_written", "regressionTest": { "applicable": true, "testPaths": ["path/to/test"], "command": "npm test -- path/to/test", "failureSummary": "fails because ..." } } }`,
            "```",
          ].join("\n"),
          reminders: ["Do not fix code before recording the failing regression test."],
          transitionedFrom: "CODE_REVIEW",
        },
      };
    }

    if (nextAction === "IMPLEMENT") {
      // T-208: Issue fixes route back to ISSUE_FIX instead of IMPLEMENT
      if (isIssueFix && ctx.state.mode !== "work") {
        return { action: "goto", target: "ISSUE_FIX" };
      }
      return { action: "back", target: "IMPLEMENT", reason: "request_changes" };
    }

    if (nextAction === "FINALIZE") {
      // T-135: Review mode exits after code review approval
      if (ctx.state.mode === "review") {
        ctx.finalizeSession({
          status: "completed" as const,
          terminationReason: "normal" as const,
        });
        return {
          action: "goto",
          target: "SESSION_END",
          result: {
            instruction: [
              "# Code Review Complete",
              "",
              `Code for **${ctx.state.ticket?.id}** has been approved after ${roundNum} review round(s).`,
              "",
              "Session ending — review mode is complete. You can now proceed to commit.",
            ].join("\n"),
            reminders: [],
            transitionedFrom: "CODE_REVIEW",
          },
        } as StageAdvance;
      }
      if (ctx.state.mode === "work") {
        const workTarget = ctx.state.ticket?.id ?? ctx.state.currentIssue?.id ?? "current work";
        if (ctx.state.currentIssue) {
          try {
            const { state: projectState } = await ctx.loadProject();
            const issue = projectState.issues.find((i) => i.id === ctx.state.currentIssue?.id);
            if (!issue || issue.status !== "resolved" || !issue.resolution?.trim() || !issue.resolvedDate) {
              return {
                action: "retry",
                instruction: `Issue ${ctx.state.currentIssue.id} must be resolved before the ship gate. Update .story/issues/${ctx.state.currentIssue.id}.json with status "resolved", resolution text, and resolvedDate, then report the code review verdict again.`,
                reminders: ["Do not pause at PENDING_SHIP until the issue JSON is resolved."],
              };
            }
          } catch (err) {
            return {
              action: "retry",
              instruction: `Failed to verify issue resolution: ${err instanceof Error ? err.message : String(err)}. Fix .story/ state and report the code review verdict again.`,
            };
          }
        }
        const changedFiles = await currentWorktreeChangedFiles(ctx.root, ctx.state.git.mergeBase);
        ctx.writeState({
          work: {
            pinnedBranch: ctx.state.work?.pinnedBranch ?? ctx.state.git.branch ?? null,
            changedFiles,
            shipChangePolicy: null,
          },
        });
        return {
          action: "goto",
          target: "PENDING_SHIP",
          result: {
            instruction: [
              "# Work Session -- Ready to Ship",
              "",
              `Code for **${workTarget}** has passed automated review after ${roundNum} round(s).`,
              "",
              "Surface the diff summary, test results, and review result to the human.",
              "If they approve, they should run `/story ship`.",
              "If they provide feedback, call `storybloq_autonomous_guide` with:",
              "```json",
              `{ "sessionId": "${ctx.state.sessionId}", "action": "revise", "feedback": "<human feedback>" }`,
              "```",
            ].join("\n"),
            reminders: ["Stop at this gate. Do not finalize or commit until the human approves shipping."],
            transitionedFrom: "CODE_REVIEW",
          },
        } as StageAdvance;
      }
      return { action: "advance" };
    }

    // Stay in CODE_REVIEW
    const nextReviewerName = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const mergeBase = ctx.state.git.mergeBase;
    return {
      action: "retry",
      instruction: [
        `Code review round ${roundNum} found issues. Fix them and re-review with **${nextReviewerName}**.`,
        "",
        `Capture diff with: ${mergeBase ? `\`git diff ${mergeBase}\`` : "`git diff HEAD` + `git ls-files --others --exclude-standard`"}. Pass FULL output — do NOT compress or summarize.`,
      ].join("\n"),
      reminders: ["Pass FULL diff output to reviewer. Do NOT compress or summarize."],
    };
  }
}
