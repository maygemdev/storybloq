import { readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NAMESPACE_REGEX } from "../../models/local-config.js";
import { writeLocalConfig } from "../../core/local-config-loader.js";
import { withProjectLock, atomicWrite, serializeJSON } from "../../core/project-loader.js";
import type { CommandResult } from "../types.js";

const OLD_TICKET_ID_RE = /^T-\d+[a-z]?$/;
const OLD_ISSUE_ID_RE = /^ISS-\d+$/;
const OLD_CROSS_NODE_RE = /^([a-z][a-z0-9_-]{0,63}):(T-\d+[a-z]?|ISS-\d+)$/;

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

interface RawEntity {
  id: string;
  [key: string]: unknown;
}

async function loadRawJsonFiles(dir: string): Promise<RawEntity[]> {
  let filenames: string[];
  try {
    filenames = await readdir(dir);
  } catch {
    return [];
  }
  const entities: RawEntity[] = [];
  for (const f of filenames) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, f), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.id === "string") {
        entities.push(parsed as RawEntity);
      }
    } catch {
      // skip unparseable files
    }
  }
  return entities;
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

  const wrapDir = resolve(root, ".story");

  // Use withProjectLock for locking but read raw files directly
  // to handle legacy IDs that no longer pass schema validation.
  await withProjectLock(root, { strict: false }, async () => {
    const tickets = await loadRawJsonFiles(join(wrapDir, "tickets"));
    const issues = await loadRawJsonFiles(join(wrapDir, "issues"));

    const renameMap = new Map<string, string>();

    for (const t of tickets) {
      if (isOldFormat(t.id)) {
        const newId = migrateId(t.id, namespace);
        renameMap.set(t.id, newId);
        renames.push({ oldId: t.id, newId, type: "ticket" });
      }
    }
    for (const i of issues) {
      if (isOldFormat(i.id)) {
        const newId = migrateId(i.id, namespace);
        renameMap.set(i.id, newId);
        renames.push({ oldId: i.id, newId, type: "issue" });
      }
    }

    if (renames.length === 0 || options.dryRun) {
      return;
    }

    for (const t of tickets) {
      const newId = renameMap.get(t.id) ?? t.id;
      const blockedBy = Array.isArray(t.blockedBy) ? (t.blockedBy as string[]) : [];
      const newBlockedBy = blockedBy.map((ref) => renameMap.get(ref) ?? ref);
      const parentTicket = typeof t.parentTicket === "string" ? t.parentTicket : null;
      const newParent = parentTicket
        ? renameMap.get(parentTicket) ?? parentTicket
        : parentTicket;
      const crossNodeBlockedBy = Array.isArray(t.crossNodeBlockedBy)
        ? (t.crossNodeBlockedBy as string[])
        : undefined;
      const newCrossNode = crossNodeBlockedBy?.map((ref) =>
        migrateCrossNodeRef(ref, namespace),
      );

      const blockedByChanged = newBlockedBy.some((b, i) => b !== blockedBy[i]);
      const parentChanged = newParent !== parentTicket;
      const crossNodeChanged =
        newCrossNode && crossNodeBlockedBy &&
        newCrossNode.some((c, i) => c !== crossNodeBlockedBy[i]);
      const idChanged = newId !== t.id;

      if (idChanged || blockedByChanged || parentChanged || crossNodeChanged) {
        if (blockedByChanged) refUpdates.push(`${t.id}: blockedBy updated`);
        if (parentChanged) refUpdates.push(`${t.id}: parentTicket updated`);
        if (crossNodeChanged) refUpdates.push(`${t.id}: crossNodeBlockedBy updated`);

        const updated = {
          ...t,
          id: newId,
          blockedBy: newBlockedBy,
          parentTicket: newParent,
          ...(newCrossNode ? { crossNodeBlockedBy: newCrossNode } : {}),
        };
        const filePath = join(wrapDir, "tickets", `${newId}.json`);
        await atomicWrite(filePath, serializeJSON(updated));

        if (idChanged) {
          const oldPath = join(wrapDir, "tickets", `${t.id}.json`);
          try { await unlink(oldPath); } catch { /* may not exist */ }
        }
      }
    }

    for (const i of issues) {
      const newId = renameMap.get(i.id) ?? i.id;
      const relatedTickets = Array.isArray(i.relatedTickets) ? (i.relatedTickets as string[]) : [];
      const newRelated = relatedTickets.map((ref) => renameMap.get(ref) ?? ref);
      const relatedChanged = newRelated.some((r, idx) => r !== relatedTickets[idx]);
      const idChanged = newId !== i.id;

      if (idChanged || relatedChanged) {
        if (relatedChanged) refUpdates.push(`${i.id}: relatedTickets updated`);

        const updated = {
          ...i,
          id: newId,
          relatedTickets: newRelated,
        };
        const filePath = join(wrapDir, "issues", `${newId}.json`);
        await atomicWrite(filePath, serializeJSON(updated));

        if (idChanged) {
          const oldPath = join(wrapDir, "issues", `${i.id}.json`);
          try { await unlink(oldPath); } catch { /* may not exist */ }
        }
      }
    }

    await writeLocalConfig(root, { namespace });
  });

  if (renames.length === 0) {
    return { output: "No old-format IDs found. Nothing to migrate." };
  }

  const lines = [
    options.dryRun ? "Dry run — no changes made." : "Migration complete.",
    "",
    `${renames.length} entities to rename:`,
    ...renames.map((r) => `  ${r.type}: ${r.oldId} → ${r.newId}`),
  ];

  if (refUpdates.length > 0) {
    lines.push("", `${refUpdates.length} reference updates:`);
    for (const u of refUpdates) lines.push(`  ${u}`);
  }

  if (!options.dryRun) {
    lines.push("", `Namespace set to "${namespace}" in .story/.local.json`);
  }

  return { output: lines.join("\n") };
}
