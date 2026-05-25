import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../mcp/tools.js";
import type { McpToolResult } from "../mcp/node-resolution.js";
import type { StorybloqToolAccess, StorybloqToolDefinition } from "./storybloq-tool-types.js";

function classifyAccess(name: string): StorybloqToolAccess {
  if (name === "storybloq_init" || name === "storybloq_node_init") return "bootstrap";
  if (name.includes("review_lenses")) return "review";
  if (
    name === "storybloq_autonomous_guide" ||
    name === "storybloq_session_report" ||
    name.includes("subprocess")
  ) {
    return "lifecycle";
  }
  if (
    /_(create|update|set|unset|snapshot|add|reinforce)$/.test(name) ||
    name === "storybloq_handover_create" ||
    name === "storybloq_phase_create"
  ) {
    return "write";
  }
  return "read";
}

export function getStorybloqToolDefinitions(pinnedRoot: string): StorybloqToolDefinition[] {
  const definitions: StorybloqToolDefinition[] = [];
  const server = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: Record<string, ZodTypeAny> },
      handler: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult,
    ) {
      const description = config.description ?? name;
      definitions.push({
        name,
        description,
        access: classifyAccess(name),
        inputSchema: config.inputSchema,
        execute: handler,
        promptSnippet: description,
      });
      return { remove() {} };
    },
  };

  registerAllTools(server as unknown as McpServer, pinnedRoot);
  return definitions;
}
