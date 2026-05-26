# ADR 0004: Finalize Namespace Support

- **Status:** Proposed
- **Date:** 2026-05-26
- **Owner:** Storybloq maintainers
- **Related areas:** `src/models/types.ts`, `src/models/local-config.ts`, `src/core/id-allocation.ts`, `src/core/project-state.ts`, `src/core/queries.ts`, `src/core/recommend.ts`, `src/core/validation.ts`, `src/core/session-scan.ts`, `src/autonomous/guide.ts`, `src/autonomous/session-types.ts`, `src/autonomous/branch-affinity.ts`, `src/cli/commands/namespace.ts`, `src/cli/commands/ticket.ts`, `src/cli/commands/issue.ts`, `src/cli/commands/status.ts`, `src/cli/commands/recommend.ts`, `src/mcp/tools.ts`, `src/tools/`, `src/skill/`, `README.md`

## Context

Storybloq now uses namespaced ticket and issue IDs:

```text
{NS}-T-NNN
{NS}-ISS-NNN
```

Examples:

```text
DEV01-T-001
DEV01-ISS-001
```

The current implementation has the foundation in place:

- `TICKET_ID_REGEX`, `ISSUE_ID_REGEX`, and `TARGET_WORK_ID_REGEX` require namespace-prefixed IDs.
- `extractNamespace(id)` can derive the namespace from a ticket or issue ID.
- `.story/.local.json` stores the current clone's namespace and is gitignored.
- `storybloq namespace set|get` and MCP namespace tools exist.
- ticket and issue creation allocate IDs inside the configured namespace.
- `migrate-namespace` converts legacy `T-NNN` / `ISS-NNN` records to `{NS}-...`.
- branch affinity recognizes Storybloq IDs embedded in branch names.

However, namespace support is not finished. Namespace currently behaves mostly as an **ID allocation prefix**, not as an active work scope. Read commands, recommendations, status, handovers, active session summaries, autonomous selection, documentation, and branch/local-config consistency are not all namespace-aware.

This creates two classes of problems:

1. **Context contamination:** a user working in namespace `AAA111` can see or pick work from namespace `BBB222` unless they explicitly use targeted mode.
2. **Workflow confusion:** a clone can have `.story/.local.json` set to one namespace while the current branch or selected target clearly belongs to another namespace.

## Decision

Storybloq will finish namespace support by promoting namespace from an ID prefix to an **active logical scope** for ticket and issue work.

The active namespace remains stored in `.story/.local.json`, which is local to a checkout/worktree and gitignored. When an active namespace is configured, user-facing work-item reads and autonomous selection default to that namespace. Cross-namespace visibility remains available through explicit flags/options, but default workflows should keep users in their current namespace.

Namespaces are still represented in the ID itself. Storybloq will keep the flat file layout:

```text
.story/tickets/{NS}-T-NNN.json
.story/issues/{NS}-ISS-NNN.json
```

No physical `.story/namespaces/{NS}/...` directory hierarchy is introduced in this ADR.

## Goals

- Make namespace an explicit active scope for ticket and issue workflows.
- Prevent accidental work on tickets/issues from another namespace.
- Preserve merge-friendly per-record files.
- Keep `.story/.local.json` local and gitignored.
- Keep existing namespaced ID formats and migration path.
- Make CLI, MCP, Pi/shared tool definitions, skill text, and README consistent.
- Support cross-namespace references when intentional, while surfacing them clearly.
- Keep global project artifacts such as config, roadmap, and lessons usable across namespaces.

## Non-goals

- External tracker-specific import, parsing, or synchronization.
- Changing the namespace regex or allowing arbitrary external key syntax.
- Supporting concurrent autonomous sessions inside the same physical working tree.
- Moving tickets/issues into per-namespace directories.
- Making roadmap phases namespace-specific in this ADR.
- Federated cross-repo namespace semantics beyond preserving existing cross-node behavior.

## Namespace model

### Namespace format

Keep the current namespace format:

```text
^[A-Z0-9]{3,12}$
```

A namespace is a short uppercase alphanumeric token. Any external system that wants to derive a namespace from another identifier must normalize into this format before calling Storybloq.

### Active namespace

The active namespace is stored in:

```text
.story/.local.json
```

Example:

```json
{
  "namespace": "DEV01"
}
```

`.story/.local.json` remains gitignored and must never be required in committed project state.

### Entity namespace

The namespace of a ticket or issue is derived from its ID:

```ts
extractNamespace("DEV01-T-012") === "DEV01"
extractNamespace("DEV01-ISS-009") === "DEV01"
```

