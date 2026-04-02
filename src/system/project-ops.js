// @ts-check

import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { defaultProjectConfig, parseProjectConfig } from "../contracts/config-contracts.js";
import { writeTextFile } from "../io/text-file.js";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

/** @typedef {import("../types/core-contracts.d.ts").DoctorCheck} DoctorCheck */
/** @typedef {import("../types/core-contracts.d.ts").DoctorResult} DoctorResult */

/**
 * @param {string} targetPath
 */
async function pathExists(targetPath) {
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
async function resolveProductionSafetyProfile(cwd) {
  const candidatePath = path.join(cwd, "learning-context.config.production.json");

  if (!(await pathExists(candidatePath))) {
    return {
      found: false,
      strict: false,
      path: "",
      allowedScopePaths: []
    };
  }

  try {
    const raw = await readFile(candidatePath, "utf8");
    const parsed = parseProjectConfig(raw, candidatePath);
    const allowedScopePaths = Array.isArray(parsed.safety?.allowedScopePaths)
      ? parsed.safety.allowedScopePaths.filter(Boolean)
      : [];
    const strict =
      parsed.safety?.requirePlanForWrite === true && allowedScopePaths.length > 0;

    return {
      found: true,
      strict,
      path: candidatePath,
      allowedScopePaths
    };
  } catch {
    return {
      found: true,
      strict: false,
      path: candidatePath,
      allowedScopePaths: []
    };
  }
}

/**
 * @param {string} value
 */
function normalizeProjectId(value) {
  return value.trim().replace(/^@/u, "").replace(/[\\/]/gu, "-").replace(/\s+/gu, "-");
}

/**
 * @param {string} cwd
 */
async function detectStableProjectId(cwd) {
  const packageJsonPath = path.join(cwd, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
    const packageName =
      parsed && typeof parsed === "object" && typeof parsed.name === "string"
        ? normalizeProjectId(parsed.name)
        : "";

    return packageName;
  } catch {
    return "";
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 */
async function tryExec(command, args) {
  const candidates =
    process.platform === "win32" && !command.toLowerCase().endsWith(".cmd")
      ? [command, `${command}.cmd`]
      : [command];

  for (const candidate of candidates) {
    try {
      const result = await execFile(candidate, args, {
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });

      return {
        ok: true,
        stdout: result.stdout?.trim() ?? "",
        stderr: result.stderr?.trim() ?? ""
      };
    } catch (error) {
      if (candidate !== candidates[candidates.length - 1]) {
        continue;
      }

      return {
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return { ok: false, stdout: "", stderr: `Unable to execute ${command}` };
}

async function resolveNpmCliPath() {
  /** @type {string[]} */
  const candidates = [];
  const npmExecPath =
    typeof process.env.npm_execpath === "string" ? process.env.npm_execpath.trim() : "";

  if (npmExecPath) {
    candidates.push(npmExecPath);
  }

  try {
    candidates.push(require.resolve("npm/bin/npm-cli.js"));
  } catch {}

  const nodeDir = path.dirname(process.execPath);
  candidates.push(path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));

  /** @type {Set<string>} */
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (await pathExists(normalized)) {
      return normalized;
    }
  }

  return "";
}

/**
 * @param {string[]} args
 */
async function tryExecNpm(args) {
  const npmCliPath = await resolveNpmCliPath();

  if (npmCliPath) {
    return tryExec(process.execPath, [npmCliPath, ...args]);
  }

  return tryExec("npm", args);
}

/**
 * @param {{ ok: boolean }} npmAvailability
 * @returns {Promise<{ known: boolean, enabled: boolean, detail: string }>}
 */
async function readNpmIgnoreScriptsPolicy(npmAvailability) {
  if (!npmAvailability.ok) {
    return {
      known: false,
      enabled: false,
      detail: "Skipped because npm is not available."
    };
  }

  const configResult = await tryExecNpm(["config", "get", "ignore-scripts"]);

  if (!configResult.ok) {
    return {
      known: false,
      enabled: false,
      detail: `Unable to read npm ignore-scripts policy: ${configResult.stderr}`
    };
  }

  const normalized = String(configResult.stdout || "")
    .trim()
    .toLowerCase();

  if (normalized === "true") {
    return {
      known: true,
      enabled: true,
      detail: "npm ignore-scripts=true (install hooks disabled by default)."
    };
  }

  if (normalized === "false") {
    return {
      known: true,
      enabled: false,
      detail: "npm ignore-scripts=false (install hooks may run)."
    };
  }

  return {
    known: false,
    enabled: false,
    detail: `Unable to parse npm ignore-scripts policy value: '${configResult.stdout}'.`
  };
}

/**
 * @param {{
 *   cwd?: string,
 *   configInfo: { found: boolean, path: string, config: ReturnType<typeof defaultProjectConfig> },
 *   configError?: string
 * }} input
 * @returns {Promise<DoctorResult>}
 */
export async function runProjectDoctor(input) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const configInfo = input.configInfo;
  /** @type {DoctorCheck[]} */
  const checks = [];

  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    id: "node",
    label: "Node.js runtime",
    status: nodeMajor >= 20 ? "pass" : "fail",
    detail: `Detected Node.js ${process.versions.node}`,
    fix: nodeMajor >= 20 ? "" : "Install Node.js 20 or newer."
  });

  const npmResult = await tryExecNpm(["--version"]);
  checks.push({
    id: "npm",
    label: "npm availability",
    status: npmResult.ok ? "pass" : "fail",
    detail: npmResult.ok ? `npm ${npmResult.stdout}` : npmResult.stderr,
    fix: npmResult.ok ? "" : "Install npm (bundled with Node.js) and ensure it is available in PATH."
  });

  const ignoreScriptsPolicy = await readNpmIgnoreScriptsPolicy(npmResult);
  checks.push({
    id: "npm-install-scripts-policy",
    label: "npm install scripts policy",
    status: ignoreScriptsPolicy.known && ignoreScriptsPolicy.enabled ? "pass" : "warn",
    detail: ignoreScriptsPolicy.detail,
    fix:
      ignoreScriptsPolicy.known && ignoreScriptsPolicy.enabled
        ? ""
        : "Use `npm ci --ignore-scripts` for installs, or set `npm config set ignore-scripts true` for this environment."
  });

  const gitResult = await tryExec("git", ["--version"]);
  checks.push({
    id: "git",
    label: "Git availability",
    status: gitResult.ok ? "pass" : "fail",
    detail: gitResult.ok ? gitResult.stdout : gitResult.stderr,
    fix: gitResult.ok ? "" : "Install Git and ensure it is available in PATH."
  });

  const packageJsonPath = path.join(cwd, "package.json");
  const packageJsonExists = await pathExists(packageJsonPath);
  checks.push({
    id: "package-json",
    label: "Package manifest",
    status: packageJsonExists ? "pass" : "fail",
    detail: packageJsonExists ? packageJsonPath : `Missing package.json at ${packageJsonPath}`,
    fix: packageJsonExists ? "" : "Create package.json before using npm-based workflows."
  });

  const nodeModulesPath = path.join(cwd, "node_modules");
  const nodeModulesExists = await pathExists(nodeModulesPath);
  checks.push({
    id: "dependencies",
    label: "Installed dependencies",
    status: nodeModulesExists ? "pass" : "warn",
    detail: nodeModulesExists ? nodeModulesPath : `Missing dependency directory: ${nodeModulesPath}`,
    fix: nodeModulesExists ? "" : "Run `npm ci --ignore-scripts` in the project root."
  });

  checks.push({
    id: "config",
    label: "Project config",
    status: input.configError ? "fail" : configInfo.found ? "pass" : "warn",
    detail: input.configError
      ? input.configError
      : configInfo.found
        ? `Loaded ${configInfo.path}`
        : "No tracked config found; defaults will be used.",
    fix: input.configError
      ? "Fix the JSON file or re-run init to regenerate it."
      : configInfo.found
        ? ""
        : "Run `node src/cli.js init` to create learning-context.config.json."
  });

  const workspaceRoot = path.resolve(cwd, configInfo.config.workspace || ".");
  const workspaceExists = await pathExists(workspaceRoot);
  checks.push({
    id: "workspace",
    label: "Workspace root",
    status: workspaceExists ? "pass" : "fail",
    detail: workspaceExists ? workspaceRoot : `Missing workspace: ${workspaceRoot}`,
      fix: workspaceExists ? "" : "Set a valid workspace path in learning-context.config.json."
  });

  const scanSafetyRelaxed =
    configInfo.config.security.ignoreSensitiveFiles === false ||
    configInfo.config.security.redactSensitiveContent === false ||
    configInfo.config.security.ignoreGeneratedFiles === false;
  checks.push({
    id: "scan-safety",
    label: "Scan safety policy",
    status: scanSafetyRelaxed ? "warn" : "pass",
    detail: scanSafetyRelaxed
      ? "One or more default protections were relaxed in config.security."
      : "Default ignore/redact protections are enabled.",
    fix: scanSafetyRelaxed
      ? "Re-enable config.security.ignoreSensitiveFiles, redactSensitiveContent, and ignoreGeneratedFiles unless you intentionally need broader scanning."
      : ""
  });

  const productionSafetyProfile = await resolveProductionSafetyProfile(cwd);
  const strictSafetyEnabled =
    configInfo.config.safety.requirePlanForWrite === true &&
    configInfo.config.safety.allowedScopePaths.length > 0;
  const productionStrictSafetyEnabled = productionSafetyProfile.strict === true;
  checks.push({
    id: "task-safety-gate",
    label: "Task safety gate",
    status: strictSafetyEnabled || productionStrictSafetyEnabled ? "pass" : "warn",
    detail: strictSafetyEnabled
      ? `Plan gate enabled and scope locked (${configInfo.config.safety.allowedScopePaths.join(", ")}).`
      : productionStrictSafetyEnabled
        ? `Active config is permissive, but production profile is locked (${productionSafetyProfile.allowedScopePaths.join(", ")}) via ${productionSafetyProfile.path}.`
        : "Safety gate is permissive (plan gate disabled or scope paths empty).",
    fix: strictSafetyEnabled || productionStrictSafetyEnabled
      ? ""
      : "Set config.safety.requirePlanForWrite=true and define config.safety.allowedScopePaths for production workflows."
  });

  const focusSafetyEnabled =
    configInfo.config.safety.requireExplicitFocusForWorkspaceScan === true &&
    configInfo.config.safety.minWorkspaceFocusLength >= 1;
  checks.push({
    id: "focus-safety-gate",
    label: "Workspace focus safety gate",
    status: focusSafetyEnabled ? "pass" : "warn",
    detail: focusSafetyEnabled
      ? `Explicit focus required for workspace scans (min length ${configInfo.config.safety.minWorkspaceFocusLength}).`
      : "Workspace focus safety gate is relaxed.",
    fix: focusSafetyEnabled
      ? ""
      : "Set config.safety.requireExplicitFocusForWorkspaceScan=true and config.safety.minWorkspaceFocusLength>=24."
  });

  const memoryBackend = configInfo.config.memory.backend || "resilient";
  const memoryIsolation = configInfo.config.memory.isolation || "strict";
  const resilientLikeBackend = memoryBackend === "resilient" || memoryBackend === "parallel";
  checks.push({
    id: "memory-backend",
    label: "Memory backend mode",
    status: resilientLikeBackend ? "pass" : "warn",
    detail:
      memoryBackend === "parallel"
        ? `parallel (local JSONL + Obsidian in parallel, isolation=${memoryIsolation}).`
        : memoryBackend === "resilient"
          ? `resilient (local JSONL primary + optional external battery contingency, isolation=${memoryIsolation}).`
          : `local-only (only the local JSONL store is active, isolation=${memoryIsolation}).`,
    fix:
      resilientLikeBackend
        ? ""
        : "Prefer memory.backend='parallel' (or resilient) when you want stronger recall coverage with explicit isolation controls."
  });

  const localMemoryDir = path.resolve(cwd, ".lcs/memory");
  const localMemoryExists = await pathExists(localMemoryDir);
  checks.push({
    id: "local-memory",
    label: "Local JSONL memory store",
    status: "pass",
    detail: localMemoryExists
      ? localMemoryDir
      : `Will be created on first successful local memory write: ${localMemoryDir}`,
    fix: ""
  });

  const engramBatteryPath = path.resolve(cwd, configInfo.config.engram.binaryPath || "tools/engram/engram.exe");
  const engramBatteryExists = await pathExists(engramBatteryPath);
  checks.push({
    id: "engram-battery",
    label: "Engram external battery",
    status:
      memoryBackend === "local-only"
        ? "pass"
        : engramBatteryExists
          ? "pass"
          : "warn",
    detail:
      memoryBackend === "local-only"
        ? "Skipped because memory.backend='local-only'."
        : engramBatteryExists
          ? `Available as external battery only: ${engramBatteryPath}`
          : `Optional external battery not available: ${engramBatteryPath}`,
    fix:
      memoryBackend === "local-only" || engramBatteryExists
        ? ""
              : "Install or place the Engram binary only if you want third-tier contingency memory. NEXUS remains canonical on local JSONL + optional external battery."
  });

  if (memoryBackend === "parallel") {
    const obsidianVaultPath = path.resolve(cwd, ".lcs/obsidian-vault");
    const obsidianVaultExists = await pathExists(obsidianVaultPath);
    checks.push({
      id: "obsidian-memory",
      label: "Obsidian second-brain memory",
      status: obsidianVaultExists ? "pass" : "warn",
      detail: obsidianVaultExists
        ? `Obsidian vault detected: ${obsidianVaultPath}`
        : `Obsidian vault not found yet: ${obsidianVaultPath}`,
      fix: obsidianVaultExists
        ? ""
        : "Run at least one remember/close command with memory.backend='parallel' to initialize and sync the vault."
    });
  }

  // Memory sectorization check — verifies per-project buckets exist
  const memoryDir = path.resolve(cwd, ".lcs/memory");
  const memoryDirExists = await pathExists(memoryDir);
  if (memoryDirExists) {
    try {
      const projectBuckets = readdirSync(memoryDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== "_default")
        .map(d => d.name);

      checks.push({
        id: "memory-sectorization",
        label: "Memory sectorization by project",
        status: projectBuckets.length > 0 ? "pass" : "warn",
        detail: projectBuckets.length > 0
          ? `Active project buckets: ${projectBuckets.join(", ")}`
          : "No project-specific memory buckets found. All memories go to _default. Use --project flag when saving.",
        fix: projectBuckets.length > 0 ? "" : "Use --project flag when saving memories to create project-specific buckets."
      });
    } catch {
      checks.push({
        id: "memory-sectorization",
        label: "Memory sectorization by project",
        status: "warn",
        detail: "Could not read memory directory.",
        fix: ""
      });
    }
  } else {
    checks.push({
      id: "memory-sectorization",
      label: "Memory sectorization by project",
      status: "warn",
      detail: "Memory directory not yet created. Will appear on first memory write.",
      fix: ""
    });
  }

  const summary = checks.reduce(
    (accumulator, check) => {
      accumulator[check.status] += 1;
      return accumulator;
    },
    { pass: 0, warn: 0, fail: 0 }
  );

  return {
    cwd,
    summary,
    checks
  };
}

/**
 * @param {{ cwd?: string, configPath?: string, force?: boolean }} input
 */
export async function initProjectConfig(input = {}) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const targetPath = path.resolve(cwd, input.configPath ?? "learning-context.config.json");
  const exists = await pathExists(targetPath);

  if (exists && input.force !== true) {
    return {
      action: "init",
      status: "exists",
      created: false,
      path: targetPath,
      message: "Config already exists."
    };
  }

  const config = defaultProjectConfig();
  config.project = await detectStableProjectId(cwd);
  config.workspace = ".";

  await writeTextFile(targetPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    action: "init",
    status: exists ? "overwritten" : "created",
    created: true,
    path: targetPath,
    project: config.project,
    message: exists ? "Config overwritten." : "Config created."
  };
}
