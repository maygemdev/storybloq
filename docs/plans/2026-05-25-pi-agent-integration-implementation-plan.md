# Pi Agent Integration Implementation Plan

## Status

- **Plan date:** 2026-05-25
- **Source ADR:** `docs/adr/0001-pi-agent-integration.md`
- **Target outcome:** first-class Pi support without regressing Claude, Codex, MCP, CLI, or existing skill behavior.

## Source Inputs

- Local ADR: `docs/adr/0001-pi-agent-integration.md`
- Local implementation surfaces:
  - `package.json`
  - `tsup.config.ts`
  - `src/mcp/index.ts`
  - `src/mcp/tools.ts`
  - `src/cli/commands/setup-skill.ts`
  - `src/cli/register.ts`
  - `src/autonomous/`
  - `src/channel/`
  - `src/skill/`
  - `test/mcp/`
  - `test/cli/commands/setup-skill.test.ts`
  - `test/autonomous/`
- Current Pi docs checked on 2026-05-25:
  - `https://pi.dev/docs/latest/packages`
  - `https://pi.dev/docs/latest/extensions`

## Implementation Principles

1. Preserve existing Claude and Codex behavior. Pi support must be additive.
2. Keep one source of truth for Storybloq tool behavior. Adapters may differ, but handlers, locking, root resolution, validation, output formatting, and error classification must be shared.
3. Make the Pi extension native. Do not require MCP for Pi users.
4. Treat Pi autonomous support as foreground and single-session for the initial release.
5. Make parity testable. A future tool added to MCP should fail tests until the Pi adapter exposes it or explicitly excludes it.

## Current Repo Assessment

### Package And Build

- `package.json` has no `pi` manifest and no `pi-package` keyword.
- Published files currently include `dist`, `src/skill`, and `README.md`.
- `tsup.config.ts` currently builds `cli`, `index`, and `mcp`. It does not build a Pi extension entry.
- If the Pi extension imports Pi runtime types or TypeBox, Pi docs require Pi core packages such as `@earendil-works/pi-coding-agent` and `typebox` to be treated as peer dependencies rather than bundled runtime dependencies.

### MCP Tool Surface

- `src/mcp/tools.ts` currently owns:
  - shared-ish read and write runners: `runMcpReadTool`, `runMcpWriteTool`
  - MCP result formatting
  - all `server.registerTool(...)` calls
  - tool input schemas
  - node resolution hooks for federated nodes
  - special behavior for status update banners, autonomous liveness, and review-lenses helpers
- This file is the critical refactor target. Pi support should not copy the entire file.

### MCP Degraded Mode

- `src/mcp/index.ts` registers degraded `storybloq_status` and `storybloq_init` tools when no `.story/` project is found.
- Pi needs equivalent bootstrap behavior, but the adapter can register it natively instead of using MCP.

### Setup Command

- `src/cli/commands/setup-skill.ts` currently defines `SetupClient = "claude" | "codex" | "all"`.
- `src/cli/register.ts` exposes `--client` choices for Claude, Codex, and all.
- The Pi path should not mutate Pi user settings. It should validate availability where possible and print the canonical `pi install` command.

### Skill Text

- `src/skill/SKILL.md` and support files contain Claude/Codex concepts:
  - `/story`
  - `$story`
  - `ToolSearch`
  - `AskUserQuestion`
  - Claude and Codex hook behavior
  - Claude Agent View and Codex-specific review behavior
- These should become client-aware sections, not global instructions.

### Autonomous And Channel Features

- `src/autonomous/agent-view.ts`, `src/core/dispatch-plan.ts`, `src/autonomous/resume-marker.ts`, and autonomous stage docs contain Claude-specific assumptions.
- `src/channel/` is Claude MCP channel behavior and should remain out of scope for the first Pi release.

## Target Architecture

### Package Layout

Add a Pi extension entry and package manifest:

```json
{
  "keywords": ["storybloq", "pi-package", "...existing keywords"],
  "pi": {
    "skills": ["./src/skill"],
    "extensions": ["./dist/pi-extension.js"]
  }
}
```

The exact extension path should match `tsup.config.ts`. The npm `files` list must include every manifest path.

### Shared Tool Layer

Create a shared tool layer under `src/tools/`:

```text
src/tools/storybloq-tool-types.ts
src/tools/storybloq-tool-runner.ts
src/tools/storybloq-tool-definitions.ts
src/mcp/tools.ts
src/pi/extension.ts
```

