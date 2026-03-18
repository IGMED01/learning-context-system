import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function writeTextFile(filePath: string, content: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, content, "utf8");
  return resolvedPath;
}
