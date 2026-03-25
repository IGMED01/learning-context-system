/**
 * Prompt Versioning — S8: Track prompt template evolution.
 *
 * Every prompt template has a name and version history.
 * Stored in `.lcs/prompts/{name}.json` as a version array.
 *
 * Supports:
 *   - Save a new version of a prompt
 *   - Get the current (latest) version
 *   - Get any historical version
 *   - List all prompt names
 *   - Rollback to a previous version
 */

import type { PromptVersion, PromptVersionHistory } from "../types/core-contracts.d.ts";

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_PROMPTS_DIR = ".lcs/prompts";

function promptsDir(baseDir?: string): string {
  return resolve(baseDir ?? process.cwd(), DEFAULT_PROMPTS_DIR);
}

function promptFilePath(name: string, baseDir?: string): string {
  const slug = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return join(promptsDir(baseDir), `${slug}.json`);
}

async function loadHistory(name: string, baseDir?: string): Promise<PromptVersionHistory> {
  const filePath = promptFilePath(name, baseDir);

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed as PromptVersionHistory;
  } catch {
    return { name, currentVersion: 0, versions: [] };
  }
}

async function saveHistory(history: PromptVersionHistory, baseDir?: string): Promise<void> {
  const filePath = promptFilePath(history.name, baseDir);
  await mkdir(promptsDir(baseDir), { recursive: true });
  await writeFile(filePath, JSON.stringify(history, null, 2) + "\n", "utf8");
}

export async function savePromptVersion(
  name: string,
  content: string,
  metadata?: Record<string, unknown>,
  baseDir?: string
): Promise<PromptVersion> {
  const history = await loadHistory(name, baseDir);
  const nextVersion = history.currentVersion + 1;

  const version: PromptVersion = {
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

export async function getCurrentPrompt(name: string, baseDir?: string): Promise<PromptVersion | undefined> {
  const history = await loadHistory(name, baseDir);
  return history.versions.at(-1);
}

export async function getPromptVersion(name: string, version: number, baseDir?: string): Promise<PromptVersion | undefined> {
  const history = await loadHistory(name, baseDir);
  return history.versions.find((v) => v.version === version);
}

export async function getPromptHistory(name: string, baseDir?: string): Promise<PromptVersionHistory> {
  return loadHistory(name, baseDir);
}

export async function rollbackPrompt(name: string, toVersion: number, baseDir?: string): Promise<PromptVersion | undefined> {
  const history = await loadHistory(name, baseDir);
  const target = history.versions.find((v) => v.version === toVersion);

  if (!target) return undefined;

  // Create a new version with the old content (audit trail)
  const nextVersion = history.currentVersion + 1;
  const rollbackVersion: PromptVersion = {
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

export async function listPrompts(baseDir?: string): Promise<string[]> {
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
