import { readdir, readFile, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { NAMESPACE_REGEX } from "../../models/local-config.js";
import { writeLocalConfig } from "../../core/local-config-loader.js";
import { withProjectLock, atomicWrite, guardPath, serializeJSON } from "../../core/project-loader.js";
import type { CommandResult } from "../types.js";

const OLD_TICKET_ID_RE = /^T-\d+[a-z]?$/;
const OLD_ISSUE_ID_RE = /^ISS-\d+$/;
const OLD_CROSS_NODE_RE = /^([a-z][a-z0-9_-]{0,63}):(T-\d+[a-z]?|ISS-\d+)$/;
const OLD_TEXT_ID_RE = /(^|[^A-Za-z0-9_-])((?:[a-z][a-z0-9_-]{0,63}:)?(?:T-\d+[a-z]?|ISS-\d+))(?![A-Za-z0-9_-])/g;

function isOldFormat(id: string): boolean {
  return OLD_TICKET_ID_RE.test(id) || OLD_ISSUE_ID_RE.test(id);
}

function migrateId(id: string, namespace: string): string {
  if (OLD_TICKET_ID_RE.test(id) || OLD_ISSUE_ID_RE.test(id)) {
    return `${namespace}-${id}`;
  }
  return id;
}

function migrateCrossNodeRef(ref: string, namespace: string): string {
  const match = ref.match(OLD_CROSS_NODE_RE);
  if (match) {
    return `${match[1]}:${namespace}-${match[2]}`;
  }
  return ref;
}

function migrateTextMentions(text: string, namespace: string): { text: string; replacements: number } {
  let replacements = 0;
  const migrated = text.replace(OLD_TEXT_ID_RE, (full, prefix: string, ref: string) => {
    const updated = ref.includes(":")
      ? migrateCrossNodeRef(ref, namespace)
      : migrateId(ref, namespace);
    if (updated === ref) return full;
    replacements += 1;
    return `${prefix}${updated}`;
  });
  return { text: migrated, replacements };
}

function migrateJsonStrings(value: unknown, namespace: string): { value: unknown; replacements: number } {
  if (typeof value === "string") {
    const result = migrateTextMentions(value, namespace);
    return { value: result.text, replacements: result.replacements };
  }

  if (Array.isArray(value)) {
    let replacements = 0;
    const updated = value.map((item) => {
      const result = migrateJsonStrings(item, namespace);
      replacements += result.replacements;
      return result.value;
    });
    return { value: updated, replacements };
  }

  if (value && typeof value === "object") {
    let replacements = 0;
    const updated: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = migrateJsonStrings(item, namespace);
      replacements += result.replacements;
      updated[key] = result.value;
    }
    return { value: updated, replacements };
  }

  return { value, replacements: 0 };
}

interface RawJsonFile {
  filePath: string;
  data: Record<string, unknown>;
  id: string | null;
}

async function loadRawJsonFiles(dir: string): Promise<RawJsonFile[]> {
  let filenames: string[];
  try {
    filenames = await readdir(dir);
  } catch {
    return [];
  }
  const entities: RawJsonFile[] = [];
  for (const f of filenames) {
    if (!f.endsWith(".json")) continue;
    try {
      const filePath = join(dir, f);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entities.push({
        filePath,
        data: parsed,
        id: typeof parsed.id === "string" ? parsed.id : null,
      });
    } catch {
      // skip unparseable files
    }
  }
  return entities;
}

