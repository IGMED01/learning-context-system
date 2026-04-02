export interface NumberRules {
  integer?: boolean;
  min?: number;
  max?: number;
}

export interface ProjectOutputConfig {
  defaultFormat: string;
  jsonSchemaVersion: string;
}

export interface ProjectSelectionConfig {
  tokenBudget: number;
  maxChunks: number;
  minScore: number;
  sentenceBudget: number;
}

export interface ProjectMemoryConfig {
  enabled: boolean;
  project: string;
  limit: number;
  scope: string;
  type: string;
  backend: "resilient" | "local-only" | "parallel";
  isolation: "strict" | "relaxed";
  strictRecall: boolean;
  degradedRecall: boolean;
  autoRecall: boolean;
  autoRemember: boolean;
  tempTtlMinutes: number;
  tempMaxEntries: number;
}

export interface ProjectEngramConfig {
  binaryPath: string;
  dataDir: string;
}

export interface ProjectSecurityConfig {
  ignoreSensitiveFiles: boolean;
  redactSensitiveContent: boolean;
  ignoreGeneratedFiles: boolean;
  allowSensitivePaths: string[];
  extraSensitivePathFragments: string[];
}

export interface ProjectScanConfig {
  ignoreDirs: string[];
  fastScanner: ProjectFastScannerConfig;
}

export interface ProjectFastScannerConfig {
  enabled: boolean;
  binaryPath: string;
  arguments: string[];
  timeoutMs: number;
}

export interface ProjectSyncRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface ProjectSyncDlqConfig {
  enabled: boolean;
  path: string;
  ttlDays: number;
}

export interface ProjectSyncConfig {
  knowledgeBackend: "notion" | "obsidian" | "local-only";
  retryPolicy: ProjectSyncRetryPolicy;
  dlq: ProjectSyncDlqConfig;
}

export interface ProjectSafetyConfig {
  requirePlanForWrite: boolean;
  allowedScopePaths: string[];
  maxTokenBudget: number;
  requireExplicitFocusForWorkspaceScan: boolean;
  minWorkspaceFocusLength: number;
  blockDebugWithoutStrongFocus: boolean;
}

