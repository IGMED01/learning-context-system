/**
 * Model Config Versioning — S8: Track model parameter changes.
 *
 * Stores which model, parameters, and when they changed.
 * Persisted in `.lcs/model-config.json`.
 */

import type { ModelVersionConfig } from "../types/core-contracts.d.ts";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const DEFAULT_CONFIG_PATH = ".lcs/model-config.json";

interface ModelConfigStore {
  current: ModelVersionConfig;
  history: ModelVersionConfig[];
}

function configPath(baseDir?: string): string {
  return resolve(baseDir ?? process.cwd(), DEFAULT_CONFIG_PATH);
}

const DEFAULT_MODEL_CONFIG: ModelVersionConfig = {
  modelId: "claude-opus-4-6",
  temperature: 0,
  maxTokens: 4096,
  version: 1,
  activeSince: new Date().toISOString()
};

async function loadStore(baseDir?: string): Promise<ModelConfigStore> {
  try {
    const raw = await readFile(configPath(baseDir), "utf8");
    return JSON.parse(raw) as ModelConfigStore;
  } catch {
    return {
      current: DEFAULT_MODEL_CONFIG,
      history: [DEFAULT_MODEL_CONFIG]
    };
  }
}

async function saveStore(store: ModelConfigStore, baseDir?: string): Promise<void> {
  const filePath = configPath(baseDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export async function getCurrentModelConfig(baseDir?: string): Promise<ModelVersionConfig> {
  const store = await loadStore(baseDir);
  return store.current;
}

export async function updateModelConfig(
  updates: Partial<Omit<ModelVersionConfig, "version" | "activeSince">>,
  baseDir?: string
): Promise<ModelVersionConfig> {
  const store = await loadStore(baseDir);

  const newConfig: ModelVersionConfig = {
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

export async function getModelConfigHistory(baseDir?: string): Promise<ModelVersionConfig[]> {
  const store = await loadStore(baseDir);
  return [...store.history].reverse();
}

export async function rollbackModelConfig(toVersion: number, baseDir?: string): Promise<ModelVersionConfig | undefined> {
  const store = await loadStore(baseDir);
  const target = store.history.find((c) => c.version === toVersion);

  if (!target) return undefined;

  const newConfig: ModelVersionConfig = {
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
