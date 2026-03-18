import type {
  SecretRedactionBreakdown,
  SecretRedactionResult,
  SecurityScanStats
} from "../types/core-contracts.d.ts";

export interface SecurityPolicyInput {
  ignoreSensitiveFiles?: boolean;
  redactSensitiveContent?: boolean;
  ignoreGeneratedFiles?: boolean;
  allowSensitivePaths?: string[];
  extraSensitivePathFragments?: string[];
}

export interface SecurityPolicy {
  ignoreSensitiveFiles: boolean;
  redactSensitiveContent: boolean;
  ignoreGeneratedFiles: boolean;
  allowSensitivePaths: string[];
  extraSensitivePathFragments: string[];
}

const SENSITIVE_EXACT_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_dsa",
  "id_ed25519",
  "terraform.tfvars",
  "terraform.tfvars.json"
]);

const SENSITIVE_SUFFIXES = [
  ".pem",
  ".key",
  ".pfx",
  ".crt",
  ".cer",
  ".tfvars",
  ".tfvars.json"
];

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/u,
  /(^|\/)\.aws\/credentials$/u,
  /(^|\/)\.docker\/config\.json$/u,
  /(^|\/)\.kube\/config$/u,
  /(^|\/)secrets?\//u,
  /(^|\/)private\//u
];

const PRIVATE_BLOCK_PATTERNS = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gu
];

