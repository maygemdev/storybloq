# ADR 0002: Human-Gated Work Mode

- **Status:** Proposed
- **Date:** 2026-05-26
- **Owner:** Storybloq maintainers
- **Related areas:** `src/autonomous/guide.ts`, `src/autonomous/session-types.ts`, `src/autonomous/branch-affinity.ts`, `src/skill/SKILL.md`, `src/skill/autonomous-mode.md`, `src/mcp/tools.ts`

## Context

Storybloq's autonomous mode (`/story auto`) runs the full ticket pipeline — plan, review, implement, test, code review, finalize, commit — without human intervention. This is powerful for trusted repositories and experienced users, but many teams want the agent to do the cognitive work while keeping humans in control of two critical decisions:

1. **Is this plan correct before we spend tokens implementing it?**
2. **Is this code ready to commit?**

The existing tiered modes (`/story plan`, `/story review`) address fragments of this but do not provide an end-to-end single-ticket workflow with structured human gates. Users who want "agent does the work, I own the decisions" must manually chain plan → review → implement steps, losing the benefits of the autonomous state machine.

## Decision

Introduce a **human-gated work mode** with three commands that map to three phases of a single-ticket workflow:

| Command | What it does | Ends at |
|---|---|---|
| `/story start {NS}-T-XXX` | Plan the ticket, run automated plan review | **Plan gate**: pauses for human approval |
| `/story execute` | Implement, test, code review with fix rounds | **Ship gate**: pauses for human approval |
| `/story ship` | Finalize, commit, mark complete | Session ends |

