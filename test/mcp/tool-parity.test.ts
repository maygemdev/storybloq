import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initProject } from "../../src/core/init.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { getStorybloqToolDefinitions } from "../../src/tools/storybloq-tool-definitions.js";

describe("MCP tool parity", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "storybloq-mcp-parity-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "MCP Parity Test" });
    return dir;
  }

  it("registerAllTools exposes the same names as the shared catalog", async () => {
    const root = await makeProject();
    const mcpNames: string[] = [];
    const server = {
      registerTool(name: string) {
        mcpNames.push(name);
        return { remove() {} };
      },
    };

    registerAllTools(server as unknown as McpServer, root);

    expect(mcpNames.sort()).toEqual(
      getStorybloqToolDefinitions(root).map((definition) => definition.name).sort(),
    );
  });
});