Responsibilities:

- `storybloq-tool-types.ts`
  - shared `StorybloqToolDefinition`
  - shared result shape before MCP/Pi adaptation
  - access classification: read, write, bootstrap, lifecycle, review
  - optional client exclusions with reason
- `storybloq-tool-runner.ts`
  - move the current read/write pipelines out of `src/mcp/tools.ts`
  - preserve project loading, integrity warnings, lock behavior, CLI validation handling, project loader error handling, and liveness touching
  - expose a neutral text result that adapters can convert to MCP or Pi result shapes
- `storybloq-tool-definitions.ts`
  - own the full Storybloq tool catalog
  - own tool descriptions and handler closures
  - own parameter schema metadata or adapter schema builders
  - include the current `storybloq_status` update banner behavior
  - include node-root resolution policy for federated reads/writes

Adapter responsibilities:

- `src/mcp/tools.ts`
  - convert shared definitions to `server.registerTool(...)`
  - keep MCP-specific result conversion and `McpServer` imports here
  - keep degraded MCP registration in `src/mcp/index.ts`, but reuse shared bootstrap execution where possible
- `src/pi/extension.ts`
  - convert shared definitions to `pi.registerTool(...)`
  - register `/story`
  - subscribe to Pi lifecycle events
  - set `STORYBLOQ_CLIENT=pi` around Storybloq-managed execution paths

### Schema Strategy

Use this staged approach to reduce risk:

1. First extraction: share names, descriptions, access classifications, handlers, and runner behavior. Keep the current MCP schema definitions functionally unchanged while moving them into reusable definition objects.
2. Pi schema support: add a schema adapter that emits Pi-compatible `parameters` from the shared schema metadata. Prefer TypeBox-shaped schemas because Pi examples use `Type.Object(...)`.
3. Parity enforcement: tests compare the exposed MCP and Pi tool names and descriptions immediately. Schema parity can start with representative tools, then broaden once the adapter is stable.

Do not duplicate handler logic in the Pi extension. If a Pi schema requires a temporary adapter-specific schema, track it in the definition object and add a test that the tool still shares the same handler.

## End-To-End Work Plan

### Phase 0: Preflight And API Lock

Tasks:

- Add a short implementation note to the first PR describing the Pi API version checked.
- Decide whether the Pi extension is built from TypeScript to `dist/pi-extension.js` or published as source under `extensions/`.
- If importing Pi types, add the correct `peerDependencies` and `devDependencies`:
  - `@earendil-works/pi-coding-agent`
  - `typebox`
  - any other Pi package explicitly imported by the extension
- Configure `tsup` to treat Pi peer dependencies as external.

Acceptance criteria:

- `npm run build` succeeds with the new Pi entrypoint, even before the extension registers all tools.
- `npm pack --dry-run` includes the declared Pi resources.
- The plan for Pi dependency placement follows Pi package docs: core Pi packages are peers, not bundled app dependencies.

### Phase 1: Package Manifest MVP

Tasks:

- Update `package.json`:
  - add `pi-package` keyword
  - add `pi.skills`
  - add `pi.extensions` after the extension entry exists
  - update `files` if needed
  - update description only if the wording remains accurate for Claude, Codex, and Pi
- Update `tsup.config.ts`:
  - add `pi-extension: "src/pi/extension.ts"` entry
  - externalize Pi peer dependencies
- Add a minimal `src/pi/extension.ts`:
  - import Pi types only as type imports where possible
  - register no-op or one safe diagnostic command temporarily only if needed for build validation
  - do not expose partial Storybloq tools as final behavior

Acceptance criteria:

- `npm run build`
- `npm pack --dry-run`
- package manifest paths exist after build.

Tests:

- Add `test/pi/package-manifest.test.ts`:
  - `package.json` contains `pi-package`
  - every `pi.skills` path exists
  - every `pi.extensions` source/build path is represented by the build config and npm package files

### Phase 2: Shared Tool Runner

Tasks:

- Move neutral runner logic from `src/mcp/tools.ts` into `src/tools/storybloq-tool-runner.ts`.
- Preserve current behavior exactly:
  - permissive project load for read tools
  - integrity warning prefixing
  - infrastructure error classification
  - `CliValidationError` and `ProjectLoaderError` formatting
  - write locking and validation
  - autonomous liveness touching anchored to pinned root
  - effective-root behavior for federated node operations