async function loadRawJsonFile(filePath: string): Promise<RawJsonFile | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      filePath,
      data: parsed,
      id: typeof parsed.id === "string" ? parsed.id : null,
    };
  } catch {
    return null;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

async function collectMarkdownFiles(root: string, wrapDir: string): Promise<string[]> {
  const files = [
    ...await listMarkdownFiles(join(wrapDir, "handovers")),
    ...await listMarkdownFiles(join(root, "docs")),
  ];
  const readme = join(root, "README.md");
  try {
    await readFile(readme, "utf-8");
    files.push(readme);
  } catch {
    // README.md is optional for migration purposes.
  }
  return [...new Set(files)].sort();
}

function rel(root: string, filePath: string): string {
  return relative(root, filePath) || ".";
}

export async function handleMigrateNamespace(
  namespace: string,
  root: string,
  options: { dryRun?: boolean },
): Promise<CommandResult> {
  if (!NAMESPACE_REGEX.test(namespace)) {
    return {
      output: `Invalid namespace "${namespace}": must be 3-12 uppercase alphanumeric characters.`,
      errorCode: "invalid_input",
    };
  }

  const renames: Array<{ oldId: string; newId: string; type: "ticket" | "issue" }> = [];
  const refUpdates: string[] = [];
  const textUpdates: Array<{ file: string; replacements: number }> = [];

  const wrapDir = resolve(root, ".story");

  // Use withProjectLock for locking but read raw files directly
  // to handle legacy IDs that no longer pass schema validation.
  await withProjectLock(root, { strict: false }, async () => {
    const tickets = await loadRawJsonFiles(join(wrapDir, "tickets"));
    const issues = await loadRawJsonFiles(join(wrapDir, "issues"));
    const notes = await loadRawJsonFiles(join(wrapDir, "notes"));
    const lessons = await loadRawJsonFiles(join(wrapDir, "lessons"));
    const projectJson = (
      await Promise.all([
        loadRawJsonFile(join(wrapDir, "config.json")),
        loadRawJsonFile(join(wrapDir, "roadmap.json")),
      ])
    ).filter((file): file is RawJsonFile => file !== null);

    const renameMap = new Map<string, string>();

    for (const t of tickets) {
      if (t.id && isOldFormat(t.id)) {
        const newId = migrateId(t.id, namespace);
        renameMap.set(t.id, newId);
        renames.push({ oldId: t.id, newId, type: "ticket" });
      }
    }
    for (const i of issues) {
      if (i.id && isOldFormat(i.id)) {
        const newId = migrateId(i.id, namespace);
        renameMap.set(i.id, newId);
        renames.push({ oldId: i.id, newId, type: "issue" });
      }
    }

    for (const t of tickets) {
      const oldId = t.id;
      const newId = oldId ? renameMap.get(oldId) ?? migrateId(oldId, namespace) : oldId;
      const blockedBy = Array.isArray(t.data.blockedBy) ? (t.data.blockedBy as string[]) : [];
      const newBlockedBy = blockedBy.map((ref) => renameMap.get(ref) ?? migrateId(ref, namespace));
      const parentTicket = typeof t.data.parentTicket === "string" ? t.data.parentTicket : null;
      const newParent = parentTicket
        ? renameMap.get(parentTicket) ?? migrateId(parentTicket, namespace)
        : parentTicket;
      const crossNodeBlockedBy = Array.isArray(t.data.crossNodeBlockedBy)
        ? (t.data.crossNodeBlockedBy as string[])
        : undefined;
      const newCrossNode = crossNodeBlockedBy?.map((ref) =>
        migrateCrossNodeRef(ref, namespace),
      );

      const blockedByChanged = newBlockedBy.some((b, i) => b !== blockedBy[i]);
      const parentChanged = newParent !== parentTicket;
      const crossNodeChanged =
        newCrossNode && crossNodeBlockedBy &&
        newCrossNode.some((c, i) => c !== crossNodeBlockedBy[i]);
      const idChanged = !!newId && newId !== oldId;

      let updated: Record<string, unknown> = {
        ...t.data,
        ...(newId ? { id: newId } : {}),
        blockedBy: newBlockedBy,
        parentTicket: newParent,
        ...(newCrossNode ? { crossNodeBlockedBy: newCrossNode } : {}),
      };
      const textResult = migrateJsonStrings(updated, namespace);
      updated = textResult.value as Record<string, unknown>;

      if (textResult.replacements > 0) {
        textUpdates.push({ file: rel(root, t.filePath), replacements: textResult.replacements });
      }

      if (idChanged || blockedByChanged || parentChanged || crossNodeChanged || textResult.replacements > 0) {
        if (oldId && blockedByChanged) refUpdates.push(`${oldId}: blockedBy updated`);
        if (oldId && parentChanged) refUpdates.push(`${oldId}: parentTicket updated`);
        if (oldId && crossNodeChanged) refUpdates.push(`${oldId}: crossNodeBlockedBy updated`);

        if (options.dryRun) continue;

        const filePath = idChanged && newId ? join(wrapDir, "tickets", `${newId}.json`) : t.filePath;
        await guardPath(filePath, root);
        await atomicWrite(filePath, serializeJSON(updated));

        if (idChanged && oldId) {
          const oldPath = join(wrapDir, "tickets", `${oldId}.json`);
          try { await unlink(oldPath); } catch { /* may not exist */ }
        }
      }
    }

    for (const i of issues) {
      const oldId = i.id;
      const newId = oldId ? renameMap.get(oldId) ?? migrateId(oldId, namespace) : oldId;
      const relatedTickets = Array.isArray(i.data.relatedTickets) ? (i.data.relatedTickets as string[]) : [];
      const newRelated = relatedTickets.map((ref) => renameMap.get(ref) ?? migrateId(ref, namespace));
      const relatedChanged = newRelated.some((r, idx) => r !== relatedTickets[idx]);
      const idChanged = !!newId && newId !== oldId;

      let updated: Record<string, unknown> = {
        ...i.data,
        ...(newId ? { id: newId } : {}),
        relatedTickets: newRelated,
      };
      const textResult = migrateJsonStrings(updated, namespace);
      updated = textResult.value as Record<string, unknown>;

      if (textResult.replacements > 0) {
        textUpdates.push({ file: rel(root, i.filePath), replacements: textResult.replacements });
      }

      if (idChanged || relatedChanged || textResult.replacements > 0) {
        if (oldId && relatedChanged) refUpdates.push(`${oldId}: relatedTickets updated`);

        if (options.dryRun) continue;

        const filePath = idChanged && newId ? join(wrapDir, "issues", `${newId}.json`) : i.filePath;
        await guardPath(filePath, root);
        await atomicWrite(filePath, serializeJSON(updated));

        if (idChanged && oldId) {
          const oldPath = join(wrapDir, "issues", `${oldId}.json`);
          try { await unlink(oldPath); } catch { /* may not exist */ }
        }
      }
    }

    for (const file of [...notes, ...lessons, ...projectJson]) {
      const textResult = migrateJsonStrings(file.data, namespace);
      if (textResult.replacements === 0) continue;
      textUpdates.push({ file: rel(root, file.filePath), replacements: textResult.replacements });
      if (options.dryRun) continue;
      await guardPath(file.filePath, root);
      await atomicWrite(file.filePath, serializeJSON(textResult.value));
    }

    for (const filePath of await collectMarkdownFiles(root, wrapDir)) {
      const content = await readFile(filePath, "utf-8");
      const textResult = migrateTextMentions(content, namespace);
      if (textResult.replacements === 0) continue;
      textUpdates.push({ file: rel(root, filePath), replacements: textResult.replacements });
      if (options.dryRun) continue;
      await guardPath(filePath, root);
      await atomicWrite(filePath, textResult.text);
    }

    if (!options.dryRun && (renames.length > 0 || refUpdates.length > 0 || textUpdates.length > 0)) {
      await writeLocalConfig(root, { namespace });
    }
  });

  if (renames.length === 0 && refUpdates.length === 0 && textUpdates.length === 0) {
    return { output: "No old-format IDs found. Nothing to migrate." };
  }

  const lines = [
    options.dryRun ? "Dry run — no changes made." : "Migration complete.",
    "",
  ];

  if (renames.length > 0) {
    lines.push(
      `${renames.length} entities to rename:`,
      ...renames.map((r) => `  ${r.type}: ${r.oldId} → ${r.newId}`),
    );
  } else {
    lines.push("0 entities to rename.");
  }

  if (refUpdates.length > 0) {
    lines.push("", `${refUpdates.length} reference updates:`);
    for (const u of refUpdates) lines.push(`  ${u}`);
  }

  if (textUpdates.length > 0) {
    lines.push("", `${textUpdates.length} text file updates:`);
    for (const u of textUpdates) lines.push(`  ${u.file}: ${u.replacements} replacement(s)`);
  }

  if (!options.dryRun) {
    lines.push("", `Namespace set to "${namespace}" in .story/.local.json`);
  }

  return { output: lines.join("\n") };
}
