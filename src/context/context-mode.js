// @ts-check

import { selectContextWindow } from "./noise-canceler.js";

/** @typedef {import("../types/core-contracts.d.ts").Chunk} Chunk */
/** @typedef {import("../types/core-contracts.d.ts").SelectedChunk} SelectedChunk */
/** @typedef {import("../types/core-contracts.d.ts").SuppressedChunk} SuppressedChunk */
/** @typedef {import("../types/core-contracts.d.ts").ChunkKind} ChunkKind */

const DEFAULT_CONTEXT_MODE = "default";

const CLEAN_CONTEXT_PROFILES = Object.freeze({
  ask: {
    tokenBudget: 420,
    maxChunks: 6,
    minScore: 0.28,
    sentenceBudget: 3,
    recallReserveRatio: 0.2,
    scoringProfile: "vertical-tuned"
  },
  chat: {
    tokenBudget: 320,
    maxChunks: 5,
    minScore: 0.3,
    sentenceBudget: 2,
    recallReserveRatio: 0.15,
    scoringProfile: "vertical-tuned"
  },
  teach: {
    tokenBudget: 320,
    maxChunks: 5,
    minScore: 0.3,
    sentenceBudget: 2,
    recallReserveRatio: 0.15,
    scoringProfile: "vertical-tuned"
  },
  agent: {
    tokenBudget: 280,
    maxChunks: 4,
    minScore: 0.32,
    sentenceBudget: 2,
    recallReserveRatio: 0.15,
    scoringProfile: "vertical-tuned"
  }
});

const LEGACY_ENDPOINT_DEFAULTS = Object.freeze({
  ask: {
    tokenBudget: 350,
    maxChunks: 6,
    minScore: 0.25,
    sentenceBudget: 3,
    recallReserveRatio: 0.15,
    scoringProfile: "vertical-tuned"
  },
  chat: {
    tokenBudget: 350,
    maxChunks: 8,
    minScore: 0.25,
    sentenceBudget: 3,
    recallReserveRatio: 0.15,
    scoringProfile: "vertical-tuned"
  },
  teach: {
    tokenBudget: 350,
    maxChunks: 8,
    minScore: 0.25,
    sentenceBudget: 3,
    recallReserveRatio: 0.15,
    scoringProfile: "vertical-tuned"
  },
  agent: {
    tokenBudget: 350,
    maxChunks: 6,
    minScore: 0.2,
    sentenceBudget: 3,
    recallReserveRatio: 0.15,
    scoringProfile: "vertical-tuned"
  }
});

const ADAPTIVE_BUDGET_PROFILES = Object.freeze({
  ask: {
    minMultiplier: 0.85,
    maxMultiplier: 1.8
  },
  chat: {
    minMultiplier: 0.75,
    maxMultiplier: 1.45
  },
  teach: {
    minMultiplier: 0.75,
    maxMultiplier: 1.45
  },
  agent: {
    minMultiplier: 0.8,
    maxMultiplier: 1.7
  }
});

const DEFAULT_SDD_ENDPOINT_POLICIES = Object.freeze({
  ask: {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test"]),
    boostByKind: /** @type {Record<ChunkKind, number>} */ ({
      code: 0.08,
      test: 0.18,
      spec: 0.22,
      memory: 0,
      doc: 0.02,
      chat: -0.05,
      log: -0.12
    })
  },
  chat: {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["spec"]),
    boostByKind: /** @type {Record<ChunkKind, number>} */ ({
      code: 0.05,
      test: 0.1,
      spec: 0.18,
      memory: 0.02,
      doc: 0.02,
      chat: -0.06,
      log: -0.12
    })
  },
  teach: {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["code", "test"]),
    boostByKind: /** @type {Record<ChunkKind, number>} */ ({
      code: 0.12,
      test: 0.16,
      spec: 0.1,
      memory: 0.02,
      doc: 0.02,
      chat: -0.06,
      log: -0.12
    })
  },
  agent: {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    boostByKind: /** @type {Record<ChunkKind, number>} */ ({
      code: 0.12,
      test: 0.2,
      spec: 0.24,
      memory: 0.03,
      doc: 0.04,
      chat: -0.08,
      log: -0.14
    })
  }
});

