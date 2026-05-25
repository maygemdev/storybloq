import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import storybloqPiExtension from "../../src/pi/extension.js";
import { initProject } from "../../src/core/init.js";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function makeFakeContext(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify() {},
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
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerTool(_tool: ToolDefinition) {},
    registerCommand() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

describe("Pi lifecycle integration", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    delete process.env.STORYBLOQ_PROJECT_ROOT;
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "storybloq-pi-life-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "Pi Lifecycle Test" });
    return dir;
  }

  it("turn_end refreshes .story/status.json", async () => {
    const root = await makeProject();
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);

    for (const handler of fake.handlers.get("turn_end") ?? []) {
      await handler({ turnIndex: 0 }, makeFakeContext(root));
    }

    const statusPath = join(root, ".story", "status.json");
    expect(existsSync(statusPath)).toBe(true);
    const status = JSON.parse(await readFile(statusPath, "utf-8")) as { sessionActive: boolean; lastWrittenBy: string };
    expect(status.sessionActive).toBe(false);
    expect(status.lastWrittenBy).toBe("hook");
  });

  it("compaction lifecycle is a non-fatal no-op outside a Storybloq project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storybloq-pi-no-project-"));
    tmpDirs.push(dir);
    const fake = makeFakePi();
    storybloqPiExtension(fake.pi);

    for (const handler of fake.handlers.get("session_before_compact") ?? []) {
      await expect(Promise.resolve(handler({}, makeFakeContext(dir)))).resolves.toBeUndefined();
    }
  });
});
