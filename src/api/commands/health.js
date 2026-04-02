// @ts-check

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { defaultProjectConfig, parseProjectConfig } from "../../contracts/config-contracts.js";
import { registerCommand } from "../../core/command-registry.js";
import { resolveEngramConfig } from "../../memory/engram-client.js";
import { runProjectDoctor } from "../../system/project-ops.js";
import { jsonResponse } from "../router.js";

/**
 * @param {string} targetPath
 */
async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 */
function listAvailableLlmProviders(cwd) {
  /** @type {string[]} */
  const providers = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push("anthropic");
  }
  if (process.env.OPENAI_API_KEY) {
    providers.push("openai");
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.push("openrouter");
  }
  if (process.env.GROQ_API_KEY) {
    providers.push("groq");
  }

  return providers;
}

/**
 * @param {string} cwd
 */
async function resolveOverallHealthFromDoctor(cwd) {
  const configPath = path.join(cwd, "learning-context.config.json");
  const configExists = await exists(configPath);
  /** @type {{ found: boolean, path: string, config: ReturnType<typeof defaultProjectConfig>, configError?: string }} */
  const configInfo = {
    found: configExists,
    path: configPath,
    config: defaultProjectConfig()
  };

  if (configExists) {
    try {
      const raw = await readFile(configPath, "utf8");
      configInfo.config = parseProjectConfig(raw, configPath);
    } catch (error) {
      configInfo.configError = error instanceof Error ? error.message : String(error);
    }
  }

  const doctor = await runProjectDoctor({
    cwd,
    configInfo: {
      found: configInfo.found,
      path: configInfo.path,
      config: configInfo.config
    },
    configError: configInfo.configError
  });
  const fail = doctor.summary?.fail ?? 0;
  const warn = doctor.summary?.warn ?? 0;

  return {
    status: fail > 0 ? "unhealthy" : warn > 0 ? "degraded" : "healthy",
    doctor: {
      summary: doctor.summary
    }
  };
}

/**
 * @param {string} [cwd]
 */
export async function getHealthStatus(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  /** @type {Record<string, { status: "ok" | "degraded" | "unavailable", detail?: string, [key: string]: unknown }>} */
  const checks = {};

  const memoryPath = path.join(root, ".lcs", "memory");
  checks.memory = (await exists(memoryPath))
    ? { status: "ok", path: memoryPath }
    : { status: "degraded", detail: `Memory directory not found: ${memoryPath}` };

  const axiomsPath = path.join(root, ".lcs", "axioms");
  checks.axioms = (await exists(axiomsPath))
    ? { status: "ok", path: axiomsPath }
    : { status: "degraded", detail: `Axioms directory not found: ${axiomsPath}` };

  const engramConfig = resolveEngramConfig({ cwd: root });
  checks.engram = (await exists(engramConfig.binaryPath))
    ? { status: "ok", binary: engramConfig.binaryPath }
    : { status: "unavailable", detail: `Engram binary not found: ${engramConfig.binaryPath}` };

  const providers = listAvailableLlmProviders(root);
  checks.llmProviders = {
    status: providers.length ? "ok" : "unavailable",
    providers
  };

  const doctorOverall = await resolveOverallHealthFromDoctor(root);

  return {
    schemaVersion: "1.0.0",
    status: doctorOverall.status,
    timestamp: new Date().toISOString(),
    checks,
    doctor: doctorOverall.doctor
  };
}

registerCommand({
  name: "health.status",
  method: "GET",
  path: "/api/health",
  handler: async (req) => {
    const headerCwd =
      typeof req.headers?.["x-data-dir"] === "string" && req.headers["x-data-dir"].trim()
        ? req.headers["x-data-dir"].trim()
        : process.cwd();
    const health = await getHealthStatus(headerCwd);
    const httpStatus = health.status === "unhealthy" ? 503 : 200;
    return jsonResponse(httpStatus, health);
  }
});
