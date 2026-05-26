import { ProjectLoaderError } from "./errors.js";
import { gitHead } from "../autonomous/git-inspector.js";
import { detectBranchNamespaceAffinity } from "../autonomous/branch-affinity.js";

export async function assertBranchNamespaceAllows(
  root: string,
  namespace: string,
  operation: string,
): Promise<void> {
  const head = await gitHead(root);
  if (!head.ok) return;

  const affinity = detectBranchNamespaceAffinity(head.data.branch);
  if (affinity.status !== "matched" || !affinity.namespace) return;
  if (affinity.namespace === namespace) return;

  throw new ProjectLoaderError(
    "conflict",
    `${operation} is blocked: current branch "${affinity.branch}" is scoped to namespace ${affinity.namespace}, but active namespace is ${namespace}. Run \`storybloq namespace set ${affinity.namespace}\` or switch branches.`,
  );
}

export async function branchNamespaceWarning(
  root: string,
  namespace: string,
): Promise<string | null> {
  const head = await gitHead(root);
  if (!head.ok) return null;
  const affinity = detectBranchNamespaceAffinity(head.data.branch);
  if (affinity.status === "ambiguous") {
    return `Warning: branch "${affinity.branch}" contains IDs from multiple namespaces (${affinity.namespaces.join(", ")}); namespace was still set.`;
  }
  if (affinity.status === "matched" && affinity.namespace && affinity.namespace !== namespace) {
    return `Warning: branch "${affinity.branch}" appears scoped to ${affinity.namespace}, but namespace was set to ${namespace}.`;
  }
  return null;
}
