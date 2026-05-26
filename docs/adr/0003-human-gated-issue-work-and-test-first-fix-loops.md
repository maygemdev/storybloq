# ADR 0003: Human-Gated Issue Work and Test-First Fix Loops

- **Status:** Proposed
- **Date:** 2026-05-26
- **Owner:** Storybloq maintainers
- **Extends:** [ADR 0002: Human-Gated Work Mode](./0002-human-gated-work-mode.md)
- **Related areas:** `src/autonomous/guide.ts`, `src/autonomous/session-types.ts`, `src/autonomous/stages/issue-fix.ts`, `src/autonomous/stages/code-review.ts`, `src/autonomous/stages/implement.ts`, `src/autonomous/state-machine.ts`, `src/skill/SKILL.md`, `src/skill/autonomous-mode.md`, `src/mcp/tools.ts`

## Context

ADR 0002 introduces human-gated work mode for tickets via:

```text
/story start {NS}-T-XXX
/story execute
/story ship
```

That design intentionally describes a ticket-first workflow: plan, automated plan review, human plan gate, implementation, tests, code review, human ship gate, commit.

Storybloq also has issue records (`{NS}-ISS-NNN`) with statuses:

```text
open -> inprogress -> resolved
```

Current autonomous mode can pick issues from `PICK_TICKET`, mark them `inprogress`, enter `ISSUE_FIX`, and finalize a commit. However, human-gated work mode should also support issues. Issue work has an additional quality requirement: before planning a fix, the agent should try to create one or more failing tests that reproduce the issue. Likewise, when code review finds a functional bug, the agent should first add a failing regression test that proves the bug exists, then fix the code.

Without this, issue fixes and review-fix loops can become implementation-first: the agent may patch code without proving the defect, increasing the risk of non-reproducible fixes and regressions.

## Decision

Expand human-gated work mode so `/story start` accepts either a ticket ID or an issue ID:

```text
/story start {NS}-T-XXX
/story start {NS}-ISS-XXX
```

Ticket work keeps the ADR 0002 workflow. Issue work uses the same human gates, but starts with a test-first reproduction phase before planning:

```text
/story start {NS}-ISS-XXX
    │
    ├── branch guard
    ├── clean worktree check
    ├── pin session to current branch
    ├── mark issue inprogress and claim it for this session
    │
    ▼
  REPRODUCE_ISSUE
    │   write one or more reproduction tests if applicable
    │   run targeted command and verify they fail for the expected reason
    ▼
  PLAN
    │   write fix plan informed by failing reproduction tests
    ▼
  PLAN_REVIEW
    │
    ▼
  PENDING_PLAN_APPROVAL
    │
    ▼  /story execute

  IMPLEMENT
    │   fix the issue according to approved plan
    │   update issue JSON to resolved before ship gate
    ▼
  TEST
    │   reproduction/regression tests must pass, plus configured test suite
    ▼
  CODE_REVIEW
    │
    ├── if review finds functional bug:
    │       REGRESSION_TEST -> IMPLEMENT -> TEST -> CODE_REVIEW
    │
    ▼
  PENDING_SHIP
    │
    ▼  /story ship

  FINALIZE
    │
    ▼
  COMMIT
    │
    ▼
  COMPLETE
```

Additionally, in human-gated work mode, any code-review finding that describes a functional bug or behavioral regression must follow a test-first fix loop:

```text
CODE_REVIEW finding: functional bug
    │
    ▼
  REGRESSION_TEST
    │   add test that fails against current code and demonstrates the bug
    ▼
  IMPLEMENT
    │   fix code so the new test passes
    ▼
  TEST
    │
    ▼
  CODE_REVIEW
```

This regression-test-first loop applies to both ticket work and issue work in human-gated work mode.

## Goals

