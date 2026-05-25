import type { ZodTypeAny } from "zod";
import type { McpToolResult } from "../mcp/node-resolution.js";

export type StorybloqToolAccess = "read" | "write" | "bootstrap" | "lifecycle" | "review";

export interface StorybloqToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly access: StorybloqToolAccess;
  readonly inputSchema?: Record<string, ZodTypeAny>;
  readonly execute: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}