const INLINE_SECRET_PATTERNS = [
  /(api[_-]?key\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu,
  /(access[_-]?token\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu,
  /(refresh[_-]?token\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu,
  /(client[_-]?secret\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu,
  /(password\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu,
  /(secret\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu,
  /(authorization\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu
];

const CONNECTION_STRING_PATTERNS = [
  /((?:database|db|redis|mongo(?:db)?|amqp|kafka|connection|dsn|url)[\w.-]*\s*[:=]\s*["'`])([^"'`\r\n]+)(["'`])/giu
];

const TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /sk-(?:live|test)?[A-Za-z0-9]{16,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gu
];

const JWT_LIKE_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/gu;

const DEFAULT_SECURITY_POLICY: Readonly<SecurityPolicy> = Object.freeze({
  ignoreSensitiveFiles: true,
  redactSensitiveContent: true,
  ignoreGeneratedFiles: true,
  allowSensitivePaths: [],
  extraSensitivePathFragments: []
});

export function createSecurityScanStats(): SecurityScanStats {
  return {
    ignoredSensitiveFiles: 0,
    privateBlocks: 0,
    inlineSecrets: 0,
    tokenPatterns: 0,
    jwtLike: 0,
    connectionStrings: 0
  };
}

function createBreakdown(): SecretRedactionBreakdown {
  return {
    privateBlocks: 0,
    inlineSecrets: 0,
    tokenPatterns: 0,
    jwtLike: 0,
    connectionStrings: 0
  };
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function resolveSecurityPolicy(policy: SecurityPolicyInput = {}): SecurityPolicy {
  return {
    ignoreSensitiveFiles:
      policy.ignoreSensitiveFiles ?? DEFAULT_SECURITY_POLICY.ignoreSensitiveFiles,
    redactSensitiveContent:
      policy.redactSensitiveContent ?? DEFAULT_SECURITY_POLICY.redactSensitiveContent,
    ignoreGeneratedFiles:
      policy.ignoreGeneratedFiles ?? DEFAULT_SECURITY_POLICY.ignoreGeneratedFiles,
    allowSensitivePaths: Array.isArray(policy.allowSensitivePaths)
      ? policy.allowSensitivePaths
          .map((entry) => toPosixPath(entry).trim().toLowerCase())
          .filter(Boolean)
      : [...DEFAULT_SECURITY_POLICY.allowSensitivePaths],
    extraSensitivePathFragments: Array.isArray(policy.extraSensitivePathFragments)
      ? policy.extraSensitivePathFragments
          .map((entry) => toPosixPath(entry).trim().toLowerCase())
          .filter(Boolean)
      : [...DEFAULT_SECURITY_POLICY.extraSensitivePathFragments]
  };
}

function isAllowlistedSensitivePath(source: string, policy: SecurityPolicy): boolean {
  const normalized = toPosixPath(source).toLowerCase();

  return policy.allowSensitivePaths.some((candidate) => {
    if (!candidate) {
      return false;
    }

    return normalized === candidate || normalized.endsWith(`/${candidate}`);
  });
}

function matchesExtraSensitivePathFragment(source: string, policy: SecurityPolicy): boolean {
  const normalized = toPosixPath(source).toLowerCase();
  return policy.extraSensitivePathFragments.some((fragment) => normalized.includes(fragment));
}

export function isSensitivePathAllowlisted(
  source: string,
  policy?: SecurityPolicyInput
): boolean {
  return isAllowlistedSensitivePath(source, resolveSecurityPolicy(policy));
}

export function shouldIgnoreSensitiveFile(source: string, policy?: SecurityPolicyInput): boolean {
  const resolvedPolicy = resolveSecurityPolicy(policy);

  if (!resolvedPolicy.ignoreSensitiveFiles) {
    return false;
  }

  if (isAllowlistedSensitivePath(source, resolvedPolicy)) {
    return false;
  }

  const normalized = toPosixPath(source).toLowerCase();
  const basename = normalized.split("/").pop() ?? "";

  if (matchesExtraSensitivePathFragment(normalized, resolvedPolicy)) {
    return true;
  }

  if (SENSITIVE_EXACT_FILENAMES.has(basename)) {
    return true;
  }

  if (SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }

  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function redactPrivateBlocks(content: string): {
  content: string;
  breakdown: SecretRedactionBreakdown;
} {
  const breakdown = createBreakdown();
  let redacted = content;

  for (const pattern of PRIVATE_BLOCK_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      breakdown.privateBlocks += 1;
      return "[REDACTED_PRIVATE_KEY_BLOCK]";
    });
  }

  return { content: redacted, breakdown };
}

function replaceWholeMatches(
  content: string,
  patterns: RegExp[],
  kind: "tokenPatterns" | "jwtLike",
  replacement: string,
  breakdown: SecretRedactionBreakdown
): string {
  let redacted = content;

  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, () => {
      breakdown[kind] += 1;
      return replacement;
    });
  }

  return redacted;
}

function replaceQuotedAssignments(
  content: string,
  patterns: RegExp[],
  kind: "inlineSecrets" | "connectionStrings",
  breakdown: SecretRedactionBreakdown
): string {
  let redacted = content;

  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (_match, prefix: string, _value, suffix: string) => {
      breakdown[kind] += 1;
      return `${prefix}[REDACTED]${suffix}`;
    });
  }

  return redacted;
}

export function redactSensitiveContent(raw: string, policy?: SecurityPolicyInput): SecretRedactionResult {
  const resolvedPolicy = resolveSecurityPolicy(policy);

  if (!resolvedPolicy.redactSensitiveContent) {
    return {
      content: raw,
      redacted: false,
      redactionCount: 0,
      breakdown: createBreakdown()
    };
  }

  const privateBlocks = redactPrivateBlocks(raw);
  const breakdown = privateBlocks.breakdown;

  let redacted = privateBlocks.content;
  redacted = replaceQuotedAssignments(redacted, INLINE_SECRET_PATTERNS, "inlineSecrets", breakdown);
  redacted = replaceQuotedAssignments(
    redacted,
    CONNECTION_STRING_PATTERNS,
    "connectionStrings",
    breakdown
  );
  redacted = replaceWholeMatches(redacted, TOKEN_PATTERNS, "tokenPatterns", "[REDACTED_TOKEN]", breakdown);
  redacted = replaceWholeMatches(redacted, [JWT_LIKE_PATTERN], "jwtLike", "[REDACTED_JWT]", breakdown);

  const redactionCount = Object.values(breakdown).reduce((total, value) => total + value, 0);

  if (!redactionCount) {
    return {
      content: raw,
      redacted: false,
      redactionCount: 0,
      breakdown
    };
  }

  return {
    content: `${redacted}\n\n/* redacted secrets: ${redactionCount} */`,
    redacted: true,
    redactionCount,
    breakdown
  };
}