- Allow `/story start {NS}-ISS-XXX` to run the same human-gated workflow as tickets.
- Require issue work to begin with reproduction tests when applicable.
- Require code-review-discovered functional bugs to be proven by failing tests before fixes are attempted.
- Preserve the two human gates from ADR 0002: plan approval and ship approval.
- Keep `/story auto` behavior unchanged unless explicitly extended later.
- Ensure issue status lifecycle is safe: claim on start, resolve before ship gate, restore on cancel when appropriate.

## Non-goals

- Multi-issue work sessions. Work mode remains one ticket or one issue per session.
- Requiring tests for changes where tests are not applicable or impossible. In those cases the agent must document the reason.
- Changing standard autonomous mode issue handling in this ADR.
- Replacing existing `ISSUE_FIX` behavior for non-work-mode autonomous sessions.

## Issue workflow details

### `/story start {NS}-ISS-XXX`

1. Run the same protected-branch guard as ticket work mode.
2. Require a clean worktree.
3. Create a work-mode session pinned to the current branch.
4. Validate the issue exists and is not `resolved`.
5. Mark the issue `inprogress` and record a session claim.
6. Enter `REPRODUCE_ISSUE`.
7. The agent writes reproduction tests when applicable and verifies they fail for the expected reason.
8. The agent writes a fix plan that references the reproduction tests or explains why no reproduction test was applicable.
9. Automated plan review runs.
10. Session pauses at `PENDING_PLAN_APPROVAL`.

### `/story execute`

From `PENDING_PLAN_APPROVAL`, issue work resumes into implementation:

1. Implement the approved fix plan.
2. Run the reproduction tests and ensure they now pass.
3. Run the configured test stage(s).
4. Update `.story/issues/{NS}-ISS-XXX.json` to `resolved`, including resolution text and resolved date.
5. Run code review.
6. If code review approves, pause at `PENDING_SHIP`.
7. If code review finds a functional bug, enter the test-first regression loop before fixing.

### `/story ship`

From `PENDING_SHIP`, issue work behaves like ticket work:

1. Verify the current branch matches the pinned branch.
2. Detect unexpected worktree changes and prompt if mixed changes exist.
3. Enter `FINALIZE`.
4. Stage only session-related code changes plus the resolved issue file.
5. Commit.
6. Record the issue in `resolvedIssues` and clear `currentIssue`.
7. End the session.

## Test-first reproduction phase

`REPRODUCE_ISSUE` is a new work-mode phase for issue sessions.

The agent must:

1. Inspect the issue description, impact, location, components, and any referenced files.
2. Decide whether an automated reproduction test is applicable.
3. If applicable:
   - create one or more focused failing tests;
   - run a targeted test command;
   - verify the test fails because of the issue, not because of syntax errors or an invalid test;
   - record the test command and failing output summary in the session.
4. If not applicable:
   - record a concise rationale in the plan;
   - include any manual verification steps that will be used instead.

The fix plan is not considered ready for plan review unless it includes either:

- reproduction test paths and the failing command/output summary, or
- a clear "reproduction test not applicable" rationale.

## Test-first code-review fix loop

When code review returns findings, the guide distinguishes functional bugs from non-functional findings.

A finding is considered a functional bug when it describes behavior that can be validated by a test, including but not limited to:

- incorrect output;
- missing validation;
- broken error handling;
- race conditions or state bugs;
- security-sensitive behavior that can be safely tested;
- regression from expected user-visible behavior.

For such findings, work mode must not go directly back to implementation. Instead it enters `REGRESSION_TEST`.

`REGRESSION_TEST` requires the agent to:

1. Add or update tests that fail against the current code and demonstrate the reviewed bug.
2. Run the targeted test command and verify expected failure.
3. Only then return to `IMPLEMENT` to fix the bug.
4. Re-run tests and code review after the fix.

If a finding is not testable, the agent must record why before fixing. Examples: purely visual polish without snapshot/visual testing infrastructure, documentation wording, dead-code cleanup, or refactors with no externally observable behavior.