- Keep `runMcpReadTool` and `runMcpWriteTool` exports as compatibility wrappers initially, so existing tests and imports continue to pass.

Acceptance criteria:

- Existing `test/mcp/tools.test.ts` and `test/mcp/integration.test.ts` pass without behavior changes.
- Diff to `src/mcp/tools.ts` is mostly mechanical movement plus imports.

Tests:

- Keep existing MCP pipeline tests.
- Add runner-specific unit tests only where the extraction creates new public functions.

### Phase 3: Shared Tool Definitions

Tasks:

- Introduce `StorybloqToolDefinition` with:
  - `name`
  - `description`
  - `access`
  - `parameters`
  - `execute`
  - optional `promptSnippet`
  - optional `promptGuidelines`
  - optional `clientExclusions`
- Move each `server.registerTool(...)` body from `registerAllTools` into the shared catalog.
- Keep all current tool names stable.
- Preserve special cases:
  - `storybloq_status` update banner
  - `storybloq_node_init` orchestrator-only restriction
  - node read/write permission checks
  - review-lenses auto-filing behavior
  - autonomous guide liveness touch for session-specific calls
- Rewrite `registerAllTools(server, pinnedRoot)` to iterate over definitions and call a small MCP adapter.

Acceptance criteria:

- The generated MCP tool list is identical to the pre-refactor list.
- No user-facing tool description changes unless intentional and covered in tests.
- No change to CLI behavior.

Tests:

- Add `test/tools/catalog.test.ts`:
  - all tool names are unique
  - every definition has description and access classification
  - no accidental client exclusion for core tools
- Add `test/mcp/tool-parity.test.ts`:
  - a fake MCP server captures `registerTool` calls
  - captured names equal the shared catalog names after excluding MCP-degraded-only bootstrap behavior

### Phase 4: Native Pi Tool Adapter

Tasks:

- Implement `src/pi/extension.ts` as the real Pi extension:
  - default export function receives `ExtensionAPI`
  - discover/pin project root from `ctx.cwd`, `process.cwd()`, or explicit env if available
  - register `storybloq_init` and degraded `storybloq_status` when no project is found
  - register all shared Storybloq definitions when a project is found
  - after `storybloq_init`, register or refresh the full tool set in the same session
  - map shared results into Pi tool result content
  - set `STORYBLOQ_CLIENT=pi` for handler execution and restore the previous env value afterward
  - expose prompt snippets/guidelines sparingly, with each guideline naming its tool explicitly
- Add `/story` command:
  - route to the Storybloq skill flow by sending a user message or loading skill context using Pi-supported command semantics
  - keep `/skill:story` documented as the fallback path
  - avoid relying on MCP tool discovery in Pi

Acceptance criteria:

- A fake Pi API can capture all registered tool names.
- Pi tool names match the shared catalog.
- Representative read and write tools work through the Pi adapter in tests.
- `/story` command is registered by the extension.

Tests:

- Add `test/pi/extension.test.ts`:
  - fake `registerTool` captures all tools
  - fake `registerCommand` captures `/story`
  - tool names equal shared catalog names
  - `STORYBLOQ_CLIENT` is restored after tool execution
  - representative read: `storybloq_status`
  - representative write: `storybloq_phase_create`
  - degraded mode exposes `storybloq_status` and `storybloq_init`

### Phase 5: Pi Lifecycle Integration

Tasks:

- Map current hook behavior to Pi events:
  - Claude `PreCompact` equivalent: `session_before_compact`
  - Claude/Codex `SessionStart` resume guidance: `session_start` and/or compaction-related session events
  - Claude/Codex `Stop` status updates: `turn_end` or `agent_end`
- Reuse existing command handlers where possible:
  - compact preparation from `src/cli/commands/session-compact.ts`
  - status writing from `src/cli/commands/hook-status.ts` or the underlying status writer
- Use Pi UI APIs only where there is a direct user-facing need:
  - `ctx.ui.notify` for non-blocking resume/status information
  - `ctx.ui.confirm` or `ctx.ui.select` only for real choices
- Do not write `.claude/settings.json`, `.codex/hooks.json`, or other Claude/Codex hook files for Pi.
- Ensure lifecycle event handlers are best-effort and never crash Pi startup.

Acceptance criteria:

