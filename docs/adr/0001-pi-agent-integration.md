# ADR 0001: Pi Agent Integration

- **Status:** Proposed
- **Date:** 2026-05-25
- **Owner:** Storybloq maintainers
- **Related areas:** `package.json`, `src/skill/`, `src/mcp/`, `src/cli/commands/setup-skill.ts`, `src/autonomous/`, `src/channel/`

## Context

Storybloq currently supports AI coding clients through three main surfaces:

1. **CLI** — the `storybloq` binary reads and mutates `.story/` project state.
2. **MCP server** — `storybloq --mcp` exposes Storybloq tools to Claude Code and Codex.
3. **Agent skill** — the Storybloq skill is copied into Claude/Codex skill locations and instructs the agent how to load context, manage tickets, run autonomous sessions, write handovers, and invoke review workflows.

The current implementation is intentionally client-aware. It installs into Claude and Codex locations, registers MCP servers with those clients, configures their hook systems, and contains skill text that references Claude/Codex-specific concepts such as `/story`, `$story`, `ToolSearch`, `AskUserQuestion`, Claude hooks, Codex hooks, Claude Agent View, and Claude MCP channel notifications.

Pi (`pi.dev`) is a different agent harness. It supports Agent Skills, prompt templates, and TypeScript extensions. Pi does not rely on MCP by default and instead exposes custom tools through `pi.registerTool()` in extensions. Pi also has its own lifecycle events for session start, compaction, tool execution, and agent turns. Therefore, a high-quality Pi integration should be native to Pi rather than treating Pi as another MCP client.

## Decision

Storybloq will add **first-class Pi support** as a Pi package containing:

1. A Pi-compatible Storybloq skill.
2. A Pi extension that registers Storybloq tools natively.
3. Pi lifecycle integration for status updates and compaction/resume behavior.
4. Setup and documentation paths for installing Storybloq into Pi.

The integration will preserve the existing Claude and Codex behavior while adding a Pi adapter layer. The MCP implementation will remain supported, but the Pi integration should not require MCP.

## Goals

- Allow users to install Storybloq into Pi with a standard Pi package flow.
- Make Storybloq tools available as native Pi tools, not only through CLI fallback.
- Keep the existing 53 MCP tools and future Pi tools in sync through shared definitions or shared execution code.
- Support the core `/story` workflow in Pi with equivalent behavior to Claude/Codex where possible.
- Replace Claude/Codex hook assumptions with Pi extension lifecycle events.
- Clearly document which advanced features are supported in Pi initially and which remain Claude/Codex-only.

## Non-goals

- Removing Claude Code or Codex support.
- Replacing the existing MCP server.
- Requiring Pi users to run an MCP bridge.
- Recreating Claude Agent View or adding Pi background dispatch in the initial Pi release.
- Fully recreating Claude MCP channel behavior in the initial Pi release; Pi UI/channel parity is deferred.

## Current gaps

### 1. Pi package metadata

`package.json` currently has no Pi package manifest and does not advertise itself as a Pi package.

Pi packages can declare resources under a `pi` key, for example skills and extensions. Storybloq should add package metadata so `pi install npm:@storybloq/storybloq` can discover the integration resources.

### 2. MCP tools are not Pi tools

The primary tool surface is implemented in `src/mcp/tools.ts` using MCP server registration. Pi extensions require `pi.registerTool()`.

Duplicating all tool definitions in a separate Pi implementation would create long-term drift. The preferred implementation is to extract shared Storybloq tool definitions and execution functions, then adapt them to MCP and Pi separately.

### 3. Skill text is client-specific

`src/skill/SKILL.md` currently assumes Claude/Codex concepts and installation flows. Pi can load Agent Skills, but invocation and interaction semantics differ:

- Pi uses `/skill:story` for skills by default.
- A `/story` command can be provided by a Pi extension, but is not automatic.
- Pi does not expose Claude-specific `ToolSearch` or `AskUserQuestion` tools as built-ins.
- Pi tools registered by extensions are available directly through Pi's tool system.

The skill should become client-neutral where possible and include explicit Pi behavior.

### 4. Hooks are Claude/Codex-specific

Storybloq currently configures:

- Claude `PreCompact`
- Claude `SessionStart`
- Claude/Codex `Stop`
- Codex `hooks.json`

Pi does not use those hook files. Equivalent behavior should move into the Pi extension:

| Current behavior | Current mechanism | Pi mechanism |
| --- | --- | --- |
| Prepare session before compaction | Claude `PreCompact` | `session_before_compact` |
| Resume after compaction | Claude/Codex `SessionStart` | `session_start` and/or `session_compact` with injected message/notification |
| Update `.story/status.json` after a turn | Claude/Codex `Stop` | `turn_end` or `agent_end` |
| Notify user / ask confirmation | Claude/Codex UI-specific tools | Pi extension UI (`ctx.ui`) or normal assistant prompt |

