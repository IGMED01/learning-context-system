// @ts-check

/**
 * Security Learning Loop
 *
 * Turns security findings/chunks into durable learning units without copying raw code.
 * The output is structured for memory+RAG retrieval and security-focused teach flows.
 */

/**
 * @typedef {import("../types/core-contracts.d.ts").Chunk} Chunk
 * @typedef {import("../types/core-contracts.d.ts").MemoryProvider} MemoryProvider
 */

export const DEFAULT_SECURITY_MIN_CONFIDENCE = 0.72;
export const DEFAULT_SECURITY_ENFORCEMENT = "warn-block-critical";

export const CRITICAL_SECURITY_RISK_IDS = new Set([
  "secrets-exposure",
  "prompt-injection-executable",
  "insecure-deserialization",
  "auth-bypass",
  "path-traversal",
  "command-injection"
]);

const RISK_TAXONOMY = [
  {
    id: "secrets-exposure",
    label: "Secrets exposure",
    keywords: ["secret", "token", "apikey", "api-key", "credential", "password", "private key"],
    severity: "critical"
  },
  {
    id: "prompt-injection-executable",
    label: "Prompt injection executable path",
    keywords: ["prompt injection", "ignore previous", "system prompt", "tool execution", "execute command"],
    severity: "critical"
  },
  {
    id: "insecure-deserialization",
    label: "Insecure deserialization",
    keywords: ["deserialization", "deserialize", "pickle", "yaml.load", "objectinputstream"],
    severity: "critical"
  },
  {
    id: "auth-bypass",
    label: "Authentication/authorization bypass",
    keywords: ["auth bypass", "authorization bypass", "missing auth", "broken access control"],
    severity: "critical"
  },
  {
    id: "path-traversal",
    label: "Path traversal",
    keywords: ["path traversal", "../", "directory traversal", "unsafe path"],
    severity: "critical"
  },
  {
    id: "command-injection",
    label: "Command injection",
    keywords: ["command injection", "shell injection", "exec(", "spawn(", "os.system", "popen"],
    severity: "critical"
  },
  {
    id: "sql-injection",
    label: "SQL injection",
    keywords: ["sql injection", "union select", "or 1=1", "raw query"],
    severity: "high"
  },
  {
    id: "xss",
    label: "Cross-site scripting",
    keywords: ["xss", "cross-site scripting", "innerhtml", "unsanitized html"],
    severity: "high"
  },
  {
    id: "ssrf",
    label: "Server-side request forgery",
    keywords: ["ssrf", "server-side request forgery", "internal metadata endpoint"],
    severity: "high"
  },
  {
    id: "weak-crypto",
    label: "Weak cryptography",
    keywords: ["md5", "sha1", "weak crypto", "insecure cipher", "ecb"],
    severity: "medium"
  },
  {
    id: "dependency-vulnerability",
    label: "Dependency vulnerability",
    keywords: ["dependency", "vulnerability", "cve", "advisory", "supply chain"],
    severity: "medium"
  }
];

const SUSPICIOUS_LEARNING_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/iu,
  /disable\s+security\s+checks/iu,
  /exfiltrate|steal|backdoor|malware/iu,
  /do\s+not\s+validate/iu
];

