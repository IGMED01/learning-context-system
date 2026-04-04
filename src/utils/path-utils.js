// @ts-check

import path from "node:path";

/**
 * Resolve and validate a user-provided path within a workspace root.
 *
 * @param {string | undefined} candidate
 * @param {string} [workspaceRoot]
 * @param {string} [label]
 * @returns {string}
 */
export function resolveSafePathWithinWorkspace(
  candidate,
  workspaceRoot = process.cwd(),
  label = "path"
) {
  const root = path.resolve(workspaceRoot);

  if (!candidate || candidate.trim() === "" || candidate.trim() === ".") {
    return root;
  }

  const resolved = path.resolve(root, candidate);

  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    return resolved;
  }

  throw new Error(`${label} must stay inside workspace root: ${root}`);
}

