# Human-Gated Work Mode Implementation Plan

## Summary

Implement ADR 0002 by adding a `work` session mode to the existing autonomous guide. The mode runs one ticket through planning, automated plan review, implementation, tests, and code review, while pausing for human approval before implementation and before commit.

## Key Changes

- Add `PENDING_PLAN_APPROVAL` and `PENDING_SHIP` workflow states.
- Add guide actions `execute`, `ship`, and `revise`.
- Add `mode: "work"` and work-session metadata for branch pinning, tracked changed files, and ship change policy.
- Add protected-branch guards for `/story auto` and `/story start`.
- Enforce clean worktree and pinned branch checks for work sessions.
- Route approved plan review to `PENDING_PLAN_APPROVAL` and approved code review to `PENDING_SHIP` in work mode.
- Detect extra worktree changes at ship time and require an explicit all-changes or session-only decision.
- Update MCP schemas and skill docs to use namespaced ticket and issue IDs.

## Test Plan

- Add focused integration coverage for work-mode start, plan gate, execute, ship gate, revision, branch pinning, protected branch blocking, dirty worktree blocking, and guide schema ID validation.
- Update state registry and orphan-start regression tests for new transient states and protected-branch behavior.
- Run `npm run build`.
- Run the focused work-mode and skill tests.
- Run the full `npm test` suite.

## Assumptions

- Work mode is ticket-only for this implementation.
- Protected branches use the existing exact-match superset: `main`, `master`, `develop`, `dev`, `staging`, and `production`.
- `/story` command routing lives in the skill/MCP layer; no new standalone CLI subcommand is required.
