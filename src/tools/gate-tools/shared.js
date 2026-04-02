// @ts-check

import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const GATE_TIMEOUT_MS = 60000;

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMP",
  "TEMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "TERM",
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "LANG",
  "LC_ALL",
  "npm_execpath",
  "npm_node_execpath",
  "npm_config_userconfig",
  "npm_config_cache",
  "npm_config_prefix",
  "npm_config_ignore_scripts",
  "npm_config_registry"
];

/**
 * Build a minimal environment for code-gate child processes.
 * Keep only execution-critical variables and explicit overrides.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildCodeGateEnv(overrides = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};

  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    } else {
      delete env[key];
    }
  }

  return env;
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readPackageJson(cwd) {
  try {
    const raw = await readFile(path.join(cwd, "package.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   command: string,
 *   args: string[],
 *   cwd: string,
 *   timeoutMs?: number,
 *   envOverrides?: Record<string, string>
 * }} input
 * @returns {Promise<string>}
 */
export async function runGateCommand(input) {
  const { command, args, cwd, timeoutMs = GATE_TIMEOUT_MS, envOverrides = {} } = input;
  const result = await execFile(command, args, {
    cwd,
    timeout: timeoutMs,
    shell: false,
    env: buildCodeGateEnv(envOverrides)
  });

  return [String(result.stdout ?? ""), String(result.stderr ?? "")].join("\n").trim();
}