- Mocked lifecycle events call the expected Storybloq behavior.
- Event handlers are idempotent and tolerate missing `.story/`.
- No Pi path writes Claude or Codex hook config.

Tests:

- Add `test/pi/lifecycle.test.ts`:
  - `session_before_compact` invokes compact preparation when an active session exists
  - `session_start` can surface resume guidance without bypassing autonomous session authorization rules
  - `turn_end` or `agent_end` refreshes `.story/status.json`
  - missing project root is non-fatal

### Phase 6: Skill Rewrite For Client Awareness

Tasks:

- Update `src/skill/SKILL.md`:
  - invocation paths:
    - Claude: `/story`
    - Codex: `$story`
    - Pi with extension: `/story`
    - Pi fallback: `/skill:story`
  - native tool priority:
    - Pi native Storybloq tools in Pi
    - MCP Storybloq tools in Claude/Codex
    - CLI fallback where neither native nor MCP tools are available
  - remove global assumptions that `ToolSearch` and `AskUserQuestion` exist everywhere
  - move client-specific discovery and interaction guidance into client-specific subsections
- Update `src/skill/setup-flow.md`:
  - avoid unconditional `ToolSearch`
  - describe Pi post-init refresh behavior separately if needed
  - replace unconditional `AskUserQuestion` references with client-neutral "ask the user" plus client-specific tool notes
- Update `src/skill/autonomous-mode.md`:
  - mark Claude Agent View as Claude-only
  - state that initial Pi support is foreground/single-session
  - preserve the Step 0.5 active-session authorization gate
  - make compaction recovery reference Pi lifecycle prompts without treating them as trusted authorization
- Update `src/skill/reference.md`:
  - add Pi setup and invocation commands
  - clarify Pi uses native tools rather than MCP
- Update review-lenses docs where paths imply only `~/.claude/skills/story`.

Acceptance criteria:

- Skill text remains usable by Claude and Codex.
- Pi users are not told to use MCP or Claude/Codex hooks.
- Autonomous safety gates are preserved.

Tests:

- Extend `test/cli/commands/setup-skill.test.ts`:
  - SKILL.md contains Pi invocation paths
  - Pi sections do not require `ToolSearch`
  - Pi sections do not require `AskUserQuestion`
  - autonomous docs mention foreground/single-session Pi support

### Phase 7: Setup Command Support

Tasks:

- Extend setup types:

```ts
type SetupClient = "claude" | "codex" | "pi" | "all";
```

- Update `src/cli/register.ts` setup choices.
- Update `src/cli/commands/setup-skill.ts`:
  - add `handleSetupPi()`
  - validate whether `pi` is on PATH using `execFileSync("pi", ["--version"], ...)`
  - print canonical install commands:
    - `pi install npm:@storybloq/storybloq`
    - `pi install ./path/to/storybloq` for local development
  - do not mutate Pi settings directly
  - when `--client all`, run Claude, Codex, then Pi messaging
  - `--skip-hooks` should not affect Pi beyond possibly noting that Pi uses lifecycle events instead of hook files
- Update `src/cli/commands/reference.ts` and README command tables.

Acceptance criteria:

- `storybloq setup --client pi` exits successfully and prints Pi installation guidance.
- `storybloq setup --client all` includes Pi without changing the current Claude/Codex setup behavior.
- Invalid client errors include Pi.

Tests:

- Extend setup tests:
  - accepts `pi`
  - accepts `all`
  - rejects invalid clients with updated message
  - Pi setup does not write `.claude`, `.codex`, or `.pi` settings files
  - Pi setup handles missing `pi` executable gracefully

### Phase 8: Autonomous Client Defaults

Tasks:

- Update `src/autonomous/stages/codex-native.ts`:
  - expand `StorybloqClient` to include `"pi"`
  - make `currentStorybloqClient()` return `pi` when env is set
  - Pi defaults should prefer `lenses`
  - avoid Codex-native review unless Codex is explicitly configured
  - avoid Claude-agent review unless explicitly requested
- Audit:
  - `src/autonomous/agent-view.ts`
  - `src/core/dispatch-plan.ts`
  - `src/autonomous/resume-marker.ts`
  - `src/autonomous/guide.ts`
  - `src/autonomous/stages/*.ts`
- Add Pi-specific wording only where behavior actually differs.
- Do not implement Pi background dispatch in this release.

Acceptance criteria:

