import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z, type ZodTypeAny } from "zod";
import { discoverProjectRoot } from "../core/project-root-discovery.js";
import { initProject, STORY_GITIGNORE_ENTRIES } from "../core/init.js";
import { loadProject } from "../core/project-loader.js";
import { saveSnapshot } from "../core/snapshot.js";
import { tryReadFile } from "../cli/util/file-io.js";
import { buildActivePayload, buildInactivePayload } from "../autonomous/status-payload.js";
import { writeStatusFile } from "../autonomous/status-writer.js";
import {
  findActiveSessionFull,
  findActiveSessionMinimal,
  findResumableSession,
  prepareForCompact,
  refreshLease,
  sessionDir,
  withSessionLock,
} from "../autonomous/session.js";
import { readAliveTimestamp, readLastMcpCall } from "../autonomous/liveness.js";
import { readSubprocessSummaries } from "../autonomous/subprocess-registry.js";
import { collectProbes, reduceHealthState } from "../autonomous/health-model.js";
import { removeResumeMarker, writeResumeMarker } from "../autonomous/resume-marker.js";
import type { McpToolResult } from "../mcp/node-resolution.js";
import { getStorybloqToolDefinitions } from "../tools/storybloq-tool-definitions.js";
import type { StorybloqToolDefinition } from "../tools/storybloq-tool-types.js";

const ENV_VAR = "STORYBLOQ_PROJECT_ROOT";
const LEGACY_ENV_VAR = "CLAUDESTORY_PROJECT_ROOT";
const DEFAULT_PI_COMMAND = "story";
const CONFIG_PATH = ".story/config.json";

function getPiCommandName(): string {
  const command = process.env.STORYBLOQ_PI_COMMAND?.trim().replace(/^\/+/, "");
  return command || DEFAULT_PI_COMMAND;
}

function labelForTool(name: string): string {
  return name
    .replace(/^storybloq_/, "")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function tryDiscoverRoot(cwd: string): string | null {
  const envRoot = process.env[ENV_VAR] ?? process.env[LEGACY_ENV_VAR];
  if (envRoot) {
    if (!isAbsolute(envRoot)) return null;
    try {
      const canonical = realpathSync(resolve(envRoot));
      return existsSync(join(canonical, CONFIG_PATH)) ? canonical : null;
    } catch {
      return null;
    }
  }

  try {
    const root = discoverProjectRoot(cwd);
    return root ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

function withPiClient<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const previous = process.env.STORYBLOQ_CLIENT;
  process.env.STORYBLOQ_CLIENT = "pi";
  const restore = () => {
    if (previous === undefined) {
      delete process.env.STORYBLOQ_CLIENT;
    } else {
      process.env.STORYBLOQ_CLIENT = previous;
    }
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function mcpToPiResult(result: McpToolResult): {
  content: Array<{ type: "text"; text: string }>;
  details: { isError: boolean };
} {
  return {
    content: result.content,
    details: { isError: result.isError === true },
  };
}

function zodToTypebox(schema: ZodTypeAny): TSchema {
  const optional = schema.safeParse(undefined).success;
  const unwrapped = unwrapZod(schema);
  const description = schema.description ?? unwrapped.description;
  const base = zodBaseToJsonSchema(unwrapped);
  if (description) base.description = description;
  const typebox = Type.Unsafe(base as TSchema);
  return optional ? Type.Optional(typebox) : typebox;
}

function unwrapZod(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodEffects
  ) {
    const def = current._def as { innerType?: ZodTypeAny; schema?: ZodTypeAny };
    current = def.innerType ?? def.schema ?? current;
    if (current === schema) break;
  }
  return current;
}

function zodBaseToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = schema._def as Record<string, unknown>;
  if (schema instanceof z.ZodString) {
    const json: Record<string, unknown> = { type: "string" };
    const checks = Array.isArray(def.checks) ? def.checks as Array<Record<string, unknown>> : [];
    for (const check of checks) {
      if (check.kind === "regex" && check.regex instanceof RegExp) json.pattern = check.regex.source;
      if (check.kind === "min" && typeof check.value === "number") json.minLength = check.value;
      if (check.kind === "max" && typeof check.value === "number") json.maxLength = check.value;
      if (check.kind === "uuid") json.format = "uuid";
    }
    return json;
  }
  if (schema instanceof z.ZodNumber) {
    const json: Record<string, unknown> = { type: "number" };
    const checks = Array.isArray(def.checks) ? def.checks as Array<Record<string, unknown>> : [];
    for (const check of checks) {
      if (check.kind === "int") json.type = "integer";
      if (check.kind === "min" && typeof check.value === "number") json.minimum = check.value;
      if (check.kind === "max" && typeof check.value === "number") json.maximum = check.value;
    }
    return json;
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodNativeEnum) return { enum: Object.values(schema.enum) };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodArray) return { type: "array", items: zodBaseToJsonSchema(schema.element) };
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const propSchema = value as ZodTypeAny;
      properties[key] = zodBaseToJsonSchema(unwrapZod(propSchema));
      if (!propSchema.safeParse(undefined).success) required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodUnion) {
    const options = (schema._def as { options: ZodTypeAny[] }).options;
    return { anyOf: options.map((option) => zodBaseToJsonSchema(unwrapZod(option))) };
  }
  if (schema instanceof z.ZodRecord) return { type: "object", additionalProperties: true };
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) return {};
  return {};
}

