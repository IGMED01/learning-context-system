// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ModelVersionConfig} ModelVersionConfig
 * @typedef {{ current: ModelVersionConfig, history: ModelVersionConfig[] }} ModelConfigStore
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const DEFAULT_CONFIG_PATH = ".lcs/model-config.json";

/** @param {string} [baseDir] */
function configPath(baseDir) {
  return resolve(baseDir ?? process.cwd(), DEFAULT_CONFIG_PATH);
}

/** @type {ModelVersionConfig} */
const DEFAULT_MODEL_CONFIG = {
  modelId: "claude-opus-4-6",
  temperature: 0,
  maxTokens: 4096,
  version: 1,
  activeSince: new Date().toISOString()
};

/**
 * @param {string} [baseDir]
 * @returns {Promise<ModelConfigStore>}
 */
async function loadStore(baseDir) {
  try {
    const raw = await readFile(configPath(baseDir), "utf8");
    return /** @type {ModelConfigStore} */ (JSON.parse(raw));
  } catch {
    return {
      current: DEFAULT_MODEL_CONFIG,
      history: [DEFAULT_MODEL_CONFIG]
    };
  }
}

/**
 * @param {ModelConfigStore} store
 * @param {string} [baseDir]
 */
async function saveStore(store, baseDir) {
  const filePath = configPath(baseDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/**
 * @param {string} [baseDir]
 * @returns {Promise<ModelVersionConfig>}
 */
export async function getCurrentModelConfig(baseDir) {
  const store = await loadStore(baseDir);
  return store.current;
}

/**
 * @param {Partial<Omit<ModelVersionConfig, "version" | "activeSince">>} updates
 * @param {string} [baseDir]
 * @returns {Promise<ModelVersionConfig>}
 */
export async function updateModelConfig(updates, baseDir) {
  const store = await loadStore(baseDir);

  /** @type {ModelVersionConfig} */
  const newConfig = {
    modelId: updates.modelId ?? store.current.modelId,
    temperature: updates.temperature ?? store.current.temperature,
    maxTokens: updates.maxTokens ?? store.current.maxTokens,
    version: store.current.version + 1,
    activeSince: new Date().toISOString()
  };

  store.history.push(newConfig);
  store.current = newConfig;

  await saveStore(store, baseDir);
  return newConfig;
}

/**
 * @param {string} [baseDir]
 * @returns {Promise<ModelVersionConfig[]>}
 */
export async function getModelConfigHistory(baseDir) {
  const store = await loadStore(baseDir);
  return [...store.history].reverse();
}

/**
 * @param {number} toVersion
 * @param {string} [baseDir]
 * @returns {Promise<ModelVersionConfig | undefined>}
 */
export async function rollbackModelConfig(toVersion, baseDir) {
  const store = await loadStore(baseDir);
  const target = store.history.find((c) => c.version === toVersion);

  if (!target) return undefined;

  /** @type {ModelVersionConfig} */
  const newConfig = {
    modelId: target.modelId,
    temperature: target.temperature,
    maxTokens: target.maxTokens,
    version: store.current.version + 1,
    activeSince: new Date().toISOString()
  };

  store.history.push(newConfig);
  store.current = newConfig;

  await saveStore(store, baseDir);
  return newConfig;
}