const HIGH_SIGNAL_CRITICAL_PATTERNS = [
  /-----begin\s+(rsa|ec|private)\s+key-----/iu,
  /\b(api[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?token)\b/iu,
  /\b(ignore\s+previous\s+instructions|prompt\s+injection)\b/iu,
  /\b(yaml\.load|objectinputstream|deserialize)\b/iu,
  /\b(exec\(|spawn\(|os\.system|popen)\b/iu,
  /\b(\.\.\/|path\s+traversal|directory\s+traversal)\b/iu,
  /\b(auth(?:entication|orization)?\s+bypass|broken\s+access\s+control)\b/iu
];

/**
 * @param {unknown} value
 */
function compactText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * @param {string} value
 */
function normalizeText(value) {
  return compactText(value)
    .normalize("NFKD")
    .toLowerCase();
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {string} text
 */
function firstSentence(text) {
  const clean = compactText(text);
  if (!clean) {
    return "";
  }
  const split = clean.match(/^(.+?[.!?])(\s|$)/u);
  return split?.[1]?.trim() || clean.slice(0, 180);
}

/**
 * @param {string} content
 * @param {string} label
 */
function captureLabel(content, label) {
  const expression = new RegExp(`${label}\\s*:\\s*([^\\n.]+)`, "iu");
  const matched = normalizeText(content).match(expression);
  return compactText(matched?.[1] ?? "");
}

/**
 * @param {string} content
 */
function inferTitle(content) {
  const matched = content.match(/Prowler finding:\s*([^\n.]+)/iu);
  if (matched?.[1]) {
    return compactText(matched[1]);
  }

  return firstSentence(content) || "Security finding";
}

/**
 * @param {string} source
 */
function inferCheckId(source) {
  const match = source.match(/security:\/\/[^/]+\/([^/]+)/iu);
  return compactText(match?.[1] ?? "");
}

/**
 * @param {string[]} changedFiles
 * @returns {string}
 */
function inferLanguageFromChangedFiles(changedFiles = []) {
  /** @type {Record<string, string>} */
  const byExtension = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".go": "go",
    ".py": "python",
    ".java": "java",
    ".rb": "ruby",
    ".rs": "rust",
    ".php": "php",
    ".cs": "csharp"
  };

  /** @type {Map<string, number>} */
  const scores = new Map();

  for (const file of changedFiles) {
    const match = String(file ?? "").toLowerCase().match(/\.[a-z0-9]+$/u);
    const language = match ? byExtension[match[0]] : "";
    if (!language) {
      continue;
    }
    scores.set(language, (scores.get(language) ?? 0) + 1);
  }

  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  return ranked[0]?.[0] ?? "";
}

/**
 * @param {"critical" | "high" | "medium" | "low" | "unknown"} label
 */
function severityScoreFromLabel(label) {
  if (label === "critical") return 1;
  if (label === "high") return 0.92;
  if (label === "medium") return 0.78;
  if (label === "low") return 0.62;
  return 0.5;
}

/**
 * @param {string} content
 * @param {number | undefined} priority
 */
function resolveSeverity(content, priority) {
  const raw = captureLabel(content, "severity");
  const normalized = normalizeText(raw);

  if (normalized.includes("critical")) {
    return { label: "critical", score: 1 };
  }
  if (normalized.includes("high")) {
    return { label: "high", score: 0.92 };
  }
  if (normalized.includes("medium")) {
    return { label: "medium", score: 0.78 };
  }
  if (normalized.includes("low")) {
    return { label: "low", score: 0.62 };
  }

  if (typeof priority === "number" && Number.isFinite(priority)) {
    if (priority >= 0.94) {
      return { label: "critical", score: 1 };
    }
    if (priority >= 0.86) {
      return { label: "high", score: 0.92 };
    }
    if (priority >= 0.72) {
      return { label: "medium", score: 0.78 };
    }
    if (priority >= 0.5) {
      return { label: "low", score: 0.62 };
    }
  }

  return { label: "unknown", score: 0.5 };
}

/**
 * @param {string} content
 * @param {string} title
 * @param {string} remediation
 */
function resolveRiskTaxonomy(content, title, remediation) {
  const haystack = normalizeText([title, content, remediation].join(" "));

  for (const risk of RISK_TAXONOMY) {
    if (risk.keywords.some((keyword) => haystack.includes(normalizeText(keyword)))) {
      return {
        id: risk.id,
        label: risk.label,
        baselineSeverity: risk.severity
      };
    }
  }

  return {
    id: "security-misconfiguration",
    label: "Security misconfiguration",
    baselineSeverity: "medium"
  };
}

/**
 * @param {string} title
 * @param {string} riskLabel
 */
function buildRule(title, riskLabel) {
  const normalizedTitle = compactText(title);
  if (normalizedTitle) {
    return `Prevent ${normalizedTitle.toLowerCase()} in production code paths.`;
  }

  return `Apply secure-by-default controls for ${riskLabel.toLowerCase()}.`;
}

/**
 * @param {string} content
 */
function captureRemediation(content) {
  const remediation = captureLabel(content, "remediation");
  return remediation || "Apply least-privilege, strict validation, and explicit safety checks before execution.";
}

/**
 * @param {string} content
 */
function captureRisk(content) {
  const risk = captureLabel(content, "risk");
  return risk || "Unchecked security condition can be exploited under realistic attacker input.";
}

/**
 * @param {string} fixPattern
 * @param {string} language
 */
function buildPracticePrompt(fixPattern, language) {
  const languageLabel = language || "your language";
  return `Practice: implement a minimal ${languageLabel} patch that applies this fix pattern -> ${fixPattern}`;
}

/**
 * @param {string} value
 */
function isSuspiciousLearningContent(value) {
  const text = normalizeText(value);
  return SUSPICIOUS_LEARNING_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * @param {Record<string, unknown>} unit
 */
function semanticUnitKey(unit) {
  return [
    normalizeText(String(unit.project ?? "")),
    normalizeText(String(unit.language ?? "")),
    normalizeText(String(unit.riskTaxonomyId ?? "")),
    normalizeText(String(unit.rule ?? "")),
    normalizeText(String(unit.fixPattern ?? ""))
  ].join("::");
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 */
function betterUnit(left, right) {
  const leftConfidence = Number(left.confidence ?? 0);
  const rightConfidence = Number(right.confidence ?? 0);
  if (rightConfidence > leftConfidence) {
    return right;
  }

  const leftSeverity = severityScoreFromLabel(
    /** @type {"critical" | "high" | "medium" | "low" | "unknown"} */ (
      String(left.severity ?? "unknown")
    )
  );
  const rightSeverity = severityScoreFromLabel(
    /** @type {"critical" | "high" | "medium" | "low" | "unknown"} */ (
      String(right.severity ?? "unknown")
    )
  );

  if (rightSeverity > leftSeverity) {
    return right;
  }

  return left;
}

/**
 * @param {Array<Record<string, unknown>>} units
 */
function dedupeUnits(units) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map();

  for (const unit of units) {
    const key = semanticUnitKey(unit);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, unit);
      continue;
    }
    byKey.set(key, betterUnit(previous, unit));
  }

  return [...byKey.values()];
}

/**
 * @param {Record<string, unknown>} unit
 * @returns {string}
 */
function buildLearningContent(unit) {
  return [
    "Rule:",
    `- ${String(unit.rule ?? "")}`,
    "",
    "Why:",
    `- ${String(unit.antiPattern ?? "")}`,
    "",
    "Fix:",
    `- ${String(unit.fixPattern ?? "")}`,
    "",
    "Practice:",
    `- ${String(unit.practicePrompt ?? "")}`,
    "",
    "Signals:",
    `- Severity: ${String(unit.severity ?? "unknown")}`,
    `- Confidence: ${Number(unit.confidence ?? 0).toFixed(3)}`,
    `- Risk taxonomy: ${String(unit.riskTaxonomyId ?? "security-misconfiguration")}`,
    `- Source: ${String(unit.sourceRef ?? "security://unknown")}`
  ].join("\n");
}

/**
 * @param {Chunk} chunk
 * @param {{
 *   project?: string,
 *   source?: string,
 *   language?: string,
 *   changedFiles?: string[]
 * }} options
 */
function distillChunkToLearningUnit(chunk, options) {
  const content = compactText(chunk.content);
  const title = inferTitle(content);
  const remediation = captureRemediation(content);
  const risk = captureRisk(content);
  const severity = resolveSeverity(content, chunk.priority);
  const taxonomy = resolveRiskTaxonomy(content, title, remediation);
  const inferredLanguage =
    compactText(options.language).toLowerCase() ||
    inferLanguageFromChangedFiles(options.changedFiles ?? []);
  const confidence = clamp(
    0.48 +
      (typeof chunk.priority === "number" ? clamp(chunk.priority) * 0.28 : 0.12) +
      (typeof chunk.certainty === "number" ? clamp(chunk.certainty) * 0.2 : 0.1) +
      severity.score * 0.18
  );
  const rule = buildRule(title, taxonomy.label);
  const antiPattern = risk;
  const fixPattern = remediation;
  const practicePrompt = buildPracticePrompt(remediation, inferredLanguage);
  const sourceRef = compactText(chunk.source) || `security://learning/${chunk.id}`;
  const checkId = captureLabel(content, "check") || inferCheckId(sourceRef) || chunk.id;
  const critical =
    CRITICAL_SECURITY_RISK_IDS.has(taxonomy.id) ||
    severity.label === "critical" ||
    (severity.label === "high" && CRITICAL_SECURITY_RISK_IDS.has(taxonomy.id));

  return {
    id: String(chunk.id ?? ""),
    project: compactText(options.project),
    source: compactText(options.source) || "local",
    sourceRef,
    checkId,
    title,
    rule,
    antiPattern,
    fixPattern,
    practicePrompt,
    severity: severity.label,
    severityScore: severity.score,
    confidence,
    language: inferredLanguage,
    riskTaxonomyId: taxonomy.id,
    riskTaxonomy: taxonomy.label,
    critical,
    createdAt: new Date().toISOString()
  };
}

/**
 * @param {Record<string, unknown>} unit
 * @param {number} minConfidence
 * @param {{ strictIsolation?: boolean, language?: string }} [options]
 */
function evaluateUnitQuality(unit, minConfidence, options = {}) {
  /** @type {string[]} */
  const reasons = [];
  const confidence = Number(unit.confidence ?? 0);

  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    reasons.push("low-confidence");
  }

  const unitText = [unit.rule, unit.antiPattern, unit.fixPattern, unit.practicePrompt].join(" ");
  if (isSuspiciousLearningContent(String(unitText))) {
    reasons.push("suspicious-pattern");
  }

  const strictLanguage = compactText(options.language).toLowerCase();
  const unitLanguage = compactText(unit.language).toLowerCase();
  if (options.strictIsolation !== false && strictLanguage && unitLanguage && strictLanguage !== unitLanguage) {
    reasons.push("cross-language-isolation");
  }

  return {
    accepted: reasons.length === 0,
    reasons
  };
}

/**
 * @param {string} mode
 */
function normalizeSecurityFocusMode(mode) {
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

/**
 * @param {string} text
 */
function hasCriticalEvidence(text) {
  const normalized = normalizeText(text);
  return HIGH_SIGNAL_CRITICAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * @param {string} text
 * @returns {Array<{ id: string, label: string, severity: "critical" | "high" | "medium" | "low" | "unknown", hits: number, score: number }>}
 */
function rankRiskMatches(text) {
  const normalized = normalizeText(text);
  return RISK_TAXONOMY.map((risk) => {
    const hits = risk.keywords.reduce(
      (count, keyword) =>
        normalized.includes(normalizeText(keyword))
          ? count + 1
          : count,
      0
    );
    const severityScore =
      risk.severity === "critical"
        ? 1
        : risk.severity === "high"
          ? 0.8
          : risk.severity === "medium"
            ? 0.6
            : 0.45;
    return {
      id: risk.id,
      label: risk.label,
      severity: /** @type {"critical" | "high" | "medium" | "low" | "unknown"} */ (risk.severity),
      hits,
      score: hits * severityScore
    };
  })
    .filter((entry) => entry.hits > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.hits !== left.hits) {
        return right.hits - left.hits;
      }
      return severityScoreFromLabel(right.severity) - severityScoreFromLabel(left.severity);
    });
}

/**
 * @param {{
 *   task?: string,
 *   objective?: string,
 *   focus?: string,
 *   changedFiles?: string[],
 *   recentRiskTaxonomyIds?: string[]
 * }} input
 */
export function buildSecuritySideQueries(input) {
  const task = compactText(input.task);
  const objective = compactText(input.objective);
  const focus = compactText(input.focus);
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const recentRiskTaxonomyIds = Array.isArray(input.recentRiskTaxonomyIds)
    ? input.recentRiskTaxonomyIds.map((item) => compactText(item)).filter(Boolean)
    : [];
  const fileTerms = changedFiles
    .flatMap((entry) => entry.split(/[\\/._-]+/u))
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length >= 4)
    .slice(0, 6);
  const taskSignal = normalizeText([task, objective, focus].join(" "));
  const hasSecuritySignal =
    /(security|auth|token|secret|guard|validate|sanitize|injection|risk|cve|owasp)/iu.test(taskSignal) ||
    fileTerms.some((term) =>
      /(auth|token|secret|guard|security|sanitize|crypto|permission|access)/iu.test(term)
    );

  if (!hasSecuritySignal) {
    return [];
  }

  const baseQuery = [task, objective, ...fileTerms.slice(0, 3)].filter(Boolean).join(" ");
  const riskQuery = recentRiskTaxonomyIds.slice(0, 2).join(" ");

  return [
    compactText(`security rule ${baseQuery}`),
    compactText(`secure fix pattern ${baseQuery}`),
    riskQuery ? compactText(`risk taxonomy ${riskQuery} mitigation`) : ""
  ].filter(Boolean);
}

