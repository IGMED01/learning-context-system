// @ts-check

export const CLI_SCHEMA_VERSION = "1.0.0";

/**
 * @param {string} command
 * @param {Record<string, unknown>} payload
 * @param {{
 *   schemaVersion?: string,
 *   status?: "ok" | "error",
 *   degraded?: boolean,
 *   warnings?: string[],
 *   configPath?: string,
 *   configFound?: boolean
 * }} [meta]
 */
export function buildCliJsonContract(command, payload, meta = {}) {
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
    ...payload
  };
}