## Issue status and claim lifecycle

Issue work mode uses the issue status lifecycle:

```text
open -> inprogress -> resolved
```

On `/story start {NS}-ISS-XXX`:

- If the issue is `open`, mark it `inprogress`.
- If the issue is already `inprogress` and claimed by this session, continue idempotently.
- If the issue is `inprogress` and claimed by another active session, fail.
- If the issue is `resolved`, fail.

Add an issue claim field analogous to ticket claims, for example:

```json
{
  "claimedBySession": "<sessionId>"
}
```

On successful `/story ship`:

- issue remains `resolved`;
- claim is cleared;
- session records the issue in `resolvedIssues`.

On cancel:

- if the issue is still `inprogress` and claimed by this session, restore it to `open` and clear the claim;
- if the issue has already been manually changed to `resolved`, leave it resolved and clear the claim if owned by this session;
- if the issue is claimed by another session or changed externally, do not overwrite it; report the conflict in the cancel event.

## State machine additions

Add two states for test-first work:

- `REPRODUCE_ISSUE` — issue-only start phase that creates failing reproduction tests when applicable before plan creation.
- `REGRESSION_TEST` — work-mode review-fix phase that creates failing tests for code-review-discovered functional bugs before implementation fixes.

ADR 0002 already adds:

- `PENDING_PLAN_APPROVAL`
- `PENDING_SHIP`

The relevant work-mode transitions become:

```text
# Ticket work
PLAN_REVIEW -> PENDING_PLAN_APPROVAL -> IMPLEMENT
CODE_REVIEW -> PENDING_SHIP -> FINALIZE
CODE_REVIEW -> REGRESSION_TEST -> IMPLEMENT   # for functional bug findings

# Issue work
REPRODUCE_ISSUE -> PLAN -> PLAN_REVIEW -> PENDING_PLAN_APPROVAL
PENDING_PLAN_APPROVAL -> IMPLEMENT
IMPLEMENT -> TEST -> CODE_REVIEW
CODE_REVIEW -> PENDING_SHIP
CODE_REVIEW -> REGRESSION_TEST -> IMPLEMENT   # for functional bug findings
PENDING_SHIP -> FINALIZE
FINALIZE -> COMPLETE
```

For implementation simplicity, issue work may reuse `currentIssue` while generalizing `PLAN`, `IMPLEMENT`, `TEST`, `CODE_REVIEW`, and `FINALIZE` instructions to support either `ticket` or `currentIssue` as the active work item.

## Command behavior

### `/story start {NS}-T-XXX`

Unchanged from ADR 0002.

### `/story start {NS}-ISS-XXX`

Starts issue work mode and pauses at the plan gate after reproduction tests and plan review.

The start instruction should clearly show:

- issue ID/title/severity;
- reproduction-test requirement;
- where to record failing test command/output;
- the eventual plan path.

### `/story execute`

Works for both ticket and issue work sessions in `PENDING_PLAN_APPROVAL`.

For issues, execute must verify:

- the approved plan references reproduction tests or a no-test rationale;
- reproduction tests fail before implementation when applicable;
- reproduction tests pass after implementation;
- the issue file is updated to `resolved` before `PENDING_SHIP`.

### `/story ship`

Works for both ticket and issue work sessions in `PENDING_SHIP`.

For issues, ship commits code changes plus `.story/issues/{NS}-ISS-XXX.json`.

### Free-form feedback

Free-form feedback behavior from ADR 0002 applies to both tickets and issues:

- At `PENDING_PLAN_APPROVAL`, feedback returns to the appropriate planning loop.
  - Ticket: `PLAN`
  - Issue: `REPRODUCE_ISSUE` if feedback concerns reproduction, otherwise `PLAN`
- At `PENDING_SHIP`, feedback returns to implementation/code-review loop.
  - If feedback describes a functional bug, require `REGRESSION_TEST` before `IMPLEMENT`.
  - Otherwise return to `IMPLEMENT` or `CODE_REVIEW` as appropriate.