/**
 * @param {{
 *   mode?: "auto" | "on" | "off",
 *   task?: string,
 *   objective?: string,
 *   changedFiles?: string[],
 *   selectedContext?: Array<{ content?: string }>,
 *   recoveredSecurityEntries?: Array<Record<string, unknown>>,
 *   enforcement?: string
 * }} input
 */
export function buildSecurityTeachingBlock(input) {
  const mode = normalizeSecurityFocusMode(input.mode ?? "auto");
  if (mode === "off") {
    return {
      enabled: false,
      focusMode: mode,
      blocked: false,
      critical: false,
      reasons: [],
      rulesApplied: []
    };
  }

  const selectedContext = Array.isArray(input.selectedContext) ? input.selectedContext : [];
  const recoveredSecurityEntries = Array.isArray(input.recoveredSecurityEntries)
    ? input.recoveredSecurityEntries
    : [];
  const text = [
    input.task,
    input.objective,
    ...(input.changedFiles ?? []),
    ...selectedContext.map((entry) => String(entry.content ?? "")),
    ...recoveredSecurityEntries.flatMap((entry) => [
      entry.rule,
      entry.antiPattern,
      entry.fixPattern,
      entry.riskTaxonomyId
    ])
  ]
    .map((entry) => compactText(entry))
    .filter(Boolean)
    .join(" ");

  const riskMatches = rankRiskMatches(text);

  if (!riskMatches.length && mode === "auto") {
    return {
      enabled: false,
      focusMode: mode,
      blocked: false,
      critical: false,
      reasons: [],
      rulesApplied: []
    };
  }

  const topRisk = riskMatches[0] ?? {
    id: "security-misconfiguration",
    label: "Security misconfiguration",
    severity: "medium"
  };
  const memoryHint = recoveredSecurityEntries.find((entry) =>
    String(entry.riskTaxonomyId ?? "") === topRisk.id
  );
  const rule =
    compactText(memoryHint?.rule) ||
    `Always enforce ${topRisk.label.toLowerCase()} safeguards before merging or running generated code.`;
  const why =
    compactText(memoryHint?.antiPattern) ||
    `${topRisk.label} can become an exploit path if unchecked in changed files and runtime boundaries.`;
  const fix =
    compactText(memoryHint?.fixPattern) ||
    "Apply strict input validation, explicit authorization boundaries, safe APIs, and defensive defaults.";
  const practice =
    compactText(memoryHint?.practicePrompt) ||
    "Practice: write a failing security test for this risk, patch it, then rerun tests.";
  const critical =
    CRITICAL_SECURITY_RISK_IDS.has(topRisk.id) || topRisk.severity === "critical";
  const enforcement = compactText(input.enforcement) || DEFAULT_SECURITY_ENFORCEMENT;
  const criticalFromRecoveredMemory = recoveredSecurityEntries.some((entry) => {
    const entryRisk = String(entry.riskTaxonomyId ?? "").trim().toLowerCase();
    const entryCritical = entry.securityCritical === true;
    const entryConfidence = Number(entry.confidence ?? 0);
    if (!entryCritical) {
      return false;
    }

    if (entryRisk && entryRisk !== topRisk.id) {
      return false;
    }

    return Number.isFinite(entryConfidence) ? entryConfidence >= 0.78 : true;
  });
  const criticalFromText = hasCriticalEvidence(text);
  const shouldBlockCritical =
    mode === "on"
      ? criticalFromText || criticalFromRecoveredMemory
      : criticalFromText || (criticalFromRecoveredMemory && topRisk.hits >= 2);
  const blocked =
    critical && enforcement === "warn-block-critical" && shouldBlockCritical;
  const reasons = blocked
    ? [`critical-security-risk:${topRisk.id}`]
    : riskMatches.length
      ? [`security-advisory:${topRisk.id}`]
      : [];

  return {
    enabled: true,
    focusMode: mode,
    blocked,
    critical,
    enforcement,
    risk: {
      id: topRisk.id,
      label: topRisk.label,
      severity: topRisk.severity
    },
    rule,
    why,
    fix,
    practice,
    reasons,
    rulesApplied: [topRisk.id]
  };
}

