# Human-Gated Issue Work and Test-First Fix Loops Implementation Plan

## Summary

Implement ADR 0003 by extending human-gated work mode to support issue IDs, requiring a test-first issue reproduction phase before planning, and routing work-mode functional code-review findings through a regression-test-first loop before implementation resumes.

## Key Changes

- Extend `storybloq_autonomous_guide` start input so work mode accepts exactly one of `ticketId` or `issueId`.
- Add workflow states and registered stages:
  - `REPRODUCE_ISSUE`: records failing reproduction tests or a non-applicable rationale before issue planning.
  - `REGRESSION_TEST`: records failing regression tests or a non-testable rationale before fixing work-mode review findings.
- Add work-session metadata for reproduction and regression-test proof: applicability, test paths, command, failure summary, non-applicable reason, and manual verification.
- Add optional `claimedBySession` to issue records and apply the same ownership safety model used by ticket claims.

## Implementation Details

- Work-mode issue start validates the issue exists, is not resolved, is unclaimed or safely reclaimable, writes a pending mutation marker, marks the issue `inprogress`, records the session claim, pins the branch, and enters `REPRODUCE_ISSUE`.
- Issue planning and implementation instructions use `currentIssue` when no ticket is active and require issue plans to reference reproduction evidence or the no-test rationale.
- Work-mode issue implementation must resolve the issue JSON before the ship gate; ship clears the issue claim, and finalize records the issue in `resolvedIssues`.
- Work-mode code review classifies functional findings by category and severity. Functional findings route to `REGRESSION_TEST` unless the report notes that automated testing is not applicable.
- Legacy non-work issue fixing through `ISSUE_FIX` remains unchanged.
- Cancel and skip paths restore owned in-progress issues to `open` and clear claims without overwriting another active session’s claim.

## Test Plan

- Add integration coverage for issue work-mode start, claim acquisition, reproduction reporting, plan approval gate, execute transition, issue resolution before ship, and cancel claim restoration.
- Add work-mode regression-loop coverage for functional code-review findings.
- Add schema coverage for `IssueSchema.claimedBySession`.
- Verify stage registry invariants include the new registered stages.
- Run `npm test` and `npm run build`.

## Assumptions

- The public API uses a new top-level `issueId` for work-mode issue starts instead of overloading `ticketId`.
- Reproduction and regression proof is stored in session metadata from guide report payloads, not parsed from markdown.
- `/story auto` and legacy non-work `ISSUE_FIX` behavior are intentionally unchanged.