## Plan review requirements for issue work

Automated plan review for issue work must check:

- The plan identifies the issue and expected behavior.
- Reproduction tests are present and failing, or a no-test rationale is convincing.
- The plan explains how the fix will make the reproduction tests pass.
- The plan includes verification commands.
- The plan updates the issue record to `resolved` only after the fix is implemented and verified.

A plan review should request changes if reproduction tests are missing without rationale.

## Code review requirements for work mode

Code review output should classify findings with enough structure for the guide to route correctly.

Add or infer a field such as:

```ts
requiresRegressionTest?: boolean
```

Routing rules:

- `requiresRegressionTest: true` -> `REGRESSION_TEST`
- functional bug category without explicit flag -> `REGRESSION_TEST`
- non-functional finding -> existing fix loop
- not testable -> allow direct fix only with recorded rationale

## Consequences

### Positive

- Issue work gets the same human control model as ticket work.
- Issue fixes become test-first by default.
- Code-review-discovered bugs are turned into regression tests before fixes, improving long-term quality.
- The workflow still has only three user commands: start, execute, ship.
- The issue lifecycle becomes safer with explicit claims and cancel cleanup.

### Negative / costs

- Adds two more workflow states.
- Requires generalizing ticket-oriented stages to handle `currentIssue`.
- Requires reviewer output or guide logic to distinguish functional bugs from other findings.
- Some issues will not have practical automated reproduction tests, so the system must support documented exceptions.
- More tests may increase implementation time and token use.

### Risks

- Agents may write brittle reproduction tests. Mitigation: require expected-failure verification and plan-review scrutiny.
- Agents may over-classify style findings as functional bugs. Mitigation: require reviewer classification and allow no-test rationale.
- Issue claim cleanup could overwrite external edits. Mitigation: only restore issues claimed by the same session and still in expected status.
- Work mode could diverge from auto mode behavior. Mitigation: scope this ADR to work mode and preserve existing auto-mode issue flow.

## Implementation plan

1. Add `REPRODUCE_ISSUE` and `REGRESSION_TEST` states and transitions.
2. Extend work-mode `ticketId` input to a more general `targetId` concept, or allow `/story start` routing to pass issue IDs while preserving schema validation.
3. Add issue claim metadata and safe claim/release helpers.
4. Implement `/story start {NS}-ISS-XXX` path: branch guard, clean worktree, pinned branch, issue validation, claim, enter `REPRODUCE_ISSUE`.
5. Implement `REPRODUCE_ISSUE` stage with required failing-test or no-test-rationale reporting.
6. Generalize `PLAN`, `IMPLEMENT`, `TEST`, `CODE_REVIEW`, and `FINALIZE` instructions for `ticket` or `currentIssue` active work.
7. Force code review for issue work mode regardless of existing `ISSUE_FIX.enableCodeReview` defaults.
8. Add `REGRESSION_TEST` routing for code-review findings and ship-gate feedback that describe functional bugs.
9. Ensure `/story execute`, `/story ship`, and `revise` actions work for both tickets and issues.
10. Update cancel handling to restore owned `inprogress` issues to `open` when appropriate.
11. Update skill docs and examples for `/story start {NS}-ISS-XXX`.
12. Add tests for issue start/execute/ship, reproduction-test required behavior, no-test rationale, regression-test routing, issue claim cleanup, branch pinning, and mixed worktree ship prompts.

## Decision outcome

Human-gated work mode will support both tickets and issues. Ticket work keeps the ADR 0002 workflow. Issue work adds a test-first reproduction phase before planning, marks the issue `inprogress` at start, requires code review, resolves the issue before the ship gate, and restores owned in-progress issues on cancel. In work mode, functional bugs found during code review must be captured by failing regression tests before the agent fixes them.