const CHUNK_KINDS = new Set(["code", "test", "spec", "memory", "doc", "chat", "log"]);
const SOURCE_BUDGET_KEYS = ["workspace", "memory", "chat"];
const FRONTEND_FRAMEWORK_HINTS = new Set([
  "react",
  "next",
  "nextjs",
  "next.js",
  "vue",
  "nuxt",
  "angular",
  "svelte",
  "solid",
  "astro"
]);
const BACKEND_FRAMEWORK_HINTS = new Set([
  "express",
  "fastify",
  "nestjs",
  "koa",
  "hapi",
  "django",
  "flask",
  "spring",
  "springboot",
  "rails",
  "laravel",
  "phoenix"
]);
const FRONTEND_LANGUAGE_HINTS = new Set(["javascript", "typescript", "tsx", "jsx", "css", "html"]);
const BACKEND_LANGUAGE_HINTS = new Set([
  "javascript",
  "typescript",
  "node",
  "python",
  "java",
  "go",
  "rust",
  "kotlin",
  "csharp"
]);
const SECURITY_HINTS = new Set([
  "security",
  "auth",
  "jwt",
  "oauth",
  "xss",
  "csrf",
  "injection",
  "vulnerability",
  "hardening",
  "guard"
]);
const SDD_PROFILE_ALIASES = Object.freeze({
  default: "default",
  baseline: "default",
  general: "default",
  backend: "backend",
  api: "backend",
  server: "backend",
  frontend: "frontend",
  ui: "frontend",
  web: "frontend",
  security: "security",
  secure: "security"
});

/**
 * @param {{
 *   stageOrder: ChunkKind[],
 *   requiredKinds: ChunkKind[],
 *   boostByKind: Record<ChunkKind, number>
 * }} basePolicy
 * @param {Partial<{
 *   stageOrder: ChunkKind[],
 *   requiredKinds: ChunkKind[],
 *   boostByKind: Partial<Record<ChunkKind, number>>
 * }>} overrides
 */
function mergeSddPolicy(basePolicy, overrides = {}) {
  const boostByKind = {
    ...basePolicy.boostByKind
  };

  if (overrides.boostByKind) {
    for (const kind of Object.keys(overrides.boostByKind)) {
      const key = /** @type {ChunkKind} */ (kind);
      const value = overrides.boostByKind[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        boostByKind[key] = value;
      }
    }
  }

  return {
    stageOrder: Array.isArray(overrides.stageOrder)
      ? /** @type {ChunkKind[]} */ ([...overrides.stageOrder])
      : [...basePolicy.stageOrder],
    requiredKinds: Array.isArray(overrides.requiredKinds)
      ? /** @type {ChunkKind[]} */ ([...overrides.requiredKinds])
      : [...basePolicy.requiredKinds],
    boostByKind
  };
}

const BACKEND_SDD_ENDPOINT_POLICIES = Object.freeze({
  ask: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.ask, {
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test"]),
    boostByKind: {
      test: 0.22,
      code: 0.1,
      spec: 0.2,
      chat: -0.08,
      log: -0.15
    }
  }),
  chat: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.chat, {
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test"]),
    boostByKind: {
      test: 0.15,
      spec: 0.2,
      code: 0.06,
      chat: -0.08,
      log: -0.14
    }
  }),
  teach: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.teach, {
    requiredKinds: /** @type {ChunkKind[]} */ (["code", "test"]),
    boostByKind: {
      test: 0.2,
      spec: 0.14,
      code: 0.14,
      chat: -0.08,
      log: -0.14
    }
  }),
  agent: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.agent, {
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    boostByKind: {
      test: 0.24,
      code: 0.14,
      spec: 0.24,
      chat: -0.1,
      log: -0.16
    }
  })
});

const FRONTEND_SDD_ENDPOINT_POLICIES = Object.freeze({
  ask: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.ask, {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "code", "test"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "code"]),
    boostByKind: {
      code: 0.14,
      spec: 0.2,
      test: 0.14,
      doc: 0.05,
      chat: -0.07,
      log: -0.13
    }
  }),
  chat: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.chat, {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "code", "test"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "code"]),
    boostByKind: {
      code: 0.11,
      spec: 0.18,
      test: 0.12,
      doc: 0.05,
      chat: -0.08,
      log: -0.13
    }
  }),
  teach: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.teach, {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "code", "test"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["code", "test"]),
    boostByKind: {
      code: 0.15,
      spec: 0.14,
      test: 0.16,
      doc: 0.05,
      chat: -0.08,
      log: -0.13
    }
  }),
  agent: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.agent, {
    stageOrder: /** @type {ChunkKind[]} */ (["spec", "code", "test"]),
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "code", "test"]),
    boostByKind: {
      code: 0.16,
      spec: 0.24,
      test: 0.2,
      doc: 0.06,
      chat: -0.1,
      log: -0.15
    }
  })
});