(Where `{NS}` is the project's ticket namespace, e.g. `DEV01-T-012`.)

At both gates, the human can provide **free-form conversational feedback** instead of approving. The agent re-enters the appropriate loop (plan revision or implementation/review revision), then pauses at the same gate again.

## Goals

- Provide an end-to-end single-ticket workflow where the agent handles planning, implementation, and self-review autonomously, but humans gate the plan-to-implementation and code-to-commit transitions.
- Keep the existing `/story auto` mode unchanged for fully autonomous use cases.
- Reuse the existing autonomous guide state machine, adding new pause states rather than building a parallel system.
- Support free-form human feedback at both gates so the human can iterate without cancelling and restarting.
- Enforce branch safety: work mode and auto mode must not run on protected branches.

## Non-goals

- Multi-ticket work sessions. This mode is explicitly one ticket at a time per worktree/branch.
- Replacing `/story auto` for users who want fully autonomous execution.
- Background or parallel execution. Work mode is foreground and interactive by design.
- Replacing `/story plan` or `/story review` as standalone tools.

## Design

### State machine

The work mode reuses the autonomous guide's state machine with two new pause states:

```text
/story start {NS}-T-XXX
    │
    ├── branch guard (fail on main/master/dev/develop)
    ├── clean worktree check (fail if dirty)
    ├── pin session to current branch
    │
    ▼
  PLAN
    │
    ▼
  PLAN_REVIEW (automated)
    │
    ▼
  PENDING_PLAN_APPROVAL  ◄──── human gate
    │
    ├── human provides feedback → re-enter PLAN → PLAN_REVIEW → pause here again
    │
    ▼  (human runs /story execute)

  IMPLEMENT
    │
    ▼
  TEST
    │
    ▼
  CODE_REVIEW
    │
    ├── review requests fixes → agent fixes → re-review loop
    │
    ▼
  PENDING_SHIP  ◄──── human gate
    │
    ├── human provides feedback → re-enter IMPLEMENT/CODE_REVIEW → pause here again
    │
    ▼  (human runs /story ship)

  FINALIZE
    │
    ▼
  COMMIT
    │
    ▼
  COMPLETE → session ends
```

### New session states

Two new states added to the session state enum:

- **`PENDING_PLAN_APPROVAL`** — plan and automated plan review are complete. The agent has produced a plan file and the automated review has approved it. Session is paused waiting for the human to approve (via `/story execute`) or provide revision feedback.

- **`PENDING_SHIP`** — implementation, tests, and code review (including any fix rounds) are complete. The agent's self-review has approved the code. Session is paused waiting for the human to approve (via `/story ship`) or provide revision feedback.

### New guide mode and actions

**Mode:** `"work"` — passed to `storybloq_autonomous_guide` on `action: "start"`.

**New actions:**

| Action | Called when | Transitions from | Transitions to |
|---|---|---|---|
| `"execute"` | Human approves plan (`/story execute`) | `PENDING_PLAN_APPROVAL` | `IMPLEMENT` |
| `"ship"` | Human approves code (`/story ship`) | `PENDING_SHIP` | `FINALIZE` |
| `"revise"` | Human provides feedback at either gate | `PENDING_PLAN_APPROVAL` or `PENDING_SHIP` | `PLAN` or `IMPLEMENT` respectively |

The `"revise"` action accepts a `feedback` string parameter containing the human's free-form input.

### Commands

**`/story start {NS}-T-XXX`** (e.g. `/story start DEV01-T-012`)

1. Run branch guard: fail if current branch is exactly `main`, `master`, `dev`, or `develop`.
2. Require clean worktree: fail if `git status --porcelain` is non-empty.
3. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "work", "ticketId": "{NS}-T-XXX" }`.
4. The guide creates a session pinned to the current branch.
5. Agent executes PLAN → PLAN_REVIEW autonomously.
6. Guide transitions to `PENDING_PLAN_APPROVAL` and returns a pause instruction.
7. Agent surfaces the plan summary and prompts the human.

**`/story execute`**

1. Verify an active work session exists in `PENDING_PLAN_APPROVAL` state.
2. Verify current branch matches the session's pinned branch.
3. Call `storybloq_autonomous_guide` with `{ "sessionId": "<id>", "action": "execute" }`.
4. Agent executes IMPLEMENT → TEST → CODE_REVIEW autonomously (including fix rounds).
5. Guide transitions to `PENDING_SHIP` and returns a pause instruction.
6. Agent surfaces the diff summary, review results, and prompts the human.

**`/story ship`**

1. Verify an active work session exists in `PENDING_SHIP` state.
2. Verify current branch matches the session's pinned branch.
3. Check worktree for unexpected changes (changes not attributable to the session):
   - If only session changes exist: proceed normally.
   - If extra changes are detected: **pause and ask the user** whether to include all changes or only session changes in the commit. Do not proceed until the user answers.
4. Call `storybloq_autonomous_guide` with `{ "sessionId": "<id>", "action": "ship" }`.
5. Agent executes FINALIZE → COMMIT → COMPLETE.
6. Session ends. Commit is automatic once the human has approved.

**Free-form feedback (at either gate)**

When the session is in `PENDING_PLAN_APPROVAL` or `PENDING_SHIP`, the human can type feedback directly in conversation instead of running a command. The agent:

1. Calls `storybloq_autonomous_guide` with `{ "sessionId": "<id>", "action": "revise", "feedback": "<user's message>" }`.
2. The guide transitions back to the appropriate work phase (`PLAN` for plan gate, `IMPLEMENT` for ship gate).
3. The agent re-executes the loop incorporating the feedback.
4. The session re-pauses at the same gate.

### Branch guard

Applies to both `/story auto` and `/story start`:

**Protected branches (exact match only):**
- `main`
- `master`
- `dev`
- `develop`

If the current branch matches any of these exactly, the command fails immediately with:

```text
Cannot start a work session on protected branch '{branch}'.
Switch to a feature branch first.
```

No prefix matching, no glob matching. `main/feature-x` or `develop-2` are not blocked.

**Additional constraint for `/story auto`:** The existing `branchStrategy: "per-ticket"` auto-creation is overridden by the protected branch guard. Even if per-ticket branching is configured, `/story auto` will not create branches from a protected branch. The user must be on a non-protected branch before starting.

### Branch pinning (work mode only)

When `/story start` creates a session, the session records the current branch name. Subsequent `/story execute`, `/story ship`, and revision actions verify the current branch matches. If the user has switched branches, the command fails:

```text
This work session is pinned to branch '{pinned}'.
You are currently on '{current}'. Switch back to continue.
```

### Worktree change detection at ship time

When the user runs `/story ship`, the agent checks whether the worktree contains changes beyond what the session produced. This can occur if the user manually edited files during the session or if other tooling modified the tree.

**Detection approach:** Compare the current diff against the session's tracked file list (files the agent created or modified during IMPLEMENT/TEST/CODE_REVIEW stages, recorded in the session event log).

If extra changes are detected, the agent pauses and asks:

```text
The worktree contains changes not produced by this session:
  - path/to/manually-edited-file.ts
  - path/to/other-file.ts

