// @ts-check

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseChunkFile } from "../contracts/context-contracts.js";

/**
 * @param {string} filePath
 */
export async function loadChunkFile(filePath) {
  const resolvedPath = resolve(filePath);
  const raw = await readFile(resolvedPath, "utf8").catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read input file '${resolvedPath}': ${message}`);
  });

  return {
    path: resolvedPath,
    payload: parseChunkFile(raw, resolvedPath)
  };
}