- Pi autonomous mode can start, report, compact, resume, and complete in one foreground session.
- Background dispatch remains clearly marked Claude-only.
- Review backend selection for Pi follows the ADR.

Tests:

- Extend `test/autonomous/codex-native.test.ts`:
  - `STORYBLOQ_CLIENT=pi` returns Pi-safe backends
  - explicit Codex configuration still works when requested
- Add or update autonomous guide tests for Pi wording where needed.

### Phase 9: Documentation And Manual Test Plan

Tasks:

- Update README:
  - mention Pi support in install/setup section
  - clarify Claude/Codex use MCP, Pi uses native extension tools
  - add Pi invocation examples
  - keep existing Claude/Codex setup commands intact
- Update `MANUAL_TEST_PLAN.md`:
  - local Pi install from repo path
  - npm Pi install from packed package
  - `/skill:story`
  - `/story`
  - tool smoke tests:
    - status
    - ticket list/get/create/update
    - issue list/get/create/update
    - handover latest/create
    - snapshot
    - recap
    - node read/write behavior
  - autonomous single-session start/report/resume
  - compaction behavior
  - review-lenses workflow
- Add a release note entry if the repo has a changelog path by the time this lands.

Acceptance criteria:

- A maintainer can run the full Pi smoke test from the docs without reading the ADR.
- Docs do not imply Pi requires MCP.

### Phase 10: Rollout

Tasks:

- Land as a feature branch with small PRs:
  1. package/build skeleton
  2. shared runner extraction
  3. shared catalog extraction
  4. Pi adapter and parity tests
  5. lifecycle integration
  6. skill/docs/setup/autonomous updates
- Mark Pi support beta if advanced autonomous features remain Claude/Codex-only.
- Before release:
  - `npm run build`
  - `npm test`
  - `npm pack --dry-run`
  - local Pi install smoke test
  - clean Claude setup smoke test
  - clean Codex setup smoke test

Acceptance criteria:

- Existing test suite passes.
- Pi manual smoke tests pass.
- Claude and Codex manual setup paths still work.

## Cross-Cutting Test Matrix

| Area | Automated | Manual |
| --- | --- | --- |
| Package manifest | `test/pi/package-manifest.test.ts` | `npm pack --dry-run` |
| Build entry | build test through `npm run build` | inspect `dist/pi-extension.js` |
| MCP parity | fake MCP registration test | existing Claude MCP smoke |
| Pi parity | fake Pi API registration test | `pi install ./path/to/storybloq` |
| Tool execution | representative read/write Pi tests | status, ticket, issue, handover flows |
| Degraded mode | no `.story/` Pi adapter test | run Pi outside a Storybloq project |
| Lifecycle | mocked Pi event tests | compaction/resume smoke |
| Setup CLI | setup command tests | `storybloq setup --client pi` |
| Skill text | file-content assertions | `/story` and `/skill:story` |
| Autonomous | Pi client backend tests | single-session autonomous flow |

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Tool schema drift between MCP and Pi | Shared catalog plus parity tests that fail on missing tool names. |
| Shared schema adapter becomes too large | Stage schema work. Share handlers first, then broaden schema parity. |
| Pi package manifest paths point at missing build output | Add package-manifest tests and run `npm pack --dry-run`. |
| Pi extension accidentally bundles Pi core packages | Use peer dependencies and tsup external configuration. |
| Skill becomes too generic for Claude/Codex | Use client-specific subsections instead of deleting existing guidance. |
| Lifecycle handlers bypass autonomous authorization | Resume prompts must remain advisory; Step 0.5 authorization still gates resume/cancel behavior. |
| Claude/Codex setup regresses | Keep setup tests for existing clients and run manual setup smoke tests before release. |

## Definition Of Done

- `package.json` advertises a valid Pi package.
- `dist/pi-extension.js` is built and included in the npm package.
- Pi registers all current Storybloq tools natively, with parity tests against the shared catalog.
- `/story` works in Pi with `/skill:story` documented as fallback.
- Pi lifecycle events replace Claude/Codex hook behavior for Pi.
- `storybloq setup --client pi` and `storybloq setup --client all` are supported.
- Skill docs are client-aware and no longer make Pi follow Claude/Codex-only setup paths.
- Pi autonomous mode supports foreground, single-session workflows and clearly defers background dispatch.
- `npm run build`, `npm test`, and the manual Pi smoke plan pass.