Ticket/issue JSON files do not need a duplicated `namespace` field. The ID is canonical.

### Global artifacts

These remain global unless explicitly extended later:

- `.story/config.json`
- `.story/roadmap.json`
- lessons
- blockers
- snapshots

Notes and handovers need namespace-aware handling because they are user/session context surfaces. See [Namespace-aware handovers and notes](#namespace-aware-handovers-and-notes).

## Current gaps

### 1. Read paths are not namespace-scoped

`loadProject` loads all records, and status/recommend/list/next/blocked operate on the full project state. This is correct for the storage layer but wrong for default user workflows once multiple namespaces coexist.

### 2. Autonomous picking can cross namespaces

Standard `/story auto` uses recommendations/pick logic over the full project state. If namespace `AAA111` and `BBB222` both have open tickets, an agent in `AAA111` can pick `BBB222-T-001` unless targeted mode is used or branch affinity happens to block it.

### 3. Branch/local namespace mismatch is not checked

Branch affinity detects `{NS}-T-NNN` and `{NS}-ISS-NNN` in branch names, but Storybloq does not consistently compare that namespace with `.story/.local.json`.

Example problematic state:

```text
current branch: story/DEV01-T-012-add-search
.story/.local.json: { "namespace": "QA999" }
```

New tickets created in that state become `QA999-T-...`, even though the branch clearly belongs to `DEV01`.

### 4. Session state does not record namespace as first-class metadata

Sessions record ticket/issue IDs, branch, and workspace ID, but no explicit `namespace`. This makes status displays, recovery prompts, and future namespace-aware session behavior harder.

### 5. Handovers and context loading are global

The skill loads recent handovers globally. With multiple namespaces, recent handovers from unrelated work can pollute the current session's context.

### 6. Documentation and examples are inconsistent

Some README and skill-facing examples still use legacy IDs such as `T-001`, while current schemas require `{NS}-T-001`. This can teach agents and users the wrong format.

### 7. Namespace tool surface is incomplete

`namespace set|get` exists, but there is no first-class namespace summary/list command and no standard options such as `--namespace` / `--all-namespaces` across read commands.

## Detailed design

### 1. Add a shared namespace scope abstraction

Introduce a shared internal type, conceptually:

```ts
interface NamespaceScope {
  readonly namespace: string | null;
  readonly mode: "active" | "explicit" | "all";
}
```

Resolution rules:

1. If a command/tool receives an explicit namespace, use it after validating `NAMESPACE_REGEX`.
2. If `--all-namespaces` / equivalent is provided, use `mode: "all"`.
3. Otherwise, try `.story/.local.json`.
4. If no active namespace exists:
   - write/create commands that allocate ticket/issue IDs fail with the existing namespace-required error;
   - read commands either show all namespaces with a warning or prompt/setup guidance, depending on command context.

The storage layer should continue loading all data. Namespace scope should be applied in query/recommend/status layers, not by hiding records from `loadProject`. This preserves validation and cross-reference integrity.

### 2. Namespace-aware CLI behavior

Add consistent flags to ticket/issue read commands:

```text
--namespace <NS>       Show work from a specific namespace
--all-namespaces       Show work from every namespace
```

Apply to at least:

```text
storybloq status
storybloq recommend
storybloq ticket list
storybloq ticket next
storybloq ticket blocked
storybloq issue list
storybloq export
```

Default behavior when an active namespace exists:

- ticket/issue lists show only that namespace;
- status shows active namespace work counts prominently;
- recommend only recommends active namespace work;
- `ticket next` only considers active namespace tickets;
- open issues in other namespaces are not shown as current blockers unless explicitly requested.

`--all-namespaces` restores the current global behavior.

### 3. Namespace-aware MCP and Pi/shared tools

Expose the same scoping controls in tool schemas where applicable:

```ts
namespace?: string
allNamespaces?: boolean
```

This should be implemented in the shared tool-definition layer so MCP and Pi stay in sync.

Namespace read tools should include the active namespace in their text output where useful, for example:

```text
Active namespace: DEV01
```

### 4. Namespace-aware recommendations

`recommend` should accept namespace scope.

Default recommendation behavior:

- include validation-action recommendations if the whole project has serious validation errors;
- include tickets/issues from the active namespace;
- exclude tickets/issues from other namespaces;
- treat cross-namespace blockers as blockers if referenced by active-namespace tickets;
- surface cross-namespace blockers as rationale, not as work to pick by default.

Example:

```text
DEV01-T-004 is blocked by QA999-T-002 (foreign namespace)
```

A future enhancement can recommend cross-namespace coordination actions, but this ADR only requires avoiding accidental cross-namespace picks.

### 5. Namespace-aware autonomous mode

Each autonomous/work/review/plan session should record:

```ts
namespace: string | null
```

Session namespace resolution:

1. If `ticketId`, `issueId`, or `targetWork` is provided, derive namespace from the target IDs.
2. If no target is provided, use active namespace from `.story/.local.json`.
3. If neither exists, fail before creating a session with a clear message to run `storybloq namespace set <NS>` or use targeted mode with a namespaced ID.

Rules:

- Standard `/story auto` uses namespace-scoped recommendations/picking.
- `/story start {NS}-T-XXX`, `/story start {NS}-ISS-XXX`, `/story plan {NS}-T-XXX`, and `/story review {NS}-T-XXX` set session namespace from the target ID.
- `targetWork` should be single-namespace by default. Mixed namespaces should be rejected unless an explicit future option allows mixed-namespace sessions.
- If active namespace exists and conflicts with the explicit target namespace, targeted commands may proceed but must warn and should offer/update guidance. Work creation must not allocate new tickets/issues under the wrong namespace.
- Session status displays include namespace.

### 6. Branch and namespace consistency guard

Extend branch affinity into a namespace consistency guard.

If the current branch contains exactly one Storybloq entity ID:

```text
story/DEV01-T-012-add-search
```

then Storybloq derives:

```text
branch namespace = DEV01
branch entity = DEV01-T-012
```

Behavior:

- If active namespace is missing, commands may suggest setting it to the branch namespace.
- If active namespace differs, write commands and autonomous session starts should block with a clear remediation message.
- Targeted work whose target namespace matches the branch namespace may proceed even if `.local.json` is stale, but should tell the user to update `.local.json`.
- If a branch contains multiple Storybloq IDs from different namespaces, treat the namespace as ambiguous and do not infer. Show a warning instead.

This guard should apply to:

- ticket/issue creation;
- `/story auto` start;
- `/story start` work mode;
- namespace-sensitive write tools.

### 7. Namespace-aware handovers and notes

Handovers should become namespace-tagged without breaking existing files.

Add a lightweight metadata convention for new handovers, for example HTML comments at the top of the file:

```md
<!-- storybloq: namespace=DEV01 -->

# Handover
...
```

Rules:

- session-generated handovers include the session namespace;
- manual `handover create` uses active namespace unless `--all-namespaces` or `--namespace` semantics say otherwise;
- `handover latest` defaults to active namespace handovers plus global/unlabeled handovers only when there are no namespace-specific handovers;
- `handover latest --all-namespaces` returns global behavior;
- legacy unlabeled handovers remain readable and are treated as global.

Notes should get an optional namespace field or passthrough metadata:

```json
{
  "id": "N-001",
  "namespace": "DEV01",
  ...
}
```

Default note listing should include active-namespace notes and global notes. Lessons remain global.

### 8. Namespace commands

Extend namespace management:

```text
storybloq namespace get
storybloq namespace set <NS>
storybloq namespace list
storybloq namespace check
storybloq namespace clear
```

Semantics:

- `list` scans ticket and issue IDs and reports namespaces, counts, in-progress counts, open issues, and latest handover if available.
- `check` verifies `.local.json`, current branch affinity, and active namespace consistency.
- `clear` removes `.story/.local.json` after confirmation or `--force`.

MCP/Pi parity should expose equivalent read/write tools where useful:

```text
storybloq_namespace_get
storybloq_namespace_set
storybloq_namespace_list
storybloq_namespace_check
storybloq_namespace_clear
```

### 9. Validation additions

`storybloq validate` should add namespace-specific findings:

- invalid namespace prefix in any ticket/issue ID is already schema-level;
- warn when a namespace has in-progress work in multiple branches/sessions if detectable;
- warn on cross-namespace `blockedBy`, `parentTicket`, or `relatedTickets` references unless explicitly marked as intentional;
- error on mixed-namespace parent/child relationships by default, because umbrella hierarchies are expected to be namespace-local;
- allow cross-namespace `blockedBy` as a warning, not an error;
- allow cross-namespace `relatedTickets` as a warning, not an error.

### 10. Documentation and skill cleanup

Update all user- and agent-facing docs to use namespaced IDs:

- README bootstrap flow must include `storybloq namespace set <NS>` before creating tickets/issues.
- README CLI examples should use `DEV01-T-001` / `DEV01-ISS-001` or `{NS}-...` placeholders.
- Skill files should consistently use `{NS}-T-XXX` and `{NS}-ISS-XXX`.
- Autonomous guide fallback examples must not emit `T-XXX` or `ISS-XXX`.
- `src/autonomous/target-work.ts` fallback examples should use namespaced placeholders.
- Command errors should explain how to inspect/set namespace.

## Implementation plan

### Phase 1: Scope primitives and docs consistency

1. Add namespace scope resolution helpers.
2. Add namespace extraction helpers for target arrays and branches.
3. Update README, skill docs, and guide fallback examples to namespaced placeholders.
4. Add tests for namespace scope resolution and branch namespace extraction.

### Phase 2: CLI and tool scoping

1. Add `--namespace` / `--all-namespaces` to read commands.
2. Update MCP/Pi shared tool schemas with `namespace` / `allNamespaces` options.
3. Update status, recommend, ticket list/next/blocked, issue list, and export behavior.
4. Add namespace list/check/clear commands and tools.

### Phase 3: Autonomous/session integration

1. Add `namespace` to session schema with backward-compatible default `null`.
2. Resolve and persist session namespace on start/resume paths.
3. Scope standard auto recommendations/picking to session namespace.
4. Reject mixed-namespace `targetWork` by default.
5. Add branch/local namespace guard before session creation and ticket/issue creation.
6. Update active session/status rendering to include namespace.

### Phase 4: Handovers and notes

1. Add handover namespace metadata parsing.
2. Tag new session handovers with namespace.
3. Add namespace filters to handover list/latest/export flows.
4. Add optional namespace to notes and update note list behavior.

### Phase 5: Validation and regression tests

1. Add namespace validation findings.
2. Add tests for scoped recommendations, status output, branch mismatch blocks, handover filtering, note filtering, and autonomous pick containment.
3. Add CLI/MCP/Pi parity tests for namespace tools and schema options.
4. Add migration/backward-compat tests for existing projects with namespaced IDs but no `.local.json`.

## Compatibility and migration

Existing projects that already migrated to namespaced IDs continue to load.

If `.story/.local.json` is missing:

- existing read commands should still be usable;
- write commands that allocate ticket/issue IDs continue to require namespace;
- `/story` should explain how to set a namespace;
- targeted `/story auto {NS}-T-001` can infer the session namespace from the target.

Legacy handovers without namespace metadata remain global. Legacy notes without namespace remain global.

No file relocation is required.

## Risks and mitigations

### Risk: users lose visibility into other namespaces

Mitigation: every scoped command should support `--all-namespaces`, and status should mention when other namespaces exist.

### Risk: validation becomes too noisy

Mitigation: cross-namespace blockers and related tickets should be warnings, not errors. Only mixed-namespace parent/child hierarchies should be errors by default.

### Risk: active namespace stale after branch switch

Mitigation: namespace check runs before namespace-sensitive writes and autonomous starts. Branch-derived namespace mismatch blocks unsafe operations.

### Risk: agent confusion from old examples

Mitigation: update README, skill files, MCP descriptions, and guide fallback examples in the same implementation slice.

## Test plan

- Unit tests for `extractNamespace`, namespace scope resolution, and branch namespace extraction.
- Unit tests for `nextTicketID` / `nextIssueID` ignoring other namespaces.
- CLI tests for `namespace set|get|list|check|clear`.
- CLI tests for `ticket list`, `issue list`, `status`, `recommend`, `ticket next`, and `ticket blocked` with active namespace, explicit namespace, and all namespaces.
- Autonomous tests ensuring `/story auto` only picks active namespace work.
- Autonomous tests rejecting mixed-namespace `targetWork`.
- Branch guard tests for matching, stale, missing, and ambiguous namespace states.
- Handover parser tests for namespace-tagged and legacy handovers.
- Tool parity tests ensuring MCP and Pi expose the same namespace-related controls.

## Open questions

1. Should `storybloq namespace set <NS>` optionally validate that the current branch contains the same namespace and warn otherwise?
2. Should `status` default to active namespace only, or active namespace plus a compact cross-namespace summary? This ADR recommends active namespace plus a short “other namespaces exist” line.
3. Should notes be namespace-scoped in the core schema or only via passthrough metadata initially?
4. Should mixed-namespace targeted sessions be permanently unsupported, or allowed later behind an explicit option?

## Decision outcome

Finalize namespace support by making namespace an active logical scope across read commands, recommendations, autonomous selection, branch safety, session metadata, handovers, notes, validation, tools, and documentation. Keep the current flat file layout and namespaced ID format. Defer all external tracker-specific import/sync behavior to separate ADRs.
