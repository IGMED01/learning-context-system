// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATUS_FILTER = "non-pass";
const DEFAULT_MAX_FINDINGS = 200;

const PASS_PATTERNS = [/^pass$/u, /^passed$/u, /^compliant$/u, /^ok$/u];
const FAIL_PATTERNS = [
  /^fail$/u,
  /^failed$/u,
  /^non.?compliant$/u,
  /^open$/u,
  /^alarm$/u,
  /^critical$/u
];

/**
 * @typedef {"all" | "non-pass" | "fail"} ProwlerStatusFilter
 */

/**
 * @typedef {"pass" | "fail" | "unknown"} ProwlerStatusClass
 */

/**
 * @typedef {{
 *   label: string,
 *   className: ProwlerStatusClass
 * }} ProwlerStatusClassification
 */

/**
 * @typedef {{
 *   statusFilter?: ProwlerStatusFilter,
 *   maxFindings?: number
 * }} ProwlerIngestOptions
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return isRecord(value) ? value : {};
}

/**
 * @param {unknown} value
 */
function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

/**
 * @param {string[]} values
 * @returns {string}
 */
function firstNonEmpty(values) {
  for (const value of values) {
    const cleaned = cleanText(value);

    if (cleaned) {
      return cleaned;
    }
  }

  return "";
}

/**
 * @param {Record<string, unknown>} root
 * @param {string[]} pathParts
 */
function pathValue(root, pathParts) {
  /** @type {unknown} */
  let current = root;

  for (const key of pathParts) {
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

/**
 * @param {Record<string, unknown>} root
 * @param {string[]} dottedPaths
 */
function pickFirstString(root, dottedPaths) {
  for (const expression of dottedPaths) {
    const value = pathValue(root, expression.split("."));

    if (typeof value === "string" && cleanText(value)) {
      return cleanText(value);
    }
  }

  return "";
}

/**
 * @param {Record<string, unknown>} root
 * @param {string[]} dottedPaths
 */
function pickFirstNumber(root, dottedPaths) {
  for (const expression of dottedPaths) {
    const value = pathValue(root, expression.split("."));

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);

      if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * @param {number} value
 * @param {number} [min]
 * @param {number} [max]
 */
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {unknown} value
 * @returns {ProwlerStatusFilter}
 */
export function normalizeProwlerStatusFilter(value) {
  const normalized = cleanText(typeof value === "string" ? value : DEFAULT_STATUS_FILTER).toLowerCase();

  if (normalized === "all" || normalized === "non-pass" || normalized === "fail") {
    return /** @type {ProwlerStatusFilter} */ (normalized);
  }

  throw new Error("Option --status-filter must be one of: all, non-pass, fail.");
}

/**
 * @param {string} rawStatus
 * @returns {ProwlerStatusClassification}
 */
function classifyStatus(rawStatus) {
  const normalized = cleanText(rawStatus).toLowerCase();

  if (!normalized) {
    return {
      label: "unknown",
      className: "unknown"
    };
  }

  if (PASS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      label: normalized,
      className: "pass"
    };
  }

  if (FAIL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      label: normalized,
      className: "fail"
    };
  }

  return {
    label: normalized,
    className: "unknown"
  };
}

/**
 * @param {"pass" | "fail" | "unknown"} statusClass
 * @param {ProwlerStatusFilter} filter
 */
function shouldIncludeStatus(statusClass, filter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "fail") {
    return statusClass === "fail";
  }

  return statusClass !== "pass";
}

/**
 * @param {string} value
 * @param {string} fallback
 */