### 5. Setup command only supports Claude/Codex

`storybloq setup --client claude|codex|all` does not include Pi. We need either:

- `storybloq setup --client pi`, or
- clear documentation that Pi setup is performed with `pi install npm:@storybloq/storybloq`.

The preferred path is to support both: add CLI help for Pi and use Pi's own package installation as the canonical installation mechanism.

### 6. Autonomous mode has Claude-specific assumptions

Several autonomous-mode components reference Claude-specific behavior:

- `src/autonomous/agent-view.ts` spawns `claude --bg`.
- `src/core/dispatch-plan.ts` tracks Claude Agent View version support.
- `src/autonomous/resume-marker.ts` writes `.claude/rules/autonomous-resume.md`.
- `src/autonomous/guide.ts` contains Claude Code plan-mode language.
- `src/autonomous/stages/codex-native.ts` distinguishes Claude vs Codex review behavior through `STORYBLOQ_CLIENT`.

Initial Pi support should focus on foreground, single-session autonomous behavior. Parallel dispatch and Agent View equivalents are out of scope for the Pi integration.

### 7. Claude MCP channel integration is not portable

`src/channel/` implements Claude MCP channel and permission behavior. Pi has extension UI APIs instead. A Pi version of this UX is deferred and should not be part of the initial integration.

## Architecture

### Package layout

Add a Pi package manifest to `package.json` after the Pi extension exists:

```json
{
  "keywords": ["storybloq", "pi-package"],
  "pi": {
    "skills": ["./src/skill"],
    "extensions": ["./dist/pi-extension.js"]
  }
}
```

The exact extension path may differ depending on build output. The published package must include all declared Pi resources in `files`.

### Shared tool definitions

Create a shared tool layer, conceptually:

```text
src/tools/storybloq-tool-definitions.ts
src/tools/storybloq-tool-runner.ts
src/mcp/tools.ts
src/pi/extension.ts
```

The shared layer should define:

- Tool name
- Description
- Input schema or schema metadata
- Read/write classification
- Handler function
- Optional prompt snippet/guidelines for Pi

The MCP adapter should convert shared definitions to MCP `server.registerTool()` calls.

The Pi adapter should convert shared definitions to Pi `pi.registerTool()` calls.

This allows parity tests to assert that MCP and Pi expose the same Storybloq tool names unless a tool is intentionally client-specific.

### Pi extension responsibilities

The Pi extension should:

1. Register all 53 Storybloq tools exposed by the current MCP integration.
2. Register a `/story` command that routes to the Storybloq skill.
3. Handle lifecycle events for status updates and compaction/resume support.
4. Optionally provide user interaction helpers with `ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.notify`.
5. Set `STORYBLOQ_CLIENT=pi` for Pi-managed execution paths so client-aware code can choose Pi-specific behavior.

### Skill behavior in Pi

The skill should support these invocation paths:

- Claude Code: `/story`
- Codex: `$story`
- Pi with extension: `/story`
- Pi without extension alias: `/skill:story`

The skill should prefer native tools in this order:

1. Storybloq Pi tools registered by the extension.
2. Storybloq MCP tools if present in a non-Pi client.
3. CLI fallback through shell commands.

The skill should not require Claude-only `ToolSearch`. It should describe client-specific tool discovery only inside client-specific sections.

## Implementation plan

### Phase 1: Pi package MVP

- Add `pi-package` keyword to `package.json`.
- Add a `pi` manifest once the extension entrypoint exists.
- Ensure the npm package includes Pi resources.
- Document the initial installation path:

```bash
pi install npm:@storybloq/storybloq
pi
/skill:story
```

- Provide and document the Pi `/story` command:

```bash
/story
```

### Phase 2: Native Pi tool extension

- Create `src/pi/extension.ts`.
- Register all 53 Storybloq tools using Pi's `pi.registerTool()` API.
- Extract shared tool definitions from `src/mcp/tools.ts` to avoid duplicate logic.
- Preserve all current read/write behavior, project-root resolution, node resolution, locking, validation, and output formatting.
- Add tests that compare MCP and Pi tool names.

### Phase 3: Pi lifecycle integration

- Replace hook-equivalent behavior with Pi events:
  - `session_before_compact` for compact preparation.
  - `session_compact` / `session_start` for resume guidance.
  - `turn_end` or `agent_end` for status updates.
- Avoid writing Claude/Codex hook files for Pi.
- Use Pi UI notifications or injected messages for resume prompts.
- Add tests with mocked extension events where feasible.

### Phase 4: Skill rewrite

