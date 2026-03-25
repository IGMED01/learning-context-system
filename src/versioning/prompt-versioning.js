// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").PromptVersion} PromptVersion
 * @typedef {import("../types/core-contracts.d.ts").PromptVersionHistory} PromptVersionHistory
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_PROMPTS_DIR = ".lcs/prompts";

/** @param {string} [baseDir] */
function promptsDir(baseDir) {
  return resolve(baseDir ?? process.cwd(), DEFAULT_PROMPTS_DIR);
}

/**
 * @param {string} name
 * @param {string} [baseDir]
 */
function promptFilePath(name, baseDir) {
  const slug = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return join(promptsDir(baseDir), `${slug}.json`);
}

/**
 * @param {string} name
 * @param {string} [baseDir]
 * @returns {Promise<PromptVersionHistory>}
 */
async function loadHistory(name, baseDir) {
  const filePath = promptFilePath(name, baseDir);

  try {
    const raw = await readFile(filePath, "utf8");
    return /** @type {PromptVersionHistory} */ (JSON.parse(raw));
  } catch {
    return { name, currentVersion: 0, versions: [] };
  }
}

/**
 * @param {PromptVersionHistory} history
 * @param {string} [baseDir]
 */
async function saveHistory(history, baseDir) {
  const filePath = promptFilePath(history.name, baseDir);
  await mkdir(promptsDir(baseDir), { recursive: true });
  await writeFile(filePath, JSON.stringify(history, null, 2) + "\n", "utf8");
}

/**
 * @param {string} name
 * @param {string} content
 * @param {Record<string, unknown>} [metadata]
 * @param {string} [baseDir]
 * @returns {Promise<PromptVersion>}
 */
export async function savePromptVersion(name, content, metadata, baseDir) {
  const history = await loadHistory(name, baseDir);
  const nextVersion = history.currentVersion + 1;

  /** @type {PromptVersion} */
  const version = {
    id: randomUUID(),
    name,
    version: nextVersion,
    content,
    createdAt: new Date().toISOString(),
    metadata
  };

  history.versions.push(version);
  history.currentVersion = nextVersion;

  await saveHistory(history, baseDir);
  return version;
}

/**
 * @param {string} name
 * @param {string} [baseDir]
 * @returns {Promise<PromptVersion | undefined>}
 */
export async function getCurrentPrompt(name, baseDir) {
  const history = await loadHistory(name, baseDir);
  return history.versions.at(-1);
}

/**
 * @param {string} name
 * @param {number} version
 * @param {string} [baseDir]
 * @returns {Promise<PromptVersion | undefined>}
 */
export async function getPromptVersion(name, version, baseDir) {
  const history = await loadHistory(name, baseDir);
  return history.versions.find((v) => v.version === version);
}

/**
 * @param {string} name
 * @param {string} [baseDir]
 * @returns {Promise<PromptVersionHistory>}
 */
export async function getPromptHistory(name, baseDir) {
  return loadHistory(name, baseDir);
}

/**
 * @param {string} name
 * @param {number} toVersion
 * @param {string} [baseDir]
 * @returns {Promise<PromptVersion | undefined>}
 */
export async function rollbackPrompt(name, toVersion, baseDir) {
  const history = await loadHistory(name, baseDir);
  const target = history.versions.find((v) => v.version === toVersion);

  if (!target) return undefined;

  const nextVersion = history.currentVersion + 1;
  /** @type {PromptVersion} */
  const rollbackVersion = {
    id: randomUUID(),
    name,
    version: nextVersion,
    content: target.content,
    createdAt: new Date().toISOString(),
    metadata: { rollbackFrom: history.currentVersion, rollbackTo: toVersion }
  };

  history.versions.push(rollbackVersion);
  history.currentVersion = nextVersion;

  await saveHistory(history, baseDir);
  return rollbackVersion;
}

/**
 * @param {string} [baseDir]
 * @returns {Promise<string[]>}
 */
export async function listPrompts(baseDir) {
  const dir = promptsDir(baseDir);

  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