export interface ProjectGuardRuleConfig {
  type: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface ProjectGuardConfig {
  enabled: boolean;
  rules: ProjectGuardRuleConfig[];
  defaultBlockMessage: string;
}

export interface ProjectConfig {
  schemaVersion: string;
  project: string;
  workspace: string;
  output: ProjectOutputConfig;
  selection: ProjectSelectionConfig;
  memory: ProjectMemoryConfig;
  engram: ProjectEngramConfig;
  security: ProjectSecurityConfig;
  scan: ProjectScanConfig;
  sync: ProjectSyncConfig;
  safety: ProjectSafetyConfig;
  guard: ProjectGuardConfig;
}

function fail(message: string): never {
  throw new Error(message);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string.`);
  }

  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean.`);
  }

  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    fail(`${label} must be an array of strings.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      fail(`${label}[${index}] must be a non-empty string.`);
    }

    return entry.trim();
  });
}

function optionalNumber(value: unknown, label: string, rules: NumberRules = {}): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    fail(`${label} must be a number.`);
  }

  if (rules.integer && !Number.isInteger(value)) {
    fail(`${label} must be an integer.`);
  }

  if (rules.min !== undefined && value < rules.min) {
    fail(`${label} must be >= ${rules.min}.`);
  }

  if (rules.max !== undefined && value > rules.max) {
    fail(`${label} must be <= ${rules.max}.`);
  }

  return value;
}

export function defaultProjectConfig(): ProjectConfig {
  return {
    schemaVersion: "1.0.0",
    project: "",
    workspace: "",
    output: {
      defaultFormat: "",
      jsonSchemaVersion: "1.0.0"
    },
    selection: {
      tokenBudget: 350,
      maxChunks: 6,
      minScore: 0.25,
      sentenceBudget: 3
    },
    memory: {
      enabled: true,
      project: "",
      limit: 3,
      scope: "project",
      type: "",
      backend: "resilient",
      isolation: "strict",
      strictRecall: false,
      degradedRecall: true,
      autoRecall: true,
      autoRemember: false,
      tempTtlMinutes: 120,
      tempMaxEntries: 50
    },
    engram: {
      binaryPath: "tools/engram/engram.exe",
      dataDir: ".engram"
    },
    security: {
      ignoreSensitiveFiles: true,
      redactSensitiveContent: true,
      ignoreGeneratedFiles: true,
      allowSensitivePaths: [],
      extraSensitivePathFragments: []
    },
    scan: {
      ignoreDirs: [".tmp", ".cache", "tmp", ".turbo", ".next", "out", ".lcs", ".claude", ".atl", ".engram"],
      fastScanner: {
        enabled: false,
        binaryPath: "tools/fastscan/lcs-fastscan",
        arguments: [],
        timeoutMs: 8000
      }
    },
    sync: {
      knowledgeBackend: "local-only",
      retryPolicy: {
        maxAttempts: 3,
        backoffMs: 1000,
        maxBackoffMs: 30000
      },
      dlq: {
        enabled: true,
        path: ".lcs/dlq",
        ttlDays: 7
      }
    },
    safety: {
      requirePlanForWrite: false,
      allowedScopePaths: [],
      maxTokenBudget: 700,
      requireExplicitFocusForWorkspaceScan: true,
      minWorkspaceFocusLength: 24,
      blockDebugWithoutStrongFocus: true
    },
    guard: {
      enabled: false,
      rules: [],
      defaultBlockMessage: "This query is outside the scope of this project."
    }
  };
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  assertObject(value, "Project config");

  const config = value;
  const defaults = defaultProjectConfig();

  if (config.output !== undefined) {
    assertObject(config.output, "Project config.output");
  }

  if (config.selection !== undefined) {
    assertObject(config.selection, "Project config.selection");
  }

  if (config.memory !== undefined) {
    assertObject(config.memory, "Project config.memory");
  }

  if (config.engram !== undefined) {
    assertObject(config.engram, "Project config.engram");
  }

  if (config.security !== undefined) {
    assertObject(config.security, "Project config.security");
  }

  if (config.scan !== undefined) {
    assertObject(config.scan, "Project config.scan");
  }

  if (config.sync !== undefined) {
    assertObject(config.sync, "Project config.sync");
  }

  if (config.guard !== undefined) {
    assertObject(config.guard, "Project config.guard");
  }

  if (config.safety !== undefined) {
    assertObject(config.safety, "Project config.safety");
  }

  if (config.llm !== undefined) {
    assertObject(config.llm, "Project config.llm");
  }

  const output = config.output;
  const selection = config.selection;
  const memory = config.memory;
  const engram = config.engram;
  const security = config.security;
  const scan = config.scan;
  const sync = config.sync;
  const safety = config.safety;
  const guard = config.guard;

  const defaultFormat = optionalString(output?.defaultFormat, "Project config.output.defaultFormat");

  if (defaultFormat !== undefined && defaultFormat !== "text" && defaultFormat !== "json") {
    fail("Project config.output.defaultFormat must be 'text' or 'json'.");
  }

  const memoryBackend = optionalString(memory?.backend, "Project config.memory.backend");

  if (
    memoryBackend !== undefined &&
    memoryBackend !== "resilient" &&
    memoryBackend !== "engram-only" &&
    memoryBackend !== "local-only" &&
    memoryBackend !== "parallel"
  ) {
    fail("Project config.memory.backend must be 'resilient', 'parallel', or 'local-only' (legacy alias: 'engram-only').");
  }

  const normalizedMemoryBackend = memoryBackend === "engram-only" ? "resilient" : memoryBackend;
  const memoryIsolation = optionalString(memory?.isolation, "Project config.memory.isolation");
  if (
    memoryIsolation !== undefined &&
    memoryIsolation !== "strict" &&
    memoryIsolation !== "relaxed"
  ) {
    fail("Project config.memory.isolation must be 'strict' or 'relaxed'.");
  }
  const knowledgeBackend = optionalString(sync?.knowledgeBackend, "Project config.sync.knowledgeBackend");

  if (
    knowledgeBackend !== undefined &&
    knowledgeBackend !== "notion" &&
    knowledgeBackend !== "obsidian" &&
    knowledgeBackend !== "local-only"
  ) {
    fail("Project config.sync.knowledgeBackend must be 'notion', 'obsidian', or 'local-only'.");
  }

  const fastScanner: Partial<ProjectFastScannerConfig> | undefined =
    scan && typeof scan.fastScanner === "object" && scan.fastScanner && !Array.isArray(scan.fastScanner)
      ? (scan.fastScanner as Partial<ProjectFastScannerConfig>)
      : undefined;
  const syncRetryPolicy: Partial<ProjectSyncRetryPolicy> | undefined =
    sync && typeof sync.retryPolicy === "object" && sync.retryPolicy && !Array.isArray(sync.retryPolicy)
      ? (sync.retryPolicy as Partial<ProjectSyncRetryPolicy>)
      : undefined;
  const syncDlq: Partial<ProjectSyncDlqConfig> | undefined =
    sync && typeof sync.dlq === "object" && sync.dlq && !Array.isArray(sync.dlq)
      ? (sync.dlq as Partial<ProjectSyncDlqConfig>)
      : undefined;

  return {
    schemaVersion: optionalString(config.schemaVersion, "Project config.schemaVersion") ?? defaults.schemaVersion,
    project: optionalString(config.project, "Project config.project") ?? defaults.project,
    workspace: optionalString(config.workspace, "Project config.workspace") ?? defaults.workspace,
    output: {
      defaultFormat: defaultFormat ?? defaults.output.defaultFormat,
      jsonSchemaVersion:
        optionalString(output?.jsonSchemaVersion, "Project config.output.jsonSchemaVersion") ??
        defaults.output.jsonSchemaVersion
    },
    selection: {
      tokenBudget:
        optionalNumber(selection?.tokenBudget, "Project config.selection.tokenBudget", {
          min: 1,
          integer: true
        }) ?? defaults.selection.tokenBudget,
      maxChunks:
        optionalNumber(selection?.maxChunks, "Project config.selection.maxChunks", {
          min: 1,
          integer: true
        }) ?? defaults.selection.maxChunks,
      minScore:
        optionalNumber(selection?.minScore, "Project config.selection.minScore", {
          min: 0,
          max: 1
        }) ?? defaults.selection.minScore,
      sentenceBudget:
        optionalNumber(selection?.sentenceBudget, "Project config.selection.sentenceBudget", {
          min: 1,
          integer: true
        }) ?? defaults.selection.sentenceBudget
    },
    memory: {
      enabled: optionalBoolean(memory?.enabled, "Project config.memory.enabled") ?? defaults.memory.enabled,
      project: optionalString(memory?.project, "Project config.memory.project") ?? defaults.memory.project,
      limit:
        optionalNumber(memory?.limit, "Project config.memory.limit", {
          min: 1,
          integer: true
        }) ?? defaults.memory.limit,
      scope: optionalString(memory?.scope, "Project config.memory.scope") ?? defaults.memory.scope,
      type: optionalString(memory?.type, "Project config.memory.type") ?? defaults.memory.type,
      backend: normalizedMemoryBackend ?? defaults.memory.backend,
      isolation: memoryIsolation ?? defaults.memory.isolation,
      strictRecall:
        optionalBoolean(memory?.strictRecall, "Project config.memory.strictRecall") ??
        defaults.memory.strictRecall,
      degradedRecall:
        optionalBoolean(memory?.degradedRecall, "Project config.memory.degradedRecall") ??
        defaults.memory.degradedRecall,
      autoRecall:
        optionalBoolean(memory?.autoRecall, "Project config.memory.autoRecall") ??
        defaults.memory.autoRecall,
      autoRemember:
        optionalBoolean(memory?.autoRemember, "Project config.memory.autoRemember") ??
        defaults.memory.autoRemember,
      tempTtlMinutes:
        optionalNumber(memory?.tempTtlMinutes, "Project config.memory.tempTtlMinutes", {
          min: 1,
          max: 10080,
          integer: true
        }) ?? defaults.memory.tempTtlMinutes,
      tempMaxEntries:
        optionalNumber(memory?.tempMaxEntries, "Project config.memory.tempMaxEntries", {
          min: 10,
          max: 500,
          integer: true
        }) ?? defaults.memory.tempMaxEntries
    },
    engram: {
      binaryPath:
        optionalString(engram?.binaryPath, "Project config.engram.binaryPath") ?? defaults.engram.binaryPath,
      dataDir: optionalString(engram?.dataDir, "Project config.engram.dataDir") ?? defaults.engram.dataDir
    },
    security: {
      ignoreSensitiveFiles:
        optionalBoolean(security?.ignoreSensitiveFiles, "Project config.security.ignoreSensitiveFiles") ??
        defaults.security.ignoreSensitiveFiles,
      redactSensitiveContent:
        optionalBoolean(security?.redactSensitiveContent, "Project config.security.redactSensitiveContent") ??
        defaults.security.redactSensitiveContent,
      ignoreGeneratedFiles:
        optionalBoolean(security?.ignoreGeneratedFiles, "Project config.security.ignoreGeneratedFiles") ??
        defaults.security.ignoreGeneratedFiles,
      allowSensitivePaths:
        optionalStringArray(security?.allowSensitivePaths, "Project config.security.allowSensitivePaths") ??
        defaults.security.allowSensitivePaths,
      extraSensitivePathFragments:
        optionalStringArray(
          security?.extraSensitivePathFragments,
          "Project config.security.extraSensitivePathFragments"
        ) ?? defaults.security.extraSensitivePathFragments
    },
    scan: {
      ignoreDirs:
        optionalStringArray(scan?.ignoreDirs, "Project config.scan.ignoreDirs") ??
        defaults.scan.ignoreDirs,
      fastScanner: {
        enabled:
          optionalBoolean(
            fastScanner?.enabled,
            "Project config.scan.fastScanner.enabled"
          ) ?? defaults.scan.fastScanner.enabled,
        binaryPath:
          optionalString(
            fastScanner?.binaryPath,
            "Project config.scan.fastScanner.binaryPath"
          ) ?? defaults.scan.fastScanner.binaryPath,
        arguments:
          optionalStringArray(
            fastScanner?.arguments,
            "Project config.scan.fastScanner.arguments"
          ) ?? defaults.scan.fastScanner.arguments,
        timeoutMs:
          optionalNumber(
            fastScanner?.timeoutMs,
            "Project config.scan.fastScanner.timeoutMs",
            {
              min: 200,
              integer: true
            }
          ) ?? defaults.scan.fastScanner.timeoutMs
      }
    },
    sync: {
      knowledgeBackend: knowledgeBackend ?? defaults.sync.knowledgeBackend,
      retryPolicy: {
        maxAttempts:
          optionalNumber(
            syncRetryPolicy?.maxAttempts,
            "Project config.sync.retryPolicy.maxAttempts",
            {
              min: 1,
              max: 12,
              integer: true
            }
          ) ?? defaults.sync.retryPolicy.maxAttempts,
        backoffMs:
          optionalNumber(
            syncRetryPolicy?.backoffMs,
            "Project config.sync.retryPolicy.backoffMs",
            {
              min: 100,
              max: 120000,
              integer: true
            }
          ) ?? defaults.sync.retryPolicy.backoffMs,
        maxBackoffMs:
          optionalNumber(
            syncRetryPolicy?.maxBackoffMs,
            "Project config.sync.retryPolicy.maxBackoffMs",
            {
              min: 100,
              max: 600000,
              integer: true
            }
          ) ?? defaults.sync.retryPolicy.maxBackoffMs
      },
      dlq: {
        enabled:
          optionalBoolean(syncDlq?.enabled, "Project config.sync.dlq.enabled") ??
          defaults.sync.dlq.enabled,
        path:
          optionalString(syncDlq?.path, "Project config.sync.dlq.path") ??
          defaults.sync.dlq.path,
        ttlDays:
          optionalNumber(syncDlq?.ttlDays, "Project config.sync.dlq.ttlDays", {
            min: 1,
            max: 365,
            integer: true
          }) ?? defaults.sync.dlq.ttlDays
      }
    },
    safety: {
      requirePlanForWrite:
        optionalBoolean(safety?.requirePlanForWrite, "Project config.safety.requirePlanForWrite") ??
        defaults.safety.requirePlanForWrite,
      allowedScopePaths:
        optionalStringArray(safety?.allowedScopePaths, "Project config.safety.allowedScopePaths") ??
        defaults.safety.allowedScopePaths,
      maxTokenBudget:
        optionalNumber(safety?.maxTokenBudget, "Project config.safety.maxTokenBudget", {
          min: 1,
          integer: true
        }) ?? defaults.safety.maxTokenBudget,
      requireExplicitFocusForWorkspaceScan:
        optionalBoolean(
          safety?.requireExplicitFocusForWorkspaceScan,
          "Project config.safety.requireExplicitFocusForWorkspaceScan"
        ) ?? defaults.safety.requireExplicitFocusForWorkspaceScan,
      minWorkspaceFocusLength:
        optionalNumber(
          safety?.minWorkspaceFocusLength,
          "Project config.safety.minWorkspaceFocusLength",
          {
            min: 1,
            integer: true
          }
        ) ?? defaults.safety.minWorkspaceFocusLength,
      blockDebugWithoutStrongFocus:
        optionalBoolean(
          safety?.blockDebugWithoutStrongFocus,
          "Project config.safety.blockDebugWithoutStrongFocus"
        ) ?? defaults.safety.blockDebugWithoutStrongFocus
    },
    guard: {
      enabled:
        optionalBoolean(guard?.enabled, "Project config.guard.enabled") ?? defaults.guard.enabled,
      rules: Array.isArray(guard?.rules)
        ? (guard.rules as unknown[]).map((rule, index) => {
            assertObject(rule, `Project config.guard.rules[${index}]`);
            const r = rule as Record<string, unknown>;

            return {
              type: optionalString(r.type, `Project config.guard.rules[${index}].type`) ?? "",
              enabled: optionalBoolean(r.enabled, `Project config.guard.rules[${index}].enabled`) ?? true,
              params: (r.params && typeof r.params === "object" && !Array.isArray(r.params))
                ? r.params as Record<string, unknown>
                : {}
            };
          })
        : defaults.guard.rules,
      defaultBlockMessage:
        optionalString(guard?.defaultBlockMessage, "Project config.guard.defaultBlockMessage") ??
        defaults.guard.defaultBlockMessage
    }
  };
}

export function parseProjectConfig(raw: string, sourceLabel: string): ProjectConfig {
  try {
    return validateProjectConfig(JSON.parse(raw.replace(/^\uFEFF/u, "")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`${sourceLabel} is not valid JSON: ${error.message}`);
    }

    throw error;
  }
}