function normalizeIdentifier(value, fallback) {
  const normalized = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectSeverity(finding) {
  const label = pickFirstString(finding, [
    "metadata.Severity.value",
    "metadata.Severity.Label",
    "Severity.Label",
    "severity",
    "severity_label"
  ]);

  const numeric = pickFirstNumber(finding, ["severity_id", "Severity.Normalized"]);
  const lowered = label.toLowerCase();

  if (lowered.includes("critical")) {
    return { label: label || "critical", score: 1 };
  }

  if (lowered.includes("high")) {
    return { label: label || "high", score: 0.92 };
  }

  if (lowered.includes("medium")) {
    return { label: label || "medium", score: 0.78 };
  }

  if (lowered.includes("low")) {
    return { label: label || "low", score: 0.62 };
  }

  if (lowered.includes("informational") || lowered.includes("info")) {
    return { label: label || "info", score: 0.45 };
  }

  if (numeric !== null) {
    if (numeric >= 80) {
      return { label: label || "high", score: 0.9 };
    }

    if (numeric >= 50) {
      return { label: label || "medium", score: 0.76 };
    }

    if (numeric > 0) {
      return { label: label || "low", score: 0.58 };
    }
  }

  return { label: label || "unknown", score: 0.5 };
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectProvider(finding) {
  return firstNonEmpty([
    pickFirstString(finding, ["metadata.Provider", "provider", "provider_name", "ProviderName"]),
    "unknown"
  ]);
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectCheckId(finding) {
  return firstNonEmpty([
    pickFirstString(finding, [
      "metadata.CheckID",
      "check_id",
      "checkid",
      "GeneratorId",
      "generator_id"
    ])
  ]);
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectTitle(finding) {
  return firstNonEmpty([
    pickFirstString(finding, [
      "metadata.CheckTitle",
      "check_title",
      "Title",
      "title",
      "finding_title"
    ]),
    "Security control finding"
  ]);
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectStatus(finding) {
  return firstNonEmpty([
    pickFirstString(finding, ["status.value", "status", "Compliance.Status", "compliance_status"]),
    "unknown"
  ]);
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectResource(finding) {
  const resourceList = pathValue(finding, ["Resources"]);

  if (Array.isArray(resourceList) && resourceList.length) {
    const first = asRecord(resourceList[0]);
    const fromArray = firstNonEmpty([
      pickFirstString(first, ["Id", "id"]),
      pickFirstString(first, ["Type", "type"])
    ]);

    if (fromArray) {
      return fromArray;
    }
  }

  return firstNonEmpty([
    pickFirstString(finding, [
      "resource_uid",
      "resource",
      "resource_name",
      "metadata.ResourceId",
      "ResourceId"
    ])
  ]);
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectRisk(finding) {
  return firstNonEmpty([
    pickFirstString(finding, ["metadata.Risk", "risk", "Risk", "description", "Description"])
  ]);
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectRemediation(finding) {
  const text = firstNonEmpty([
    pickFirstString(finding, [
      "metadata.Remediation.Recommendation.Text",
      "Remediation.Recommendation.Text",
      "remediation",
      "fix"
    ])
  ]);
  const link = firstNonEmpty([
    pickFirstString(finding, [
      "metadata.Remediation.Recommendation.Url",
      "Remediation.Recommendation.Url",
      "reference_url"
    ])
  ]);

  if (text && link) {
    return `${text} (${link})`;
  }

  return text || link;
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectCompliance(finding) {
  const compliance = pathValue(finding, ["metadata", "Compliance"]);

  if (isRecord(compliance)) {
    const parts = [];

    for (const [framework, value] of Object.entries(compliance)) {
      if (Array.isArray(value) && value.length) {
        parts.push(`${framework}:${value.slice(0, 3).join("|")}`);
      } else if (typeof value === "string" && cleanText(value)) {
        parts.push(`${framework}:${cleanText(value)}`);
      }
    }

    return parts.slice(0, 4).join(", ");
  }

  const fallback = pathValue(finding, ["Compliance"]);

  if (isRecord(fallback)) {
    const status = pickFirstString(fallback, ["Status"]);
    return status ? `Status:${status}` : "";
  }

  if (typeof fallback === "string") {
    return cleanText(fallback);
  }

  return "";
}

/**
 * @param {Record<string, unknown>} finding
 */
function detectTimestamp(finding) {
  const timestamp = pickFirstString(finding, [
    "updated_at",
    "created_at",
    "ProcessedAt",
    "UpdatedAt",
    "FirstObservedAt",
    "timestamp",
    "metadata.Timestamp"
  ]);

  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * @param {number | null} timestampMs
 */
function recencyFromTimestamp(timestampMs) {
  if (!timestampMs) {
    return 0.7;
  }

  const daysOld = Math.max(0, (Date.now() - timestampMs) / (1000 * 60 * 60 * 24));
  return clamp(1 - daysOld / 180, 0.35, 1);
}

/**
 * @param {string} text
 * @param {number} [maxLength]
 */
function cutText(text, maxLength = 280) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/**
 * @param {Record<string, unknown>} finding
 * @param {number} index
 */
function findingToChunk(finding, index) {
  const provider = detectProvider(finding);
  const checkId = detectCheckId(finding);
  const title = detectTitle(finding);
  const statusRaw = detectStatus(finding);
  const status = classifyStatus(statusRaw);
  const severity = detectSeverity(finding);
  const resource = detectResource(finding);
  const risk = detectRisk(finding);
  const remediation = detectRemediation(finding);
  const compliance = detectCompliance(finding);
  const timestamp = detectTimestamp(finding);
  const safeCheck = normalizeIdentifier(checkId || title, `finding-${index + 1}`);
  const safeProvider = normalizeIdentifier(provider, "unknown");

  const lines = [
    `Prowler finding: ${title}`,
    `Status: ${status.label}`,
    `Provider: ${provider}`,
    `Check: ${checkId || "unknown"}`,
    `Severity: ${severity.label}`
  ];

  if (resource) {
    lines.push(`Resource: ${resource}`);
  }

  if (risk) {
    lines.push(`Risk: ${cutText(risk)}`);
  }

  if (remediation) {
    lines.push(`Remediation: ${cutText(remediation)}`);
  }

  if (compliance) {
    lines.push(`Compliance: ${cutText(compliance)}`);
  }

  return {
    id: `prowler-${safeProvider}-${safeCheck}-${index + 1}`,
    source: `security://prowler/${safeProvider}/${safeCheck}`,
    kind: "spec",
    content: lines.join(". "),
    certainty: checkId ? 0.92 : 0.78,
    recency: recencyFromTimestamp(timestamp),
    teachingValue: clamp(0.35 + severity.score * 0.65),
    priority: clamp(0.3 + severity.score * 0.7)
  };
}

/**
 * @param {unknown} payload
 */
function extractFindings(payload) {
  if (Array.isArray(payload)) {
    return {
      detectedFormat: "json-array",
      findings: payload
    };
  }

  if (!isRecord(payload)) {
    throw new Error("Prowler input must be a JSON array or an object containing findings.");
  }

  if (Array.isArray(payload.findings)) {
    return {
      detectedFormat: "json-findings",
      findings: payload.findings
    };
  }

  if (Array.isArray(payload.Findings)) {
    return {
      detectedFormat: "json-asff",
      findings: payload.Findings
    };
  }

  if (Array.isArray(payload.items)) {
    return {
      detectedFormat: "json-items",
      findings: payload.items
    };
  }

  throw new Error("No findings array found. Expected one of: [], findings[], Findings[], items[].");
}

/**
 * @param {unknown} payload
 * @param {ProwlerIngestOptions} [options]
 */
export function prowlerFindingsToChunkFile(payload, options = {}) {
  const statusFilter = normalizeProwlerStatusFilter(options.statusFilter ?? DEFAULT_STATUS_FILTER);
  const maxFindings = Number.isInteger(options.maxFindings)
    ? Math.max(1, /** @type {number} */ (options.maxFindings))
    : DEFAULT_MAX_FINDINGS;
  const extracted = extractFindings(payload);
  const limited = extracted.findings.slice(0, maxFindings);
  const chunks = [];
  let skippedFindings = 0;

  for (const [index, item] of limited.entries()) {
    const finding = asRecord(item);
    const status = classifyStatus(detectStatus(finding));

    if (!shouldIncludeStatus(status.className, statusFilter)) {
      skippedFindings += 1;
      continue;
    }

    chunks.push(findingToChunk(finding, index));
  }

  return {
    detectedFormat: extracted.detectedFormat,
    statusFilter,
    maxFindings,
    totalFindings: extracted.findings.length,
    includedFindings: chunks.length,
    skippedFindings: skippedFindings + Math.max(0, extracted.findings.length - limited.length),
    chunks
  };
}

/**
 * @param {string} filePath
 * @param {ProwlerIngestOptions} [options]
 */
export async function ingestProwlerFile(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const raw = await readFile(resolvedPath, "utf8").catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Prowler file '${resolvedPath}': ${message}`);
  });

  let parsed;

  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Prowler file '${resolvedPath}' is not valid JSON: ${message}`);
  }

  const converted = prowlerFindingsToChunkFile(parsed, options);

  return {
    inputPath: resolvedPath,
    ...converted
  };
}