- Update `src/skill/SKILL.md` and related files to include Pi invocation.
- Make setup/fallback instructions client-aware.
- Replace Claude/Codex-only assumptions with generic language or client-specific subsections.
- Update `autonomous-mode.md` to say Pi has no built-in plan mode or Agent View and that Storybloq writes plans as files.
- Update review-lenses documentation where paths mention `~/.claude/skills/story` as the only location.

### Phase 5: Setup command support

- Extend setup client type to include `pi`:

```ts
type SetupClient = "claude" | "codex" | "pi" | "all";
```

- Add `handleSetupPi()`.
- Do not mutate Pi user/global settings directly. `handleSetupPi()` should validate that Pi is available when possible and instruct the user to run Pi's native package installation command.
- For local development, support a documented local install flow:

```bash
pi install ./path/to/storybloq
```

### Phase 6: Advanced autonomous support

- Mark Claude Agent View dispatch as Claude-only.
- Do not implement Pi background dispatch as part of this integration.
- Keep Pi autonomous support focused on foreground, single-session workflows.
- Replace `.claude/rules/autonomous-resume.md` with a Pi-specific resume marker or extension-managed session state if needed.

### Phase 7: Documentation and validation

- Update README badges and install instructions to mention Pi once implemented.
- Add a Pi section to the MCP/server reference explaining that Pi uses native tools rather than MCP.
- Add manual test cases to `MANUAL_TEST_PLAN.md`.
- Validate with:

```bash
npm run build
npm test
pi install ./path/to/storybloq
pi
/skill:story
/story
```

## Testing strategy

Automated tests should cover:

- Pi package manifest paths exist in the published package.
- Pi extension registers the expected tool names.
- MCP and Pi adapters expose equivalent core tools.
- Representative read tools work through the shared runner.
- Representative write tools preserve locking and validation behavior.
- Setup command accepts `--client pi` and `--client all`.
- Skill text includes Pi invocation instructions and does not make Pi follow Claude-only setup paths.

Manual tests should cover:

- Fresh Pi install from local path.
- Fresh Pi install from npm package.
- `/skill:story` context load.
- `/story` command.
- Ticket list/get/create/update.
- Handover latest/create.
- Snapshot and recap.
- Autonomous start/report/resume in a single Pi session.
- Pi compaction behavior.
- Review-lenses workflow.
- Federation node read and write behavior.

## Consequences

### Positive

- Storybloq becomes usable in Pi without requiring an MCP bridge.
- Tool behavior remains consistent across Claude, Codex, and Pi.
- The package becomes discoverable in the Pi package ecosystem.
- Pi lifecycle events can replace fragile external hook setup for Pi users.
- Storybloq's skill becomes more portable and less tied to a single client.

### Negative / costs

- The tool layer needs refactoring to avoid duplicating the MCP implementation.
- Client-specific text in the skill must be carefully reorganized.
- Autonomous mode will have foreground/single-session Pi support only; background dispatch remains intentionally unsupported for Pi.
- Tests must cover multiple adapters and may need new mocking utilities for Pi extension behavior.

### Risks

- Tool schema drift between MCP and Pi if shared definitions are not enforced.
- Pi package paths may break if build output and npm `files` are not aligned.
- Skill instructions may become too generic and lose important client-specific safety constraints.
- Autonomous session recovery may behave differently without Claude/Codex hooks unless Pi lifecycle handling is implemented carefully.

## Rollout plan

1. Land package manifest and documentation behind a feature branch.
2. Add Pi extension with full parity for all 53 MCP-equivalent tools.
3. Add lifecycle integration.
4. Update setup command and README.
5. Run manual Pi smoke tests.
6. Release as a minor version with Pi support called out as beta if autonomous advanced workflows remain incomplete.

## Resolved decisions

- `/story` in Pi will be implemented as an extension command.
- The Pi extension will register all 53 Storybloq tools immediately. Users who want a narrower tool set can rely on Pi's own tool allowlisting at launch time.
- Storybloq will not implement a Pi-native replacement for Claude Agent View background dispatch in this integration.
- Claude MCP channel integration will not have a Pi UI equivalent in the initial release; this is deferred.
- Pi setup will use Option B: do not mutate Pi settings directly; instruct users to run `pi install npm:@storybloq/storybloq` and optionally validate that Pi is installed.
- `STORYBLOQ_CLIENT` will accept `pi`. Pi review backend defaults should prefer `lenses`, avoid Codex-native review unless Codex is explicitly installed/configured, and avoid Claude-agent review unless explicitly requested.

## Open questions

None.

## Decision outcome

Proceed with a native Pi package and extension architecture. Treat MCP as the Claude/Codex integration path and Pi extensions as the Pi integration path. Preserve existing behavior while incrementally introducing Pi support, starting with package discovery, native tools, skill invocation, and lifecycle event mapping.
