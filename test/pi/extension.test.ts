import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import storybloqPiExtension from "../../src/pi/extension.js";
import { initProject } from "../../src/core/init.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { createSession, prepareForCompact, sessionDir } from "../../src/autonomous/session.js";
import { deriveWorkspaceId } from "../../src/autonomous/session-types.js";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandOptions = {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => unknown;
};
type Notification = { message: string; level: string };

function makeFakeContext(cwd: string, notifications: Notification[] = []): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      onTerminalInput: () => () => {},
      setStatus() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setWidget() {},
      setFooter() {},
      setHeader() {},
      setTitle() {},
      custom: async () => undefined,
      pasteToEditor() {},
      setEditorText() {},
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent: () => undefined,
      theme: {} as never,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false }),
      getToolsExpanded: () => false,
      setToolsExpanded() {},
    },
    sessionManager: {} as never,
    modelRegistry: {} as never,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;
}

function makeFakePi() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandOptions>();
  const handlers = new Map<string, Handler[]>();
  const sentUserMessages: string[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: CommandOptions) {
      commands.set(name, options);
    },
    sendUserMessage(content: string) {
      sentUserMessages.push(content);
    },
  } as unknown as ExtensionAPI;

  return { pi, tools, commands, handlers, sentUserMessages };
}

function captureMcpToolNames(root: string): string[] {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
      return { remove() {} };
    },
  };
  registerAllTools(server as unknown as McpServer, root);
  return names.sort();
}

describe("Pi extension", () => {
  const tmpDirs: string[] = [];
  const originalClient = process.env.STORYBLOQ_CLIENT;
  const originalPiCommand = process.env.STORYBLOQ_PI_COMMAND;

  afterEach(async () => {
    if (originalClient === undefined) delete process.env.STORYBLOQ_CLIENT;
    else process.env.STORYBLOQ_CLIENT = originalClient;
    if (originalPiCommand === undefined) delete process.env.STORYBLOQ_PI_COMMAND;
    else process.env.STORYBLOQ_PI_COMMAND = originalPiCommand;
    delete process.env.STORYBLOQ_PROJECT_ROOT;
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "storybloq-pi-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "Pi Test" });
    return dir;
  }

  it("registers /story and all MCP-equivalent Storybloq tools for a project", async () => {
    const root = await makeProject();
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);

    for (const handler of fake.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, makeFakeContext(root));
    }

    expect(fake.commands.has("story")).toBe(true);
    expect([...fake.tools.keys()].sort()).toEqual(captureMcpToolNames(root));
  });

  it("registers a configured /story-dev command for development Pi installs", async () => {
    process.env.STORYBLOQ_PI_COMMAND = "/story-dev";
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);

    expect(fake.commands.has("story-dev")).toBe(true);
    expect(fake.commands.has("story")).toBe(false);

    await fake.commands.get("story-dev")!.handler("auto T-001", makeFakeContext(process.cwd()));

    expect(fake.sentUserMessages).toEqual(["Use the Storybloq skill now: /skill:story-dev auto T-001"]);
  });

  it("uses the configured Pi command name in compact resume warnings", async () => {
    process.env.STORYBLOQ_PI_COMMAND = "story-dev";
    const root = await makeProject();
    const session = createSession(root, "coding", deriveWorkspaceId(root));
    prepareForCompact(sessionDir(root, session.sessionId), session);
    const notifications: Notification[] = [];
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);

    for (const handler of fake.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, makeFakeContext(root, notifications));
    }

    expect(notifications.some((notification) => notification.message.includes("Run /story-dev to review resume options"))).toBe(true);
  });

  it("restores STORYBLOQ_CLIENT after executing a Pi-adapted tool", async () => {
    const root = await makeProject();
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);
    for (const handler of fake.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, makeFakeContext(root));
    }

    process.env.STORYBLOQ_CLIENT = "codex";
    const statusTool = fake.tools.get("storybloq_status");
    expect(statusTool).toBeDefined();
    const result = await statusTool!.execute("call-1", {}, undefined, undefined, makeFakeContext(root));

    expect(process.env.STORYBLOQ_CLIENT).toBe("codex");
    expect(result.content[0]?.type).toBe("text");
  });

  it("can execute representative write tools through the Pi adapter", async () => {
    const root = await makeProject();
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);
    for (const handler of fake.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, makeFakeContext(root));
    }

    const phaseCreate = fake.tools.get("storybloq_phase_create");
    expect(phaseCreate).toBeDefined();
    const result = await phaseCreate!.execute(
      "call-1",
      { id: "alpha", name: "Alpha", label: "ALPHA", description: "Alpha phase", after: "p0" },
      undefined,
      undefined,
      makeFakeContext(root),
    );

    expect(result.content[0]?.text).toContain("Created phase alpha");
    const roadmap = JSON.parse(await readFile(join(root, ".story", "roadmap.json"), "utf-8")) as {
      phases: Array<{ id: string }>;
    };
    expect(roadmap.phases.map((phase) => phase.id)).toContain("alpha");
  });

  it("exposes degraded status and init tools when no Storybloq project exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storybloq-pi-empty-"));
    tmpDirs.push(dir);
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);

    for (const handler of fake.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, makeFakeContext(dir));
    }

    expect([...fake.tools.keys()].sort()).toEqual(["storybloq_init", "storybloq_status"]);
  });
});
