// @ts-check

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { defaultProjectConfig, parseProjectConfig } from "../../contracts/config-contracts.js";
import { registerCommand } from "../../core/command-registry.js";
import { resolveEngramConfig } from "../../memory/engram-client.js";
import { runProjectDoctor } from "../../system/project-ops.js";
import { resolveSafePathWithinWorkspace } from "../../utils/path-utils.js";
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
 * @param {unknown} value
 */
function parseBoolean(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

/**
 * @param {string | undefined} raw
 */
function parseSecretList(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\r\n,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * @param {string | undefined} filePath
 */
async function readSecretEntriesFromFile(filePath) {
  const normalized = String(filePath ?? "").trim();
  if (!normalized) {
    return {
      entries: [],
      sourceConfigured: false,
      issue: ""
    };
  }

  try {
    const raw = await readFile(normalized, "utf8");
    const entries = parseSecretList(raw);
    return {
      entries,
      sourceConfigured: true,
      issue: entries.length ? "" : "empty"
    };
  } catch {
    return {
      entries: [],
      sourceConfigured: true,
      issue: "unreadable"
    };
  }
}

/**
 * @param {string} baseStatus
 * @param {"ok" | "degraded" | "unavailable"} checkStatus
 */
function mergeStatus(baseStatus, checkStatus) {
  const rank = {
    healthy: 0,
    degraded: 1,
    unhealthy: 2
  };
  const mapped = checkStatus === "ok" ? "healthy" : checkStatus === "degraded" ? "degraded" : "unhealthy";

  return rank[mapped] > rank[baseStatus] ? mapped : baseStatus;
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
    ? { status: "ok" }
    : { status: "degraded", detail: "Memory directory not found." };

  const axiomsPath = path.join(root, ".lcs", "axioms");
  checks.axioms = (await exists(axiomsPath))
    ? { status: "ok" }
    : { status: "degraded", detail: "Axioms directory not found." };

  const engramConfig = resolveEngramConfig({ cwd: root });
  checks.engram = (await exists(engramConfig.binaryPath))
    ? { status: "ok" }
    : { status: "unavailable", detail: "Engram binary not found." };

  const providers = listAvailableLlmProviders(root);
  checks.llmProviders = {
    status: providers.length ? "ok" : "unavailable",
    providers
  };

  const requireAuth = process.env.LCS_API_REQUIRE_AUTH !== "false";
  const apiKeysFromEnv = [
    ...parseSecretList(process.env.LCS_API_KEY),
    ...parseSecretList(process.env.LCS_API_KEYS)
  ];
  const apiKeyFileCandidates = await Promise.all([
    readSecretEntriesFromFile(process.env.LCS_API_KEY_FILE),
    readSecretEntriesFromFile(process.env.LCS_API_KEYS_FILE)
  ]);
  const apiKeysFromFile = apiKeyFileCandidates.flatMap((candidate) => candidate.entries);
  const apiKeyFileIssues = apiKeyFileCandidates
    .filter((candidate) => candidate.issue)
    .map((candidate) => candidate.issue);
  const jwtFromEnv = String(process.env.LCS_API_JWT_SECRET ?? "").trim();
  const jwtFromFile = await readSecretEntriesFromFile(process.env.LCS_API_JWT_SECRET_FILE);
  const authCredentialCount =
    apiKeysFromEnv.length + apiKeysFromFile.length + (jwtFromEnv || jwtFromFile.entries.length ? 1 : 0);
  const secretsStatus = !requireAuth
    ? "ok"
    : authCredentialCount > 0
      ? apiKeyFileIssues.length || jwtFromFile.issue
        ? "degraded"
        : "ok"
      : "unavailable";

  checks.secrets = {
    status: secretsStatus,
    authRequired: requireAuth,
    apiKeyConfigured: apiKeysFromEnv.length + apiKeysFromFile.length > 0,
    jwtConfigured: Boolean(jwtFromEnv || jwtFromFile.entries.length),
    ...(apiKeyFileIssues.length || jwtFromFile.issue
      ? {
          detail: "Some configured secret files are unreadable or empty."
        }
      : {})
  };

  const tlsEnabled =
    parseBoolean(process.env.LCS_API_TLS_ENABLED) ||
    Boolean(
      String(process.env.LCS_API_TLS_KEY ?? "").trim() ||
        String(process.env.LCS_API_TLS_CERT ?? "").trim() ||
        String(process.env.LCS_API_TLS_KEY_FILE ?? "").trim() ||
        String(process.env.LCS_API_TLS_CERT_FILE ?? "").trim()
    );
  const tlsKeyConfigured =
    Boolean(String(process.env.LCS_API_TLS_KEY ?? "").trim()) ||
    (await readSecretEntriesFromFile(process.env.LCS_API_TLS_KEY_FILE)).entries.length > 0;
  const tlsCertConfigured =
    Boolean(String(process.env.LCS_API_TLS_CERT ?? "").trim()) ||
    (await readSecretEntriesFromFile(process.env.LCS_API_TLS_CERT_FILE)).entries.length > 0;
  checks.tls = !tlsEnabled
    ? { status: "degraded", detail: "TLS is disabled." }
    : tlsKeyConfigured && tlsCertConfigured
      ? { status: "ok" }
      : { status: "unavailable", detail: "TLS enabled but key/cert material is incomplete." };

  const doctorOverall = await resolveOverallHealthFromDoctor(root);
  let status = doctorOverall.status;

  if (checks.memory.status !== "ok") {
    status = mergeStatus(status, "degraded");
  }
  if (checks.axioms.status !== "ok") {
    status = mergeStatus(status, "degraded");
  }
  if (checks.engram.status !== "ok") {
    status = mergeStatus(status, "degraded");
  }
  if (checks.llmProviders.status !== "ok") {
    status = mergeStatus(status, "degraded");
  }
  if (checks.secrets.status === "degraded") {
    status = mergeStatus(status, "degraded");
  }
  if (checks.secrets.status === "unavailable") {
    status = mergeStatus(status, "unavailable");
  }
  if (checks.tls.status === "degraded") {
    status = mergeStatus(status, "degraded");
  }
  if (checks.tls.status === "unavailable") {
    status = mergeStatus(status, "unavailable");
  }

  return {
    schemaVersion: "1.0.0",
    status,
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
    const headerCwdRaw =
      typeof req.headers?.["x-data-dir"] === "string" && req.headers["x-data-dir"].trim()
        ? req.headers["x-data-dir"].trim()
        : "";
    let healthCwd = process.cwd();

    if (headerCwdRaw) {
      try {
        healthCwd = resolveSafePathWithinWorkspace(headerCwdRaw, process.cwd(), "x-data-dir");
      } catch {
        healthCwd = process.cwd();
      }
    }

    const health = await getHealthStatus(healthCwd);
    const httpStatus = health.status === "unhealthy" ? 503 : 200;
    return jsonResponse(httpStatus, health);
  }
});