Include all changes in the commit, or only session changes?
  1. All changes
  2. Session changes only
```

The user's choice determines what gets staged for the commit. This is the only interactive prompt during `/story ship`.

### Active session guard integration

The SKILL.md Step 0.5 active session guard surfaces work-mode sessions with state-specific banners:

**Plan gate:**

```text
## Work Session — Awaiting Plan Approval
Session: <T>  |  Ticket: DEV01-T-012  |  Branch: feature/xxx
Plan ready for review. Run /story execute to approve, or provide feedback to revise.
```

**Ship gate:**

```text
## Work Session — Ready to Ship
Session: <T>  |  Ticket: DEV01-T-012  |  Branch: feature/xxx
Code reviewed and approved. Run /story ship to commit, or provide feedback to revise.
```

**In-progress (plan or implementation phase):**

```text
## Work Session — In Progress
Session: <T>  |  Ticket: DEV01-T-012  |  Branch: feature/xxx  |  Stage: IMPLEMENT
```

### Relationship to existing modes

| Concern | `/story auto` | `/story start/execute/ship` | `/story plan` | `/story review` |
|---|---|---|---|---|
| Ticket count | Multiple | One | One | One |
| Human gates | None | Plan + ship | None | None |
| Auto-commit | Yes | Yes (after `/story ship`) | No | No |
| Branch guard | Yes (new) | Yes | No | No |
| Clean worktree | Yes | Yes | No (plan only) | No (review existing) |
| Session type | `auto` | `work` | `plan` | `review` |

## Implementation plan

### Phase 1: Session state and guide changes

- Add `PENDING_PLAN_APPROVAL` and `PENDING_SHIP` to the session state enum in `src/autonomous/session-types.ts`.
- Add `"work"` to the guide's accepted `mode` values.
- Add `"execute"`, `"ship"`, and `"revise"` to the guide's accepted `action` values.
- Add `feedback` as an optional string parameter on the guide tool schema.
- Add `pinnedBranch` to session metadata.
- Implement guide handler logic: `work` mode enters PLAN, pauses at `PENDING_PLAN_APPROVAL`; `execute` action resumes to IMPLEMENT, pauses at `PENDING_SHIP`; `ship` action resumes to FINALIZE; `revise` action re-enters the appropriate loop.

### Phase 2: Branch guard

- Reuse the existing `PROTECTED_BRANCHES` set from `src/autonomous/branch-affinity.ts` (`main`, `master`, `develop`, `dev`, `staging`, `production`) — exact match only.
- Implement protected branch check as a shared utility usable by both `auto` and `work` mode start handlers.
- Add the guard to the `auto` mode start path (currently missing).
- Add the guard to the `work` mode start path.
- Override `branchStrategy: "per-ticket"` when on a protected branch.

### Phase 3: Branch pinning and worktree checks

- Record `pinnedBranch` in session metadata at work-mode session creation.
- Validate current branch matches `pinnedBranch` on `execute`, `ship`, and `revise` actions.
- Implement worktree change detection at ship time: compare current diff file list against session event log's tracked files.
- Implement the interactive prompt for mixed changes.

### Phase 4: Skill file updates

- Add `/story start {NS}-T-XXX`, `/story execute`, `/story ship` command routing to SKILL.md.
- Add work-mode documentation to `autonomous-mode.md`.
- Define the three banner formats for the active session guard.
- Document free-form feedback behavior at gates.
- Document branch guard behavior for both `/story auto` and `/story start`.

### Phase 5: Clean worktree enforcement

- Add `git status --porcelain` check to the `work` mode start path.
- Fail with a clear message if the worktree is dirty.
- Verify the same check exists for `/story auto` start (it should already exist; confirm and align).

### Phase 6: Namespace consistency fixes

- Update all six `"T-XXX"` / `"ISS-XXX"` placeholder strings in `src/autonomous/guide.ts` to `"{NS}-T-XXX"` / `"{NS}-ISS-XXX"` (or realistic examples).
- Add `.regex(TICKET_ID_REGEX)` to the `ticketId` parameter in the `storybloq_autonomous_guide` tool schema (`src/mcp/tools.ts`).
- Add `.regex(TICKET_ID_REGEX)` to the `report.ticketId` field in the same schema.
- Update the `targetWork` description string to use namespaced format.
- Update all command examples in `src/skill/SKILL.md` and `src/skill/autonomous-mode.md` to use namespaced IDs.
- Verify the `dist/skill/` copies are rebuilt and consistent after source changes.

### Phase 7: Testing

- Unit tests for new session states and transitions.
- Unit tests for branch guard (exact match, non-match edge cases including `staging`, `production`).
- Unit tests for branch pinning validation.
- Integration tests for the full start → execute → ship flow.
- Integration tests for revision feedback loops at both gates.
- Integration tests for worktree change detection and the interactive prompt.
- Unit tests verifying `ticketId` schema rejects old-format IDs (`T-001`, `ISS-001`).
- Manual test cases added to `MANUAL_TEST_PLAN.md`.

## Consequences

### Positive

- Users get an end-to-end agent workflow with human ownership of plan and ship decisions.
- The three-command model is simple to learn and maps to natural project workflow: start work, approve plan, ship code.
- Free-form feedback at gates provides iterative collaboration without restarting sessions.
- Branch guard prevents accidental autonomous commits to protected branches (benefits both `/story auto` and `/story start`).
- Reuses the existing autonomous guide state machine rather than building a parallel system.

### Negative / costs

- Two new session states and three new guide actions increase state machine complexity.
- Branch guard on `/story auto` is a behavior change for users who currently start auto mode from `main` with `branchStrategy: "per-ticket"`, or from `staging`/`production`.
- Worktree change detection at ship time requires tracking which files the session modified, adding bookkeeping to the event log.
- Free-form feedback routing (distinguishing "the user is giving revision feedback" from "the user is asking an unrelated question") requires skill-level routing logic.

### Risks

- Human gates may cause sessions to be abandoned in `PENDING_PLAN_APPROVAL` or `PENDING_SHIP` state if users forget to continue. Mitigation: surface pending sessions clearly in the active session guard and `/story` status output.
- Branch guard on protected branches may surprise users who have existing workflows starting from `main`, `staging`, or `production`. Mitigation: clear error message with suggested alternatives.
- Adding `TICKET_ID_REGEX` validation to the `ticketId` schema parameter is a minor breaking change for any external tooling that passes old-format IDs. Mitigation: the `migrate-namespace` CLI command already exists for projects that haven't migrated.
- Worktree change detection may produce false positives if external tooling modifies files that happen to be in the session's tracked set. Mitigation: the interactive prompt lets the user decide rather than making assumptions.

## Namespace consistency fixes

Storybloq uses namespaced ticket IDs (`{NS}-T-NNN`, e.g. `DEV01-T-012`) and issue IDs (`{NS}-ISS-NNN`, e.g. `DEV01-ISS-009`). The core validation regexes (`TICKET_ID_REGEX`, `ISSUE_ID_REGEX`, `TARGET_WORK_ID_REGEX`) and branch affinity detection all correctly require the namespace prefix. However, several agent-facing surfaces still use the old un-namespaced format (`T-XXX`, `ISS-XXX`) as placeholders. Since agents read these messages and examples as instructions, old-format placeholders risk hallucinated IDs that then fail validation — producing a confusing error loop.

The following fixes must be included in the implementation to prevent agent confusion in both the new work mode and the existing autonomous/tiered modes.

### Fix 1: Guide error message placeholders (`guide.ts`)

Six locations in `src/autonomous/guide.ts` emit `"T-XXX"` or `"ISS-XXX"` as placeholders in error messages and instruction JSON templates:

| Line | Current | Fix |
|---|---|---|
| ~694 | `'Mode requires a ticketId. Call with: { "ticketId": "T-XXX" }'` | Change to `"{NS}-T-XXX"` or a realistic example like `"DEV01-T-001"` |
| ~733 | `'Invalid target IDs. Use T-XXX for tickets or ISS-XXX for issues.'` | Change to `"{NS}-T-XXX"` / `"{NS}-ISS-XXX"` |
| ~1322 | Fallback `"ticketId": "T-XXX"` in PICK_TICKET instruction JSON | Change to `"{NS}-T-XXX"` |
| ~1779 | Same fallback in drift-resume PICK_TICKET path | Change to `"{NS}-T-XXX"` |
| ~1940 | Same fallback in clean-resume PICK_TICKET path | Change to `"{NS}-T-XXX"` |
| ~2126 | Same fallback in cancel-recovery path | Change to `"{NS}-T-XXX"` |

These are the messages agents see when the guide cannot pre-fill a real ticket ID. An agent that copies `"T-XXX"` literally will be rejected by `TICKET_ID_REGEX` (`/^[A-Z0-9]{3,12}-T-\d+[a-z]?$/`), and the resulting error message will again say `"T-XXX"`, creating a loop.

### Fix 2: Schema-level `ticketId` validation (`tools.ts`)

The `storybloq_autonomous_guide` tool schema defines `ticketId` as an unconstrained string:

```ts
// src/mcp/tools.ts:1012
ticketId: z.string().optional()
```

Contrast with `targetWork`, which validates against `TARGET_WORK_ID_REGEX`:

```ts
// src/mcp/tools.ts:1013
targetWork: z.array(z.string().regex(TARGET_WORK_ID_REGEX)).max(150).optional()
```

**Fix:** Add `.regex(TICKET_ID_REGEX)` to the `ticketId` parameter so that old-format or malformed IDs are rejected at the schema boundary with a clear format error instead of a confusing "Ticket not found" from the lookup.

The same applies to the `report.ticketId` field (`tools.ts:1016`), which should also validate against `TICKET_ID_REGEX`.

### Fix 3: `targetWork` description text (`tools.ts`)

The `targetWork` parameter's description string says:

```
"For start action only: array of T-XXX and ISS-XXX IDs to work on in order."
```

**Fix:** Change to `"{NS}-T-XXX and {NS}-ISS-XXX"` or use realistic examples like `"DEV01-T-001, DEV01-ISS-009"`.

### Fix 4: Skill file and `autonomous-mode.md` examples

Throughout `src/skill/SKILL.md` and `src/skill/autonomous-mode.md`, command examples use old-format IDs:

```text
/story auto T-183 T-184 ISS-077
/story review T-XXX
/story plan T-XXX
```

**Fix:** Update all examples to namespaced format:

```text
/story auto DEV01-T-183 DEV01-T-184 DEV01-ISS-077
/story review {NS}-T-XXX
/story plan {NS}-T-XXX
```

Use `{NS}-T-XXX` as a generic placeholder and concrete examples like `DEV01-T-012` where a realistic ID helps readability. These are agent-facing instructions — the agent reads them to learn how to format IDs.

### Fix 5: Align protected branch sets

The existing `PROTECTED_BRANCHES` set in `src/autonomous/branch-affinity.ts` is:

```ts
["main", "master", "develop", "dev", "staging", "production"]
```

This ADR's branch guard specifies `["main", "master", "dev", "develop"]`.

**Decision:** Use the existing superset. The branch guard for both `/story auto` and `/story start` will block `main`, `master`, `dev`, `develop`, `staging`, and `production`. There is no reason to allow autonomous or work-mode sessions on `staging` or `production` branches. The implementation should reuse the existing `PROTECTED_BRANCHES` constant from `branch-affinity.ts` rather than defining a separate list.

## Open questions

None.

## Decision outcome

Introduce `/story start {NS}-T-XXX`, `/story execute`, and `/story ship` as a human-gated single-ticket work mode. Add `PENDING_PLAN_APPROVAL` and `PENDING_SHIP` session states to the autonomous guide. Add a protected branch guard (reusing the existing `PROTECTED_BRANCHES` set: `main`, `master`, `dev`, `develop`, `staging`, `production`) to both `/story auto` and `/story start`. Enforce clean worktree and branch pinning for work-mode sessions. Detect unexpected worktree changes at ship time and prompt the user for inclusion decisions. Fix all agent-facing ID placeholders and examples to use the namespaced format (`{NS}-T-XXX`, `{NS}-ISS-XXX`) and add schema-level `TICKET_ID_REGEX` validation to the guide's `ticketId` parameters.