const SECURITY_SDD_ENDPOINT_POLICIES = Object.freeze({
  ask: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.ask, {
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    boostByKind: {
      spec: 0.27,
      test: 0.24,
      code: 0.14,
      doc: 0.05,
      chat: -0.12,
      log: -0.18
    }
  }),
  chat: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.chat, {
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    boostByKind: {
      spec: 0.24,
      test: 0.2,
      code: 0.12,
      doc: 0.05,
      chat: -0.12,
      log: -0.18
    }
  }),
  teach: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.teach, {
    requiredKinds: /** @type {ChunkKind[]} */ (["code", "test"]),
    boostByKind: {
      spec: 0.2,
      test: 0.24,
      code: 0.18,
      doc: 0.05,
      chat: -0.12,
      log: -0.18
    }
  }),
  agent: mergeSddPolicy(DEFAULT_SDD_ENDPOINT_POLICIES.agent, {
    requiredKinds: /** @type {ChunkKind[]} */ (["spec", "test", "code"]),
    boostByKind: {
      spec: 0.28,
      test: 0.25,
      code: 0.16,
      doc: 0.06,
      chat: -0.14,
      log: -0.2
    }
  })
});

const SDD_PROFILE_POLICIES = Object.freeze({
  default: DEFAULT_SDD_ENDPOINT_POLICIES,
  backend: BACKEND_SDD_ENDPOINT_POLICIES,
  frontend: FRONTEND_SDD_ENDPOINT_POLICIES,
  security: SECURITY_SDD_ENDPOINT_POLICIES
});

const SDD_PROFILE_NAMES = new Set(Object.keys(SDD_PROFILE_POLICIES));

/**
 * @param {unknown} value
 * @param {{ min: number, max: number, fallback: number }} options
 */
function clampInteger(value, options) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return options.fallback;
  }

  return Math.max(options.min, Math.min(options.max, Math.trunc(value)));
}

/**
 * @param {unknown} value
 * @param {{ min: number, max: number, fallback: number }} options
 */
function clampFloat(value, options) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return options.fallback;
  }

  return Math.max(options.min, Math.min(options.max, value));
}

/**
 * @param {string | undefined} value
 * @param {boolean} fallback
 */
function parseBooleanFlag(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

/**
 * @param {unknown} value
 */
function normalizeSourceBudgetNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, value));
}

/**
 * @param {string | undefined} value
 */
function parseSourceBudgetsFromString(value) {
  const normalized = compactText(value);
  if (!normalized) {
    return undefined;
  }

  /** @type {Record<string, unknown>} */
  let record = {};

  if (normalized.startsWith("{")) {
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        record = /** @type {Record<string, unknown>} */ (parsed);
      } else {
        return undefined;
      }
    } catch {
      return undefined;
    }
  } else {
    for (const segment of normalized.split(",")) {
      const parts = segment.split(/[:=]/u);
      if (parts.length < 2) {
        continue;
      }
      const key = compactText(parts[0]).toLowerCase();
      const rawValue = Number(parts.slice(1).join(":"));
      if (!key || !Number.isFinite(rawValue)) {
        continue;
      }
      record[key] = rawValue;
    }
  }

  /** @type {Partial<Record<"workspace" | "memory" | "chat", number>>} */
  const parsedBudgets = {};
  for (const key of SOURCE_BUDGET_KEYS) {
    const budget = normalizeSourceBudgetNumber(record[key]);
    if (budget === undefined) {
      continue;
    }
    parsedBudgets[/** @type {"workspace" | "memory" | "chat"} */ (key)] = budget;
  }

  return Object.keys(parsedBudgets).length ? parsedBudgets : undefined;
}

/**
 * @param {unknown} value
 */
function parseSourceBudgets(value) {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return parseSourceBudgetsFromString(value);
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {Partial<Record<"workspace" | "memory" | "chat", number>>} */
  const parsedBudgets = {};
  for (const key of SOURCE_BUDGET_KEYS) {
    const budget = normalizeSourceBudgetNumber(record[key]);
    if (budget === undefined) {
      continue;
    }
    parsedBudgets[/** @type {"workspace" | "memory" | "chat"} */ (key)] = budget;
  }

  return Object.keys(parsedBudgets).length ? parsedBudgets : undefined;
}

/**
 * @param {string} text
 */
