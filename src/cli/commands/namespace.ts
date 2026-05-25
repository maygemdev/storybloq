import { NAMESPACE_REGEX } from "../../models/local-config.js";
import { loadLocalConfig, writeLocalConfig } from "../../core/local-config-loader.js";
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
  return {
    output: `Namespace set to "${namespace}". New tickets will be ${namespace}-T-001, issues ${namespace}-ISS-001.`,
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