/**
 * @param {{
 *   chunks: Chunk[],
 *   memoryClient: MemoryProvider,
 *   project?: string,
 *   source?: string,
 *   language?: string,
 *   changedFiles?: string[],
 *   minConfidence?: number,
 *   dryRun?: boolean,
 *   strictIsolation?: boolean,
 *   quarantine?: (input: { unit: Record<string, unknown>, reasons: string[] }) => Promise<void>
 * }} input
 */
export async function runSecurityLearningLoop(input) {
  const minConfidence = clamp(
    Number.isFinite(Number(input.minConfidence))
      ? Number(input.minConfidence)
      : DEFAULT_SECURITY_MIN_CONFIDENCE
  );
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  const distilled = chunks.map((chunk) =>
    distillChunkToLearningUnit(chunk, {
      project: input.project,
      source: input.source,
      language: input.language,
      changedFiles: input.changedFiles
    })
  );
  const unique = dedupeUnits(distilled);

  /** @type {Array<{ unit: Record<string, unknown>, reasons: string[] }>} */
  const quarantined = [];
  /** @type {Record<string, unknown>[]} */
  const accepted = [];
  /** @type {string[]} */
  const errors = [];

  for (const unit of unique) {
    const quality = evaluateUnitQuality(unit, minConfidence, {
      strictIsolation: input.strictIsolation !== false,
      language: input.language
    });
    if (!quality.accepted) {
      quarantined.push({
        unit,
        reasons: quality.reasons
      });
      continue;
    }

    accepted.push(unit);
  }

  let saved = 0;
  let criticalAccepted = 0;
  let criticalQuarantined = 0;

  if (!input.dryRun) {
    for (const item of accepted) {
      if (item.critical) {
        criticalAccepted += 1;
      }
      try {
        await input.memoryClient.save({
          title: `Security rule: ${String(item.riskTaxonomy)}`,
          content: buildLearningContent(item),
          type: "security-rule",
          project: String(item.project ?? ""),
          scope: "project",
          topic: `security/${String(item.riskTaxonomyId ?? "security-misconfiguration")}`,
          language: String(item.language ?? "") || undefined,
          sourceKind: "learn-security",
          severity: String(item.severity ?? "unknown"),
          confidence: Number(item.confidence ?? 0),
          riskTaxonomy: String(item.riskTaxonomyId ?? "security-misconfiguration"),
          rule: String(item.rule ?? ""),
          antiPattern: String(item.antiPattern ?? ""),
          fixPattern: String(item.fixPattern ?? ""),
          practicePrompt: String(item.practicePrompt ?? ""),
          securityCritical: item.critical === true,
          reviewStatus: item.critical ? "accepted-critical" : "accepted"
        });
        saved += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (typeof input.quarantine === "function") {
      for (const entry of quarantined) {
        if (entry.unit.critical) {
          criticalQuarantined += 1;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await input.quarantine(entry);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } else {
    criticalAccepted = accepted.filter((entry) => entry.critical === true).length;
    criticalQuarantined = quarantined.filter((entry) => entry.unit.critical === true).length;
  }

  const totalUnits = unique.length || 1;
  const quarantineRate = quarantined.length / totalUnits;

  return {
    action: "learn-security",
    source: compactText(input.source) || "local",
    project: compactText(input.project),
    dryRun: input.dryRun === true,
    minConfidence,
    totalFindings: chunks.length,
    distilledUnits: unique.length,
    acceptedUnits: accepted.length,
    quarantinedUnits: quarantined.length,
    saved,
    criticalAccepted,
    criticalQuarantined,
    securityMemoryGrowth: saved,
    quarantineRate: Number(quarantineRate.toFixed(3)),
    falsePositiveBlockRate: 0,
    entries: accepted,
    quarantined,
    errors
  };
}
