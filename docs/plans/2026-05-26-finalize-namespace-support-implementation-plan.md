# Finalize Namespace Support Implementation Plan

## Summary

Implement ADR 0004 by making the active namespace a logical scope for ticket and issue work while keeping the flat `.story/tickets/{NS}-T-NNN.json` and `.story/issues/{NS}-ISS-NNN.json` storage layout.

The storage layer continues to load the full project. Namespace filtering is applied in query, recommendation, status, CLI, MCP/Pi, handover, note, and autonomous layers.

## Key Changes

- Add shared namespace scope helpers for active, explicit, and all-namespace modes.
- Add branch namespace detection and guard namespace-sensitive writes/session starts when the branch and active namespace clearly conflict.
- Add `--namespace <NS>` and `--all-namespaces` to ticket, issue, status, recommend, note, handover, and export read paths.
- Add `namespace list`, `namespace check`, and `namespace clear`.
- Add matching MCP/Pi tool schema options and namespace management tools.
- Add session/status namespace metadata and scope standard autonomous picking to the session namespace.
- Reject mixed-namespace targeted sessions.
- Tag new handovers with namespace metadata and add optional note namespace.
- Add namespace validation findings for cross-namespace references.
- Update README and skill documentation to use namespaced ID examples.

## Public Interfaces

- CLI flags: `--namespace <NS>`, `--all-namespaces`.
- CLI commands: `namespace list`, `namespace check`, `namespace clear --force`.
- MCP/Pi options: `namespace?: string`, `allNamespaces?: boolean`.
- MCP/Pi tools: `storybloq_namespace_list`, `storybloq_namespace_check`, `storybloq_namespace_clear`.
- Persisted metadata: `SessionState.namespace`, `StatusPayloadActive.namespace`, `Note.namespace`.
- Handover metadata: `<!-- storybloq: namespace=DEV01 -->`.

## Test Plan

- Unit tests for namespace filtering, namespace summaries, target namespace extraction, branch namespace extraction, and validation findings.
- CLI and MCP parity coverage for namespace-scoped command/tool surfaces.
- Handover tests for namespace metadata.
- Autonomous regression tests for namespace-required starts, targeted sessions, and existing orphan recovery behavior.
- Full validation: `npm run build` and `npm test`.

## Assumptions

- Missing active namespace keeps read commands usable globally, but write/allocation and untargeted autonomous starts require a namespace.
- `status` defaults to scoped details plus a compact hidden-namespace summary.
- `namespace set` warns on branch mismatch but still writes `.story/.local.json`.
- Notes use a first-class optional schema field for namespace.
- Mixed-namespace targeted autonomous sessions remain unsupported.
