import { join } from "node:path";
import { findActiveSessionMinimal, sessionDir } from "../autonomous/session.js";
import { touchLastMcpCallFile } from "../autonomous/liveness.js";
import { loadProject } from "../core/project-loader.js";
import { ProjectLoaderError, INTEGRITY_WARNING_TYPES } from "../core/errors.js";
import { CliValidationError } from "../cli/helpers.js";
import type { CommandContext, CommandResult } from "../cli/types.js";
import type { McpToolResult } from "../mcp/node-resolution.js";

const INFRASTRUCTURE_ERROR_CODES: readonly string[] = [
  "io_error",
  "project_corrupt",
  "version_mismatch",
];

const SESSION_CACHE_TTL_MS = 30_000;
let cachedSessionDir: string | null = null;
let cachedSessionAt = 0;

export function touchMcpLiveness(pinnedRoot: string): void {
  const now = Date.now();
  if (cachedSessionDir && now - cachedSessionAt < SESSION_CACHE_TTL_MS) {
    touchLastMcpCallFile(cachedSessionDir);
    return;
  }
  const active = findActiveSessionMinimal(pinnedRoot);
  if (active) {
    cachedSessionDir = sessionDir(pinnedRoot, active.sessionId);
    cachedSessionAt = now;
    touchLastMcpCallFile(cachedSessionDir);
  } else {
    cachedSessionDir = null;
  }
}

function formatMcpError(code: string, message: string): string {
  return `[${code}] ${message}`;
}

export async function runMcpReadTool(
  pinnedRoot: string,
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult,
  effectiveRoot?: string,
): Promise<McpToolResult> {
  try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
  const loadRoot = effectiveRoot ?? pinnedRoot;
  try {
    const { state, warnings } = await loadProject(loadRoot);
    const handoversDir = join(loadRoot, ".story", "handovers");
    const ctx: CommandContext = { state, warnings, root: loadRoot, handoversDir, format: "md" };

    const result = await handler(ctx);

    if (result.errorCode && INFRASTRUCTURE_ERROR_CODES.includes(result.errorCode)) {
      return {
        content: [{ type: "text", text: formatMcpError(result.errorCode, result.output) }],
        isError: true,
      };
    }

    let text = result.output;
    const integrityWarnings = warnings.filter((warning) =>
      (INTEGRITY_WARNING_TYPES as readonly string[]).includes(warning.type),
    );
    if (integrityWarnings.length > 0) {
      const details = integrityWarnings
        .slice(0, 5)
        .map((warning) => `  - ${warning.file}: ${warning.message}`)
        .join("\n");
      const more = integrityWarnings.length > 5
        ? `\n  ... and ${integrityWarnings.length - 5} more. Run storybloq_validate for the full list.`
        : "";
      text = `Warning: ${integrityWarnings.length} item(s) skipped due to data integrity issues:\n${details}${more}\n\n${text}`;
    }

    return { content: [{ type: "text", text }] };
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    if (err instanceof CliValidationError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: formatMcpError("io_error", message) }], isError: true };
  }
}

export async function runMcpWriteTool(
  pinnedRoot: string,
  handler: (root: string, format: "md") => Promise<CommandResult>,
  effectiveRoot?: string,
): Promise<McpToolResult> {
  try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
  const writeRoot = effectiveRoot ?? pinnedRoot;
  try {
    const result = await handler(writeRoot, "md");

    if (result.errorCode && INFRASTRUCTURE_ERROR_CODES.includes(result.errorCode)) {
      return {
        content: [{ type: "text", text: formatMcpError(result.errorCode, result.output) }],
        isError: true,
      };
    }

    return { content: [{ type: "text", text: result.output }] };
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    if (err instanceof CliValidationError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: formatMcpError("io_error", message) }], isError: true };
  }
}
