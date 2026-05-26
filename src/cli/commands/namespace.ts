import { NAMESPACE_REGEX } from "../../models/local-config.js";
import { loadLocalConfig, writeLocalConfig } from "../../core/local-config-loader.js";
import { loadProject } from "../../core/project-loader.js";
import {
  clearLocalNamespace,
  summarizeNamespaces,
} from "../../core/namespace-scope.js";
import { branchNamespaceWarning } from "../../core/namespace-guard.js";
import { gitHead } from "../../autonomous/git-inspector.js";
import { detectBranchNamespaceAffinity } from "../../autonomous/branch-affinity.js";
import type { CommandResult } from "../types.js";

export async function handleNamespaceSet(
  namespace: string,
  root: string,
): Promise<CommandResult> {
  if (!NAMESPACE_REGEX.test(namespace)) {
    return {
      output: `Invalid namespace "${namespace}": must be 3-12 uppercase alphanumeric characters.`,
      errorCode: "invalid_input",
    };
  }
  await writeLocalConfig(root, { namespace });
  const warning = await branchNamespaceWarning(root, namespace);
  return {
    output: [
      `Namespace set to "${namespace}". New tickets will be ${namespace}-T-001, issues ${namespace}-ISS-001.`,
      warning,
    ].filter(Boolean).join("\n"),
  };
}

export async function handleNamespaceGet(
  root: string,
): Promise<CommandResult> {
  try {
    const config = await loadLocalConfig(root);
    return { output: `Current namespace: ${config.namespace}` };
  } catch {
    return {
      output: "No namespace configured. Run: storybloq namespace set <NS>",
      errorCode: "not_found",
    };
  }
}

export async function handleNamespaceList(
  root: string,
): Promise<CommandResult> {
  const { state } = await loadProject(root);
  const summaries = summarizeNamespaces(state);
  if (summaries.length === 0) {
    return { output: "No namespaces found in tickets or issues." };
  }
  const lines = [
    "| Namespace | Tickets | Open | In progress | Issues | Open issues |",
    "|-----------|---------|------|-------------|--------|-------------|",
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.namespace} | ${summary.tickets} | ${summary.openTickets} | ${summary.inProgressTickets} | ${summary.issues} | ${summary.openIssues} |`,
    );
  }
  return { output: lines.join("\n") };
}

export async function handleNamespaceCheck(
  root: string,
): Promise<CommandResult> {
  let active: string | null = null;
  try {
    active = (await loadLocalConfig(root)).namespace;
  } catch {
    active = null;
  }

  const head = await gitHead(root);
  const affinity = head.ok
    ? detectBranchNamespaceAffinity(head.data.branch)
    : { status: "none" as const, namespace: null, namespaces: [], branch: null, matchedIds: [] };

  const lines = [
    `Active namespace: ${active ?? "not configured"}`,
    `Current branch: ${affinity.branch ?? "unknown"}`,
  ];

  if (affinity.status === "matched" && affinity.namespace) {
    lines.push(`Branch namespace: ${affinity.namespace}`);
    if (active && active !== affinity.namespace) {
      lines.push(`Status: mismatch. Run \`storybloq namespace set ${affinity.namespace}\` or switch branches.`);
    } else if (!active) {
      lines.push(`Status: namespace not configured. Run \`storybloq namespace set ${affinity.namespace}\`.`);
    } else {
      lines.push("Status: ok.");
    }
  } else if (affinity.status === "ambiguous") {
    lines.push(`Branch namespace: ambiguous (${affinity.namespaces.join(", ")})`);
    lines.push("Status: warning. Branch contains multiple Storybloq namespaces.");
  } else {
    lines.push("Branch namespace: none detected");
    lines.push(active ? "Status: ok." : "Status: namespace not configured.");
  }

  return { output: lines.join("\n") };
}

export async function handleNamespaceClear(
  root: string,
  force: boolean,
): Promise<CommandResult> {
  if (!force) {
    return {
      output: "Refusing to clear namespace without --force.",
      errorCode: "invalid_input",
    };
  }
  await clearLocalNamespace(root);
  return { output: "Namespace cleared." };
}
