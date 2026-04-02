// @ts-check

/**
 * Minimal environment keys allowed for child-process execution.
 * Keeps process execution working while preventing secret leakage by default.
 */
const SAFE_ENV_KEYS = [
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
  "NODE_ENV",
  "NODE_OPTIONS",
  "npm_execpath",
  "npm_node_execpath",
  "npm_config_userconfig",
  "npm_config_cache",
  "npm_config_prefix",
  "npm_config_ignore_scripts",
  "npm_config_registry"
];

/**
 * Build a safe child-process environment:
 * - includes only allowlisted host vars
 * - applies explicit overrides
 * - allows explicit deletion (null/"")
 *
 * @param {Record<string, string | null | undefined>} [overrides]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildSafeEnv(overrides = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};

  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }

    if (value === null || value === "") {
      delete env[key];
      continue;
    }

    env[key] = value;
  }

  return env;
}