function parametersFromMcpInput(inputSchema?: Record<string, ZodTypeAny>): TSchema {
  if (!inputSchema) return Type.Object({});

  const properties: Record<string, TSchema> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(inputSchema)) {
    properties[key] = zodToTypebox(schema);
    if (!schema.safeParse(undefined).success) required.push(key);
  }

  return Type.Object(properties, {
    additionalProperties: false,
    required,
  });
}

function registerProjectTools(pi: ExtensionAPI, pinnedRoot: string, registered: Set<string>): void {
  for (const tool of getStorybloqToolDefinitions(pinnedRoot)) {
    if (registered.has(tool.name)) continue;
    registered.add(tool.name);
    pi.registerTool({
      name: tool.name,
      label: labelForTool(tool.name),
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines ? [...tool.promptGuidelines] : undefined,
      parameters: parametersFromMcpInput(tool.inputSchema),
      async execute(_toolCallId, params) {
        const result = await withPiClient(() => tool.execute(params as Record<string, unknown>));
        return mcpToPiResult(result);
      },
    } satisfies ToolDefinition<TSchema, unknown, StorybloqToolDefinition>);
  }
}

function registerDegradedTools(pi: ExtensionAPI, ctx: ExtensionContext, registered: Set<string>): void {
  if (!registered.has("storybloq_status")) {
    registered.add("storybloq_status");
    pi.registerTool({
      name: "storybloq_status",
      label: "Status",
      description: "Project summary -- returns guidance if no .story/ project found",
      promptSnippet: "Check whether the current directory has Storybloq project state.",
      parameters: Type.Object({}),
      async execute() {
        return mcpToPiResult({
          content: [{ type: "text", text: "No .story/ project found. Use storybloq_init to create one, or navigate to a directory with .story/." }],
          isError: true,
        });
      },
    });
  }

  if (!registered.has("storybloq_init")) {
    registered.add("storybloq_init");
    pi.registerTool({
      name: "storybloq_init",
      label: "Init",
      description: "Initialize a new .story/ project in the current directory",
      promptSnippet: "Initialize a new Storybloq project when the current directory has project files but no .story state.",
      parameters: Type.Object({
        name: Type.String({ description: "Project name" }),
        type: Type.Optional(Type.String({ description: "Project type (e.g. npm, macapp, cargo, generic)" })),
        language: Type.Optional(Type.String({ description: "Primary language (e.g. typescript, swift, rust)" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const projectRoot = realpathSync(ctx.cwd);
          const result = await withPiClient(() => initProject(projectRoot, {
            name: params.name,
            type: params.type,
            language: params.language,
            phases: [],
          }));
          registerProjectTools(pi, result.root, registered);
          return mcpToPiResult({
            content: [{ type: "text", text: `Initialized Storybloq project at ${result.root}` }],
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return mcpToPiResult({
            content: [{ type: "text", text: `[init_error] ${msg}` }],
            isError: true,
          });
        }
      },
    });
  }
}

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, ".story", ".gitignore");
  const readResult = tryReadFile(gitignorePath);
  let existing = readResult.ok ? readResult.content : "";
  const lines = existing.split("\n").map((line) => line.trim());
  const missing = STORY_GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  if (existing.length > 0 && !existing.endsWith("\n")) existing += "\n";
  try {
    writeFileSync(gitignorePath, `${existing}${missing.join("\n")}\n`, "utf-8");
  } catch {
    // Best effort.
  }
}

function refreshStatus(root: string): void {
  try {
    const session = findActiveSessionMinimal(root);
    const payload = session
      ? buildActivePayload(session, {
          lastMcpCall: readLastMcpCall(sessionDir(root, session.sessionId)),
          alive: readAliveTimestamp(sessionDir(root, session.sessionId)) !== null,
          runningSubprocesses: readSubprocessSummaries(sessionDir(root, session.sessionId)),
          healthState: reduceHealthState(collectProbes(sessionDir(root, session.sessionId))),
        })
      : buildInactivePayload();
    ensureGitignore(root);
    writeStatusFile(root, { ...payload, lastWrittenBy: "hook" });
  } catch {
    // Lifecycle status is best effort.
  }
}

async function prepareForPiCompact(root: string): Promise<void> {
  await withSessionLock(root, async () => {
    const active = findActiveSessionFull(root);
    if (!active) return;

    prepareForCompact(active.dir, refreshLease(active.state));
    writeResumeMarker(root, active.state.sessionId, {
      ticket: active.state.ticket,
      completedTickets: active.state.completedTickets,
      resolvedIssues: active.state.resolvedIssues,
      preCompactState: active.state.preCompactState ?? active.state.state,
    });

    try {
      const loadResult = await loadProject(root);
      await saveSnapshot(root, loadResult);
    } catch {
      // compactPending persisted; snapshot can be retried later.
    }
  });
}

function notifyResumeIfNeeded(root: string, ctx: ExtensionContext, commandName: string): void {
  const match = findResumableSession(root);
  if (!match) {
    removeResumeMarker(root);
    return;
  }
  const sessionId = match.info.state.sessionId;
  const prefix = match.stale ? "Stale compacted Storybloq session" : "Compacted Storybloq session";
  ctx.ui.notify(`${prefix} ${sessionId} found. Run /${commandName} to review resume options before continuing.`, "warning");
}

export default function storybloqPiExtension(pi: ExtensionAPI): void {
  const registered = new Set<string>();
  const commandName = getPiCommandName();

  pi.on("session_start", (_event, ctx) => {
    const root = tryDiscoverRoot(ctx.cwd);
    if (root) {
      registerProjectTools(pi, root, registered);
      notifyResumeIfNeeded(root, ctx, commandName);
    } else {
      registerDegradedTools(pi, ctx, registered);
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const root = tryDiscoverRoot(ctx.cwd);
    if (!root) return;
    await withPiClient(() => prepareForPiCompact(root));
  });

  pi.on("turn_end", (_event, ctx) => {
    const root = tryDiscoverRoot(ctx.cwd);
    if (root) refreshStatus(root);
  });

  pi.on("agent_end", (_event, ctx) => {
    const root = tryDiscoverRoot(ctx.cwd);
    if (root) refreshStatus(root);
  });

  pi.registerCommand(commandName, {
    description: "Load Storybloq project context",
    handler: async (args, ctx) => {
      const suffix = args.trim() ? ` ${args.trim()}` : "";
      pi.sendUserMessage(`Use the Storybloq skill now: /skill:${commandName}${suffix}`);
      ctx.ui.notify("Starting Storybloq context load", "info");
    },
  });
}