function estimateTextTokens(text) {
  const normalized = compactText(text);
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

/**
 * @param {"ask" | "chat" | "teach" | "agent"} endpoint
 */
function isAdaptiveBudgetEnabled(endpoint) {
  const endpointFlag = process.env[`LCS_ADAPTIVE_BUDGET_${endpoint.toUpperCase()}`];
  if (endpointFlag !== undefined && endpointFlag !== "") {
    return parseBooleanFlag(endpointFlag, false);
  }

  return parseBooleanFlag(process.env.LCS_ADAPTIVE_BUDGET, false);
}

/**
 * @param {string} key
 * @returns {number | undefined}
 */
function readEnvNumber(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return undefined;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * @param {string | undefined} value
 */
function compactText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * @param {string | undefined} value
 */
function normalizeHintText(value) {
  return compactText(value).toLowerCase();
}

/**
 * @param {string | undefined} value
 */
function normalizeSddProfileName(value) {
  const normalized = normalizeHintText(value);
  if (!normalized) {
    return "";
  }

  if (SDD_PROFILE_NAMES.has(normalized)) {
    return normalized;
  }

  if (Object.prototype.hasOwnProperty.call(SDD_PROFILE_ALIASES, normalized)) {
    return SDD_PROFILE_ALIASES[/** @type {keyof typeof SDD_PROFILE_ALIASES} */ (normalized)] ?? "";
  }

  return "";
}

/**
 * @param {string} value
 * @param {Set<string>} hints
 */
function hasHintMatch(value, hints) {
  if (!value) {
    return false;
  }

  for (const hint of hints) {
    if (value === hint || value.includes(hint)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {{
 *   endpoint: "ask" | "chat" | "teach" | "agent",
 *   requestedProfile?: string,
 *   domain?: string,
 *   framework?: string,
 *   language?: string,
 *   agentType?: string,
 *   query?: string
 * }} input
 * @returns {{ profile: "default" | "backend" | "frontend" | "security", reason: string }}
 */
function resolveSddProfile(input) {
  const endpointEnvProfile = normalizeSddProfileName(
    process.env[`LCS_CONTEXT_SDD_PROFILE_${input.endpoint.toUpperCase()}`]
  );
  const globalEnvProfile = normalizeSddProfileName(process.env.LCS_CONTEXT_SDD_PROFILE);
  const explicitProfile = normalizeSddProfileName(input.requestedProfile);

  if (explicitProfile) {
    return {
      profile: /** @type {"default" | "backend" | "frontend" | "security"} */ (explicitProfile),
      reason: "explicit"
    };
  }

  if (endpointEnvProfile) {
    return {
      profile: /** @type {"default" | "backend" | "frontend" | "security"} */ (endpointEnvProfile),
      reason: `env-endpoint:${input.endpoint}`
    };
  }

  if (globalEnvProfile) {
    return {
      profile: /** @type {"default" | "backend" | "frontend" | "security"} */ (globalEnvProfile),
      reason: "env-global"
    };
  }

  const domain = normalizeHintText(input.domain);
  const framework = normalizeHintText(input.framework);
  const language = normalizeHintText(input.language);
  const agentType = normalizeHintText(input.agentType);
  const query = normalizeHintText(input.query);
  const securityByQuery = input.endpoint === "agent" && hasHintMatch(query, SECURITY_HINTS);

  if (
    agentType === "security" ||
    hasHintMatch(domain, SECURITY_HINTS) ||
    securityByQuery
  ) {
    return {
      profile: "security",
      reason: agentType === "security" ? "agent-type-security" : "security-hint"
    };
  }

  const frontendByFramework = hasHintMatch(framework, FRONTEND_FRAMEWORK_HINTS);
  const backendByFramework = hasHintMatch(framework, BACKEND_FRAMEWORK_HINTS);

  if (frontendByFramework) {
    return {
      profile: "frontend",
      reason: "framework-frontend"
    };
  }

  if (backendByFramework) {
    return {
      profile: "backend",
      reason: "framework-backend"
    };
  }

  const frontendByLanguage = hasHintMatch(language, FRONTEND_LANGUAGE_HINTS);
  const backendByLanguage = hasHintMatch(language, BACKEND_LANGUAGE_HINTS);

  if (frontendByLanguage && !backendByLanguage) {
    return {
      profile: "frontend",
      reason: "language-frontend"
    };
  }

  if (backendByLanguage) {
    return {
      profile: "backend",
      reason: "language-backend"
    };
  }

  return {
    profile: "default",
    reason: "default"
  };
}

/**
 * @returns {"default" | "clean"}
 */
export function resolveContextMode() {
  const requested = compactText(process.env.LCS_CONTEXT_MODE).toLowerCase();
  if (requested === "clean") {
    return "clean";
  }

  return DEFAULT_CONTEXT_MODE;
}

/**
 * @param {"ask" | "chat" | "teach" | "agent"} endpoint
 * @param {{
 *   tokenBudget?: number,
 *   maxChunks?: number,
 *   minScore?: number,
 *   sentenceBudget?: number,
 *   recallReserveRatio?: number,
 *   scoringProfile?: string,
 *   sourceBudgets?: Record<string, number>
 * }} [overrides]
 * @param {{
 *   query?: string,
 *   rawTokens?: number,
 *   chunkCount?: number,
 *   changedFilesCount?: number
 * }} [adaptiveHints]
 */
export function resolveEndpointContextProfile(endpoint, overrides = {}, adaptiveHints = {}) {
  const mode = resolveContextMode();
  const modeDefaults =
    mode === "clean"
      ? CLEAN_CONTEXT_PROFILES[endpoint]
      : LEGACY_ENDPOINT_DEFAULTS[endpoint];
  const envPrefix = `LCS_CONTEXT_PROFILE_${endpoint.toUpperCase()}`;
  const envTokenBudget = readEnvNumber(`${envPrefix}_TOKEN_BUDGET`);
  const overrideTokenBudget = typeof overrides.tokenBudget === "number" ? overrides.tokenBudget : undefined;
  const tokenBudget = clampInteger(
    overrideTokenBudget ??
      envTokenBudget ??
      modeDefaults.tokenBudget,
    { min: 64, max: 4000, fallback: modeDefaults.tokenBudget }
  );
  const maxChunks = clampInteger(
    overrides.maxChunks ?? readEnvNumber(`${envPrefix}_MAX_CHUNKS`) ?? modeDefaults.maxChunks,
    { min: 1, max: 24, fallback: modeDefaults.maxChunks }
  );
  const minScore = clampFloat(
    overrides.minScore ?? readEnvNumber(`${envPrefix}_MIN_SCORE`) ?? modeDefaults.minScore,
    { min: 0, max: 1, fallback: modeDefaults.minScore }
  );
  const sentenceBudget = clampInteger(
    overrides.sentenceBudget ??
      readEnvNumber(`${envPrefix}_SENTENCE_BUDGET`) ??
      modeDefaults.sentenceBudget,
    { min: 1, max: 8, fallback: modeDefaults.sentenceBudget }
  );
  const recallReserveRatio = clampFloat(
    overrides.recallReserveRatio ??
      readEnvNumber(`${envPrefix}_RECALL_RESERVE_RATIO`) ??
      modeDefaults.recallReserveRatio,
    { min: 0, max: 0.5, fallback: modeDefaults.recallReserveRatio }
  );
  const requestedScoringProfile = compactText(
    overrides.scoringProfile ??
      process.env[`${envPrefix}_SCORING_PROFILE`] ??
      modeDefaults.scoringProfile
  );
  const sourceBudgets = parseSourceBudgets(overrides.sourceBudgets)
    ?? parseSourceBudgetsFromString(process.env[`${envPrefix}_SOURCE_BUDGETS`])
    ?? parseSourceBudgetsFromString(process.env.LCS_CONTEXT_SOURCE_BUDGETS);
  const adaptiveEnabled = isAdaptiveBudgetEnabled(endpoint);
  const adaptiveAllowed = adaptiveEnabled && overrideTokenBudget === undefined && envTokenBudget === undefined;
  const adaptiveProfile = ADAPTIVE_BUDGET_PROFILES[endpoint];
  const queryTokens = estimateTextTokens(adaptiveHints.query ?? "");
  const rawTokenInput =
    typeof adaptiveHints.rawTokens === "number" && Number.isFinite(adaptiveHints.rawTokens)
      ? adaptiveHints.rawTokens
      : queryTokens;
  const chunkCountInput =
    typeof adaptiveHints.chunkCount === "number" && Number.isFinite(adaptiveHints.chunkCount)
      ? adaptiveHints.chunkCount
      : 0;
  const changedFilesCountInput =
    typeof adaptiveHints.changedFilesCount === "number" &&
    Number.isFinite(adaptiveHints.changedFilesCount)
      ? adaptiveHints.changedFilesCount
      : 0;
  const adaptiveTokenPressure = clampFloat(rawTokenInput / Math.max(1, tokenBudget), {
    min: 0.25,
    max: 3,
    fallback: 1
  });
  const adaptiveChunkPressure = clampFloat(chunkCountInput / Math.max(1, maxChunks), {
    min: 0,
    max: 3,
    fallback: 0
  });
  const adaptiveQueryPressure = clampFloat(
    queryTokens / Math.max(1, endpoint === "chat" || endpoint === "teach" ? 80 : 110),
    {
    min: 0,
    max: 2,
    fallback: 0
    }
  );
  const adaptiveChangedFilesPressure = clampFloat(
    changedFilesCountInput / Math.max(1, endpoint === "agent" ? 4 : 8),
    {
      min: 0,
      max: 2,
      fallback: 0
    }
  );
  const adaptiveDemand =
    adaptiveTokenPressure * 0.5 +
    adaptiveChunkPressure * 0.25 +
    adaptiveQueryPressure * 0.15 +
    adaptiveChangedFilesPressure * 0.1;
  const adaptiveBaselineMultiplier = 0.7 + adaptiveDemand * 0.35;
  const adaptiveMultiplier = adaptiveAllowed
    ? clampFloat(adaptiveBaselineMultiplier, {
        min: adaptiveProfile.minMultiplier,
        max: adaptiveProfile.maxMultiplier,
        fallback: 1
      })
    : 1;
  const adaptiveTokenBudget = adaptiveAllowed
    ? clampInteger(Math.round(tokenBudget * adaptiveMultiplier), {
        min: 64,
        max: 4000,
        fallback: tokenBudget
      })
    : tokenBudget;

  return {
    endpoint,
    mode,
    enabled: mode === "clean",
    tokenBudget: adaptiveTokenBudget,
    adaptiveBudget: {
      enabled: adaptiveEnabled,
      applied: adaptiveAllowed,
      baseTokenBudget: tokenBudget,
      multiplier: Number(adaptiveMultiplier.toFixed(3)),
      demand: Number(adaptiveDemand.toFixed(3)),
      hints: {
        queryTokens,
        rawTokens: Math.max(0, Math.trunc(rawTokenInput)),
        chunkCount: Math.max(0, Math.trunc(chunkCountInput)),
        changedFilesCount: Math.max(0, Math.trunc(changedFilesCountInput))
      },
      reason: adaptiveAllowed
        ? "adaptive-budget"
        : overrideTokenBudget !== undefined
          ? "explicit-token-budget-override"
          : envTokenBudget !== undefined
            ? "env-token-budget-override"
            : adaptiveEnabled
              ? "adaptive-disabled-by-policy"
              : "feature-flag-disabled"
    },
    maxChunks,
    minScore,
    sentenceBudget,
    recallReserveRatio,
    scoringProfile: requestedScoringProfile || modeDefaults.scoringProfile,
    sourceBudgets
  };
}

/**
 * @param {Chunk[]} chunks
 * @returns {number}
 */
function approximateChunkTokens(chunks) {
  return chunks.reduce((sum, chunk) => {
    const estimated = Math.max(1, Math.ceil(compactText(chunk.content).length / 4));
    return sum + estimated;
  }, 0);
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {Chunk}
 */
function normalizeChunk(value, index) {
  const isStringChunk = typeof value === "string";
  const record =
    !isStringChunk && value && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : {};
  const id = compactText(
    typeof record.id === "string" ? record.id : `chunk-${index + 1}`
  );
  const source = compactText(
    typeof record.source === "string" ? record.source : id || `chunk-${index + 1}`
  );
  const content = compactText(
    isStringChunk
      ? value
      : typeof record.content === "string"
        ? record.content
        : String(record.text ?? "")
  );
  const kindRaw = compactText(
    typeof record.kind === "string" ? record.kind.toLowerCase() : "doc"
  );
  const kind = CHUNK_KINDS.has(kindRaw) ? /** @type {ChunkKind} */ (kindRaw) : "doc";
  const priority =
    typeof record.priority === "number"
      ? record.priority
      : typeof record.score === "number"
        ? record.score
        : undefined;

  return {
    id: id || `chunk-${index + 1}`,
    source: source || `chunk-${index + 1}`,
    kind,
    content,
    ...(typeof priority === "number" && Number.isFinite(priority)
      ? { priority }
      : {})
  };
}

/**
 * @param {Chunk[]} chunks
 */
function countKinds(chunks) {
  /** @type {Record<string, number>} */
  const counts = {};

  for (const chunk of chunks) {
    counts[chunk.kind] = (counts[chunk.kind] ?? 0) + 1;
  }

  return counts;
}

/**
 * @param {{
 *   chunk: Chunk | SelectedChunk,
 *   selectedChunks: Array<Chunk | SelectedChunk>
 * }} input
 * @param {{
 *   stageOrder: ChunkKind[],
 *   boostByKind: Record<ChunkKind, number>
 * }} policy
 */
function scoreSddChunk(input, policy) {
  const kind = input.chunk.kind;
  const baseBoost = policy.boostByKind[kind] ?? 0;

  if (baseBoost === 0) {
    return 0;
  }

  const stageIndex = policy.stageOrder.indexOf(kind);
  const stageBoost =
    stageIndex >= 0
      ? ((policy.stageOrder.length - stageIndex) / policy.stageOrder.length) * 0.05
      : 0;
  const alreadySelected = input.selectedChunks.some(
    (selectedChunk) => selectedChunk.kind === kind
  );

  return alreadySelected
    ? (baseBoost + stageBoost) * 0.35
    : baseBoost + stageBoost;
}

/**
 * @param {{
 *   stageOrder: ChunkKind[],
 *   boostByKind: Record<ChunkKind, number>
 * }} policy
 */
function createSddCustomScorer(policy) {
  return (/** @type {{ chunk: Chunk, selectedChunks: Array<Chunk | SelectedChunk> }} */ input) =>
    scoreSddChunk(input, policy);
}

/**
 * @param {SelectedChunk[]} selected
 */
function summarizeSelectedKinds(selected) {
  /** @type {Record<string, number>} */
  const counts = {};

  for (const chunk of selected) {
    counts[chunk.kind] = (counts[chunk.kind] ?? 0) + 1;
  }

  return counts;
}

/**
 * @param {SelectedChunk} chunk
 * @param {string} reason
 * @returns {SuppressedChunk}
 */
function toSuppressedChunk(chunk, reason) {
  return {
    id: chunk.id,
    source: chunk.source,
    kind: chunk.kind,
    origin: chunk.origin,
    tokenCount: chunk.tokenCount,
    reason,
    score: chunk.score,
    diagnostics: chunk.diagnostics
  };
}

/**
 * @param {SelectedChunk[]} selected
 * @param {Set<string>} requiredKinds
 * @returns {number}
 */
function findReplacementIndex(selected, requiredKinds) {
  const perKindCounts = summarizeSelectedKinds(selected);
  const replaceable = selected
    .map((chunk, index) => ({ chunk, index }))
    .filter(({ chunk }) => {
      if (!requiredKinds.has(chunk.kind)) {
        return true;
      }

      return (perKindCounts[chunk.kind] ?? 0) > 1;
    })
    .sort((left, right) => left.chunk.score - right.chunk.score);

  return replaceable[0]?.index ?? -1;
}

/**
 * @param {SuppressedChunk[]} suppressed
 * @param {string} id
 * @returns {SuppressedChunk[]}
 */
function removeSuppressedById(suppressed, id) {
  return suppressed.filter((entry) => entry.id !== id);
}

/** @param {any} input */
function enforceSddCoverage(input) {
  let selected = [...input.selected];
  let suppressed = [...input.suppressed];
  let usedTokens = Math.max(
    0,
    input.usedTokens ||
      selected.reduce((sum, chunk) => sum + Math.max(0, chunk.tokenCount), 0)
  );
  const selectedIds = new Set(selected.map((chunk) => chunk.id));
  const availableKinds = countKinds(input.normalized);
  const requiredKinds = input.policy.requiredKinds.filter(
    /** @param {ChunkKind} kind */ (kind) => (availableKinds[kind] ?? 0) > 0
  );
  const requiredKindsSet = new Set(requiredKinds);
  /** @type {Array<{ kind: ChunkKind, reason: string }>} */
  const skippedKinds = [];
  /** @type {ChunkKind[]} */
  const injectedKinds = [];

  for (const kind of requiredKinds) {
    if (selected.some((chunk) => chunk.kind === kind)) {
      continue;
    }

    const pool = input.normalized.filter(
      /** @param {Chunk} chunk */ (chunk) => chunk.kind === kind && !selectedIds.has(chunk.id)
    );

    if (!pool.length) {
      skippedKinds.push({ kind, reason: "no-candidates" });
      continue;
    }

    const candidateSelection = selectContextWindow(pool, {
      focus: input.focus,
      tokenBudget: input.profile.tokenBudget,
      maxChunks: 1,
      minScore: 0,
      sentenceBudget: input.profile.sentenceBudget,
      changedFiles: input.changedFiles,
      recallReserveRatio: 0,
      scoringProfile: input.profile.scoringProfile,
      customScorers: [createSddCustomScorer(input.policy)]
    });
    const candidate = candidateSelection.selected[0];

    if (!candidate) {
      skippedKinds.push({ kind, reason: "selection-empty" });
      continue;
    }

    const appendAllowed =
      selected.length < input.profile.maxChunks &&
      usedTokens + candidate.tokenCount <= input.profile.tokenBudget;

    if (appendAllowed) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
      usedTokens += candidate.tokenCount;
      suppressed = removeSuppressedById(suppressed, candidate.id);
      injectedKinds.push(kind);
      continue;
    }

    const replaceIndex = findReplacementIndex(selected, requiredKindsSet);
    if (replaceIndex === -1) {
      skippedKinds.push({ kind, reason: "no-replaceable-slot" });
      continue;
    }

    const replaced = selected[replaceIndex];
    const nextTokenUsage = Math.max(
      0,
      usedTokens - replaced.tokenCount + candidate.tokenCount
    );

    if (nextTokenUsage > input.profile.tokenBudget) {
      skippedKinds.push({ kind, reason: "token-budget" });
      continue;
    }

    selected[replaceIndex] = candidate;
    selectedIds.delete(replaced.id);
    selectedIds.add(candidate.id);
    usedTokens = nextTokenUsage;
    suppressed = removeSuppressedById(suppressed, candidate.id);
    suppressed.push(toSuppressedChunk(replaced, "sdd-rebalanced"));
    injectedKinds.push(kind);
  }

  selected = [...selected].sort((left, right) => right.score - left.score);
  const selectedKinds = summarizeSelectedKinds(selected);
  /** @type {Record<string, boolean>} */
  const coverage = {};

  for (const kind of requiredKinds) {
    coverage[kind] = (selectedKinds[kind] ?? 0) > 0;
  }

  return {
    selected,
    suppressed,
    usedTokens,
    sdd: {
      enabled: true,
      profile: input.profileName,
      profileReason: input.profileReason,
      stageOrder: input.policy.stageOrder,
      requiredKinds,
      availableKinds,
      selectedKinds,
      coverage,
      injectedKinds,
      skippedKinds
    }
  };
}

/** @param {any} input */
export function selectEndpointContext(input) {
  /** @type {"ask" | "chat" | "teach" | "agent"} */
  const endpoint =
    input.endpoint === "ask" ||
    input.endpoint === "chat" ||
    input.endpoint === "teach" ||
    input.endpoint === "agent"
      ? input.endpoint
      : "chat";
  /** @type {unknown[]} */
  const rawChunks = Array.isArray(input.chunks) ? input.chunks : [];
  const normalized = rawChunks.map((entry, index) => normalizeChunk(entry, index));
  const rawTokens = approximateChunkTokens(normalized);
  const profile = resolveEndpointContextProfile(endpoint, input.profileOverrides, {
    query: input.query,
    rawTokens,
    chunkCount: normalized.length,
    changedFilesCount: Array.isArray(input.changedFiles) ? input.changedFiles.length : 0
  });
  const selectionApplied = profile.enabled || input.forceSelection === true;
  const resolvedSddProfile = resolveSddProfile({
    endpoint,
    requestedProfile: input.sddProfile,
    domain: input.domain,
    framework: input.framework,
    language: input.language,
    agentType: input.agentType,
    query: input.query
  });
  const policy =
    SDD_PROFILE_POLICIES[resolvedSddProfile.profile]?.[endpoint] ??
    DEFAULT_SDD_ENDPOINT_POLICIES[endpoint];
  const selectedKinds = countKinds(normalized);
  const baseRequiredKinds = policy.requiredKinds.filter(
    /** @param {ChunkKind} kind */ (kind) => (selectedKinds[kind] ?? 0) > 0
  );
  /** @type {Record<string, boolean>} */
  const baseCoverage = {};
  for (const kind of baseRequiredKinds) {
    baseCoverage[kind] = (selectedKinds[kind] ?? 0) > 0;
  }

  if (!selectionApplied || normalized.length === 0) {
    return {
      mode: profile.mode,
      profile,
      rawChunks: normalized.length,
      rawTokens,
      selectedChunks: normalized,
      suppressedChunks: [],
      usedTokens: rawTokens,
      selectionApplied: false,
      sdd: {
        enabled: false,
        profile: resolvedSddProfile.profile,
        profileReason: resolvedSddProfile.reason,
        stageOrder: policy.stageOrder,
        requiredKinds: baseRequiredKinds,
        availableKinds: selectedKinds,
        selectedKinds,
        coverage: baseCoverage,
        injectedKinds: [],
        skippedKinds: [],
        reason: normalized.length ? "selection-disabled" : "no-chunks"
      }
    };
  }

  const focus = compactText(input.query);
  const selected = selectContextWindow(normalized, {
    focus,
    tokenBudget: profile.tokenBudget,
    maxChunks: profile.maxChunks,
    minScore: profile.minScore,
    sentenceBudget: profile.sentenceBudget,
    changedFiles: input.changedFiles ?? [],
    recallReserveRatio: profile.recallReserveRatio,
    sourceBudgets: profile.sourceBudgets,
    scoringProfile: profile.scoringProfile,
    customScorers: [createSddCustomScorer(policy)]
  });
  const sddSelection = enforceSddCoverage({
    selected: selected.selected,
    suppressed: selected.suppressed,
    usedTokens: selected.usedTokens,
    normalized,
    focus,
    changedFiles: input.changedFiles ?? [],
    profile,
    profileName: resolvedSddProfile.profile,
    profileReason: resolvedSddProfile.reason,
    policy
  });

  return {
    mode: profile.mode,
    profile,
    rawChunks: normalized.length,
    rawTokens,
    selectedChunks: sddSelection.selected,
    suppressedChunks: sddSelection.suppressed,
    usedTokens: sddSelection.usedTokens,
    selectionApplied: true,
    sdd: sddSelection.sdd
  };
}
