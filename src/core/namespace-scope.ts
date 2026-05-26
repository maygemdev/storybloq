import { rm } from "node:fs/promises";
import { join } from "node:path";
import { NAMESPACE_REGEX } from "../models/local-config.js";
import { extractNamespace } from "../models/types.js";
import type { Note } from "../models/note.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import { ProjectLoaderError } from "./errors.js";
import { ProjectState } from "./project-state.js";
import { tryLoadLocalConfig } from "./local-config-loader.js";

export interface NamespaceScope {
  readonly namespace: string | null;
  readonly mode: "active" | "explicit" | "all";
}

export interface NamespaceScopeOptions {
  readonly namespace?: string | null;
  readonly allNamespaces?: boolean;
  readonly requireNamespace?: boolean;
}

export interface NamespaceSummary {
  readonly namespace: string;
  readonly tickets: number;
  readonly openTickets: number;
  readonly inProgressTickets: number;
  readonly issues: number;
  readonly openIssues: number;
}

export function validateNamespaceValue(namespace: string): void {
  if (!NAMESPACE_REGEX.test(namespace)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid namespace "${namespace}": must be 3-12 uppercase alphanumeric characters.`,
    );
  }
}

export async function resolveNamespaceScope(
  root: string,
  options: NamespaceScopeOptions = {},
): Promise<NamespaceScope> {
  if (options.namespace && options.allNamespaces) {
    throw new ProjectLoaderError(
      "invalid_input",
      "Use either --namespace or --all-namespaces, not both.",
    );
  }

  if (options.allNamespaces) return { namespace: null, mode: "all" };

  if (options.namespace) {
    validateNamespaceValue(options.namespace);
    return { namespace: options.namespace, mode: "explicit" };
  }

  const local = await tryLoadLocalConfig(root);
  if (local) return { namespace: local.namespace, mode: "active" };

  if (options.requireNamespace) {
    throw new ProjectLoaderError(
      "not_found",
      "No namespace configured. Run `storybloq namespace set <NS>` first or use a namespaced target ID.",
    );
  }

  return { namespace: null, mode: "all" };
}

export function ticketInNamespace(ticket: Ticket, namespace: string): boolean {
  return extractNamespace(ticket.id) === namespace;
}

export function issueInNamespace(issue: Issue, namespace: string): boolean {
  return extractNamespace(issue.id) === namespace;
}

export function noteInNamespace(note: Note, namespace: string): boolean {
  const noteNamespace = (note as { namespace?: unknown }).namespace;
  return noteNamespace == null || noteNamespace === namespace;
}

export function scopeProjectState(
  state: ProjectState,
  scope: NamespaceScope,
): ProjectState {
  if (scope.mode === "all" || !scope.namespace) return state;
  const namespace = scope.namespace;
  return new ProjectState({
    tickets: state.tickets.filter((ticket) => ticketInNamespace(ticket, namespace)),
    issues: state.issues.filter((issue) => issueInNamespace(issue, namespace)),
    notes: state.notes.filter((note) => noteInNamespace(note, namespace)),
    lessons: [...state.lessons],
    roadmap: state.roadmap,
    config: state.config,
    handoverFilenames: [...state.handoverFilenames],
  });
}

export function summarizeNamespaces(state: ProjectState): NamespaceSummary[] {
  const summaries = new Map<string, NamespaceSummary>();
  const ensure = (namespace: string): NamespaceSummary => {
    const existing = summaries.get(namespace);
    if (existing) return existing;
    const summary = {
      namespace,
      tickets: 0,
      openTickets: 0,
      inProgressTickets: 0,
      issues: 0,
      openIssues: 0,
    };
    summaries.set(namespace, summary);
    return summary;
  };

  for (const ticket of state.leafTickets) {
    const namespace = extractNamespace(ticket.id);
    if (!namespace) continue;
    const current = ensure(namespace);
    summaries.set(namespace, {
      ...current,
      tickets: current.tickets + 1,
      openTickets: current.openTickets + (ticket.status !== "complete" ? 1 : 0),
      inProgressTickets: current.inProgressTickets + (ticket.status === "inprogress" ? 1 : 0),
    });
  }

  for (const issue of state.issues) {
    const namespace = extractNamespace(issue.id);
    if (!namespace) continue;
    const current = ensure(namespace);
    summaries.set(namespace, {
      ...current,
      issues: current.issues + 1,
      openIssues: current.openIssues + (issue.status !== "resolved" ? 1 : 0),
    });
  }

  return [...summaries.values()].sort((a, b) =>
    a.namespace.localeCompare(b.namespace),
  );
}

export function formatNamespaceScopePrefix(
  scope: NamespaceScope,
  state: ProjectState,
): string {
  if (scope.mode === "all" || !scope.namespace) {
    return "Namespace: all";
  }

  const otherCount = summarizeNamespaces(state)
    .filter((summary) => summary.namespace !== scope.namespace)
    .length;
  const suffix = otherCount > 0
    ? `\nOther namespaces: ${otherCount} namespace${otherCount === 1 ? "" : "s"} hidden. Use --all-namespaces to include them.`
    : "";
  return `Active namespace: ${scope.namespace}${suffix}`;
}

export function namespacesForTargetIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(extractNamespace).filter((ns): ns is string => !!ns))].sort();
}

export function clearLocalNamespace(root: string): Promise<void> {
  return rm(join(root, ".story", ".local.json"), { force: true });
}
