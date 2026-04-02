// @ts-check

/**
 * @typedef {{
 *   name?: string,
 *   method: string,
 *   path: string,
 *   handler: (req: import("../types/core-contracts.d.ts").ApiRequest) => Promise<import("../types/core-contracts.d.ts").ApiResponse>,
 *   isAvailable?: () => boolean | Promise<boolean>
 * }} CommandDef
 */

/** @type {Map<string, CommandDef>} */
const registry = new Map();

/**
 * @param {string} method
 */
function normalizeMethod(method) {
  return String(method ?? "").trim().toUpperCase();
}

/**
 * @param {string} value
 */
function normalizePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "/";
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
}

/**
 * @param {string} path
 */
function tokenize(path) {
  const normalized = normalizePath(path);
  return normalized.split("/").filter(Boolean);
}

/**
 * @param {string} pattern
 * @param {string} candidate
 * @returns {Record<string, string> | null}
 */
function matchPath(pattern, candidate) {
  const patternSegments = tokenize(pattern);
  const candidateSegments = tokenize(candidate);

  if (patternSegments.length !== candidateSegments.length) {
    return null;
  }

  /** @type {Record<string, string>} */
  const params = {};

  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    const actual = candidateSegments[index];

    if (expected.startsWith(":")) {
      const key = expected.slice(1).trim();
      if (!key) {
        return null;
      }
      params[key] = actual;
      continue;
    }

    if (expected !== actual) {
      return null;
    }
  }

  return params;
}

/**
 * @param {CommandDef} def
 */
export function registerCommand(def) {
  if (!def || typeof def !== "object") {
    throw new Error("Command definition is required.");
  }

  const method = normalizeMethod(def.method);
  const path = normalizePath(def.path);

  if (!method) {
    throw new Error("Command method is required.");
  }

  if (typeof def.handler !== "function") {
    throw new Error(`Command handler must be a function (${method} ${path}).`);
  }

  const key = `${method}:${path}`;
  if (registry.has(key)) {
    throw new Error(`Command already registered: ${key}`);
  }

  registry.set(key, {
    ...def,
    method,
    path
  });
}

/**
 * @param {string} method
 * @param {string} path
 */
export function getCommand(method, path) {
  return registry.get(`${normalizeMethod(method)}:${normalizePath(path)}`);
}

/**
 * @param {string} method
 * @param {string} path
 * @returns {Promise<{ command: CommandDef, params: Record<string, string> } | null>}
 */
export async function findCommand(method, path) {
  const normalizedMethod = normalizeMethod(method);
  const normalizedPath = normalizePath(path);

  for (const command of registry.values()) {
    if (command.method !== normalizedMethod) {
      continue;
    }

    const params = matchPath(command.path, normalizedPath);
    if (!params) {
      continue;
    }

    if (typeof command.isAvailable === "function") {
      const available = await command.isAvailable();
      if (!available) {
        return null;
      }
    }

    return {
      command,
      params
    };
  }

  return null;
}

/**
 * @param {string} method
 * @param {string} path
 */
export async function isCommandAvailable(method, path) {
  const match = await findCommand(method, path);
  return Boolean(match);
}

export function getAllCommands() {
  return [...registry.values()];
}

/**
 * Test utility: clear in-memory registry.
 */
export function clearCommandRegistry() {
  registry.clear();
}
