import type { CliContractMeta } from "../types/core-contracts.d.ts";

export const CLI_SCHEMA_VERSION = "1.0.0";

export function buildCliJsonContract(
  command: string,
  payload: object,
  meta: CliContractMeta = {}
): object {
  return {
    schemaVersion: meta.schemaVersion ?? CLI_SCHEMA_VERSION,
    command,
    status: meta.status ?? "ok",
    degraded: meta.degraded === true,
    warnings: meta.warnings ?? [],
    config: {
      found: meta.configFound === true,
      path: meta.configPath ?? ""
    },
    meta: {
      generatedAt: meta.generatedAt ?? "",
      cwd: meta.cwd ?? "",
      durationMs: meta.durationMs ?? 0,
      debug: meta.debug === true,
      scanStats: meta.scanStats ?? null
    },
    ...payload
  };
}
