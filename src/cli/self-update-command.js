// @ts-check

/**
 * NEXUS Self-Update — Checks for and applies updates to the NEXUS/LCS CLI.
 *
 * Usage: lcs self-update [--check-only] [--force]
 */

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * @typedef {{
 *   status: "up-to-date" | "update-available" | "updated" | "failed",
 *   currentVersion: string,
 *   latestVersion: string,
 *   message: string
 * }} UpdateResult
 */

/**
 * @param {{ checkOnly?: boolean, force?: boolean, cwd?: string }} [opts]
 * @returns {Promise<UpdateResult>}
 */
export async function runSelfUpdate(opts = {}) {
  const cwd = opts.cwd || process.cwd();

  // Read current version from package.json
  let currentVersion = "0.0.0";
  try {
    const pkgPath = path.resolve(cwd, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    currentVersion = pkg.version || "0.0.0";
  } catch {
    // Can't read version
  }

  // Check npm registry for latest version
  let latestVersion = currentVersion;
  try {
    const npmCmd = process.platform === "win32" ? "cmd.exe" : "npm";
    const npmArgs = process.platform === "win32"
      ? ["/c", "npm.cmd", "view", "learning-context-system", "version"]
      : ["view", "learning-context-system", "version"];

    const result = await execFile(npmCmd, npmArgs, {
      windowsHide: true,
      timeout: 15000
    });
    latestVersion = (result.stdout || "").trim() || currentVersion;
  } catch {
    return {
      status: "failed",
      currentVersion,
      latestVersion: "unknown",
      message: "Could not check npm registry. Verify network connectivity."
    };
  }

  if (latestVersion === currentVersion && !opts.force) {
    return {
      status: "up-to-date",
      currentVersion,
      latestVersion,
      message: `Already on latest version (${currentVersion}).`
    };
  }

  if (opts.checkOnly) {
    return {
      status: "update-available",
      currentVersion,
      latestVersion,
      message: `Update available: ${currentVersion} → ${latestVersion}`
    };
  }

  // Perform update
  try {
    const npmCmd = process.platform === "win32" ? "cmd.exe" : "npm";
    const npmArgs = process.platform === "win32"
      ? ["/c", "npm.cmd", "install", "--save", `learning-context-system@${latestVersion}`]
      : ["install", "--save", `learning-context-system@${latestVersion}`];

    await execFile(npmCmd, npmArgs, {
      cwd,
      windowsHide: true,
      timeout: 60000
    });

    return {
      status: "updated",
      currentVersion,
      latestVersion,
      message: `Updated: ${currentVersion} → ${latestVersion}`
    };
  } catch (error) {
    return {
      status: "failed",
      currentVersion,
      latestVersion,
      message: `Update failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * @param {UpdateResult} result
 * @returns {string}
 */
export function formatUpdateResultAsText(result) {
  const icon = result.status === "up-to-date" ? "[ok]"
    : result.status === "updated" ? "[updated]"
    : result.status === "update-available" ? "[available]"
    : "[error]";
  return `${icon} ${result.message}`;
}
