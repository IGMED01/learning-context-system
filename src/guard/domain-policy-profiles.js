// @ts-check

/**
 * @typedef {{
 *   maxOutputChars?: number,
 *   blockOnSecretSignal?: boolean,
 *   blockOnPolicyTerms?: string[],
 *   domainScope?: {
 *     allowedDomains?: string[],
 *     blockedDomains?: string[]
 *   }
 * }} DomainGuardPolicy
 */

const POLICY_PROFILES = /** @type {Record<string, DomainGuardPolicy>} */ ({
  default: {
    maxOutputChars: 8000,
    blockOnSecretSignal: true,
    blockOnPolicyTerms: [],
    domainScope: {
      allowedDomains: [],
      blockedDomains: []
    }
  },
  security_strict: {
    maxOutputChars: 6000,
    blockOnSecretSignal: true,
    blockOnPolicyTerms: ["private key", "internal secret", "production credential"],
    domainScope: {
      blockedDomains: ["data"]
    }
  },
  public_docs: {
    maxOutputChars: 10000,
    blockOnSecretSignal: true,
    blockOnPolicyTerms: ["token dump", "raw credential"],
    domainScope: {
      blockedDomains: ["security", "data"]
    }
  },
  observability_safe: {
    maxOutputChars: 9000,
    blockOnSecretSignal: true,
    blockOnPolicyTerms: ["secret", "password", "api key"],
    domainScope: {
      allowedDomains: ["observability", "api"]
    }
  }
});

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} input
 */
function toStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

/**
 * @param {DomainGuardPolicy} policy
 */
function normalizePolicy(policy) {
  const domainScope = asRecord(policy.domainScope);

  return {
    maxOutputChars:
      typeof policy.maxOutputChars === "number" && Number.isFinite(policy.maxOutputChars)
        ? policy.maxOutputChars
        : undefined,
    blockOnSecretSignal:
      typeof policy.blockOnSecretSignal === "boolean" ? policy.blockOnSecretSignal : undefined,
    blockOnPolicyTerms: toStringArray(policy.blockOnPolicyTerms),
    domainScope: {
      allowedDomains: toStringArray(domainScope.allowedDomains),
      blockedDomains: toStringArray(domainScope.blockedDomains)
    }
  };
}

/**
 * @param {string | undefined} name
 */
export function getDomainGuardPolicyProfile(name = "") {
  const requested = String(name || "").trim().toLowerCase();
  const resolvedName = requested && requested in POLICY_PROFILES ? requested : "default";

  return {
    name: resolvedName,
    policy: normalizePolicy(POLICY_PROFILES[resolvedName])
  };
}

export function listDomainGuardPolicyProfiles() {
  return Object.keys(POLICY_PROFILES).sort((left, right) => left.localeCompare(right));
}

/**
 * @param {string | undefined} profile
 * @param {Record<string, unknown>} overrides
 */
export function resolveDomainGuardPolicy(profile, overrides = {}) {
  const selected = getDomainGuardPolicyProfile(profile).policy;
  const mergedScope = asRecord(overrides.domainScope);

  return {
    ...selected,
    ...overrides,
    blockOnPolicyTerms: [
      ...selected.blockOnPolicyTerms,
      ...toStringArray(overrides.blockOnPolicyTerms)
    ],
    domainScope: {
      allowedDomains: toStringArray(mergedScope.allowedDomains).length
        ? toStringArray(mergedScope.allowedDomains)
        : selected.domainScope.allowedDomains,
      blockedDomains: toStringArray(mergedScope.blockedDomains).length
        ? toStringArray(mergedScope.blockedDomains)
        : selected.domainScope.blockedDomains
    }
  };
}