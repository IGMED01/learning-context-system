// @ts-check

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Atomic write helper:
 * 1) writes full payload to a unique tmp file in the same directory
 * 2) renames tmp file over final destination (atomic on NTFS/POSIX)
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @param {BufferEncoding} [encoding]
 */
export async function atomicWrite(filePath, content, encoding = "utf8") {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    if (typeof content === "string") {
      await writeFile(tmpPath, content, encoding);
    } else {
      await writeFile(tmpPath, content);
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

export { readFile, readdir, stat, unlink, writeFile };
