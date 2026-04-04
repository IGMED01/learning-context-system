// @ts-check

/**
 * @typedef {"allow" | "deny" | "defer"} ToolPermissionDecision
 */

/**
 * @typedef {{
 *   tool: string,
 *   scope?: string,
 *   metadata?: Record<string, unknown>
 * }} ToolPermissionRequest
 */

/**
 * @typedef {{
 *   allowed: boolean,
 *   decision: "allow" | "deny",
 *   source: "hook" | "classifier" | "user" | "default",
 *   reason: string
 * }} ToolPermissionResult
 */

/**
 * @typedef {{
 *   hook?: (request: ToolPermissionRequest) => Promise<ToolPermissionDecision | string | null | undefined> | ToolPermissionDecision | string | null | undefined,
 *   classifier?: (request: ToolPermissionRequest) => Promise<ToolPermissionDecision | string | null | undefined> | ToolPermissionDecision | string | null | undefined,
 *   user?: (request: ToolPermissionRequest) => Promise<ToolPermissionDecision | string | null | undefined> | ToolPermissionDecision | string | null | undefined,
 *   defaultDecision?: "allow" | "deny",
 *   keyResolver?: (request: ToolPermissionRequest) => string
 * }} ToolPermissionContextOptions
 */

/**
 * @param {unknown} value
 * @returns {ToolPermissionDecision}
 */
function normalizeDecision(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "allow" || normalized === "deny" || normalized === "defer") {
    return normalized;
  }

  return "defer";
}

/**
 * @param {(request: ToolPermissionRequest) => Promise<ToolPermissionDecision | string | null | undefined> | ToolPermissionDecision | string | null | undefined} [resolver]
 * @param {ToolPermissionRequest} request
 */
async function resolveDecision(resolver, request) {
  if (typeof resolver !== "function") {
    return "defer";
  }

  const decision = await resolver(request);
  return normalizeDecision(decision);
}

/**
 * Resolve-once wrapper keyed by a request identity.
 *
 * @param {ToolPermissionContextOptions} [options]
 */
export function createPermissionContext(options = {}) {
  const defaultDecision = options.defaultDecision === "deny" ? "deny" : "allow";
  const keyResolver =
    typeof options.keyResolver === "function"
      ? options.keyResolver
      : (request) => `${request.scope ?? "global"}::${request.tool}`;
  /** @type {Map<string, Promise<ToolPermissionResult>>} */
  const inFlight = new Map();

  /**
   * @param {ToolPermissionRequest} request
   */
  async function resolveInternal(request) {
    const hookDecision = await resolveDecision(options.hook, request);
    if (hookDecision !== "defer") {
      return {
        allowed: hookDecision === "allow",
        decision: hookDecision,
        source: "hook",
        reason: `resolved by hook (${hookDecision})`
      };
    }

    const classifierDecision = await resolveDecision(options.classifier, request);
    if (classifierDecision !== "defer") {
      return {
        allowed: classifierDecision === "allow",
        decision: classifierDecision,
        source: "classifier",
        reason: `resolved by classifier (${classifierDecision})`
      };
    }

    const userDecision = await resolveDecision(options.user, request);
    if (userDecision !== "defer") {
      return {
        allowed: userDecision === "allow",
        decision: userDecision,
        source: "user",
        reason: `resolved by user (${userDecision})`
      };
    }

    return {
      allowed: defaultDecision === "allow",
      decision: defaultDecision,
      source: "default",
      reason: `resolved by default (${defaultDecision})`
    };
  }

  return {
    /**
     * Resolve permission atomically for a given request key.
     *
     * @param {ToolPermissionRequest} request
     * @returns {Promise<ToolPermissionResult>}
     */
    async resolve(request) {
      const key = keyResolver(request);
      if (inFlight.has(key)) {
        return inFlight.get(key);
      }

      const pending = resolveInternal(request).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
      return pending;
    }
  };
}

/**
 * Build a permission context from a static blocked-tools list.
 *
 * @param {{ blockedTools?: string[], defaultDecision?: "allow" | "deny" }} [options]
 */
export function createStaticToolPermissionContext(options = {}) {
  const blocked = new Set(
    (options.blockedTools ?? [])
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter(Boolean)
  );

  return createPermissionContext({
    defaultDecision: options.defaultDecision ?? "allow",
    classifier: (request) => {
      const tool = String(request.tool ?? "").trim().toLowerCase();
      if (tool && blocked.has(tool)) {
        return "deny";
      }

      return "defer";
    }
  });
}

