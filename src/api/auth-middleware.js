// @ts-check

import jwt from "jsonwebtoken";

/**
 * @param {unknown} value
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const JWT_ALGORITHMS = ["HS256"];

/**
 * @param {unknown} error
 */
function mapJwtReason(error) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  const code =
    typeof error === "object" &&
    error &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "";

  if (code === "TokenExpiredError" || /expired/.test(message)) {
    return "token-expired";
  }

  if (code === "NotBeforeError" || /not active/.test(message)) {
    return "token-not-active";
  }

  if (/invalid algorithm/i.test(message)) {
    return "invalid-algorithm";
  }

  if (/invalid issuer/i.test(message)) {
    return "invalid-issuer";
  }

  if (/invalid audience|audience invalid|jwt audience invalid/i.test(message)) {
    return "invalid-audience";
  }

  if (/invalid signature/i.test(message)) {
    return "invalid-signature";
  }

  if (/jwt malformed|invalid token|jwt must be provided|invalid compact jwt/i.test(message)) {
    return "malformed-token";
  }

  return "invalid-token";
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{
 *   issuer?: string,
 *   audiences?: string[],
 *   clockSkewSeconds?: number
 * }} [options]
 */
function verifyHs256Token(token, secret, options = {}) {
  const issuer = String(options.issuer ?? "").trim();
  const audiences = Array.isArray(options.audiences)
    ? options.audiences.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const clockSkewSeconds = Number.isFinite(Number(options.clockSkewSeconds))
    ? Math.max(0, Math.trunc(Number(options.clockSkewSeconds)))
    : 30;

  try {
    const verified = jwt.verify(token, secret, {
      algorithms: JWT_ALGORITHMS,
      clockTolerance: clockSkewSeconds,
      issuer: issuer || undefined,
      audience: audiences.length ? audiences : undefined
    });
    const payload = isRecord(verified) ? verified : {};
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (typeof payload.iat === "number" && payload.iat > nowSeconds + clockSkewSeconds) {
      return {
        valid: false,
        reason: "invalid-issued-at",
        payload
      };
    }

    return {
      valid: true,
      reason: "",
      payload
    };
  } catch (error) {
    return {
      valid: false,
      reason: mapJwtReason(error),
      payload: {}
    };
  }
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} key
 */
function readHeader(headers, key) {
  const value = headers[key.toLowerCase()] ?? headers[key];

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return typeof value === "string" ? value : "";
}

/**
 * NEXUS:10 — API key / JWT authentication middleware.
 * @param {{
 *   apiKeys?: string[],
 *   jwtSecret?: string,
 *   jwtIssuer?: string,
 *   jwtAudience?: string | string[],
 *   jwtClockSkewSeconds?: number,
 *   requireAuth?: boolean
 * }} [options]
 */
export function createAuthMiddleware(options = {}) {
  const apiKeys = new Set(
    (options.apiKeys ?? [])
      .map((entry) => String(entry).trim())
      .filter(Boolean)
  );
  const jwtSecret = String(options.jwtSecret ?? "").trim();
  const jwtIssuer = String(options.jwtIssuer ?? "").trim();
  const jwtAudiences = Array.isArray(options.jwtAudience)
    ? options.jwtAudience.map((entry) => String(entry).trim()).filter(Boolean)
    : String(options.jwtAudience ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const jwtClockSkewSeconds = Number.isFinite(Number(options.jwtClockSkewSeconds))
    ? Math.max(0, Math.trunc(Number(options.jwtClockSkewSeconds)))
    : 30;
  const requireAuth = options.requireAuth !== false;

  return {
    /**
     * @param {{ headers: Record<string, string | string[] | undefined> }} request
     */
    authorize(request) {
      if (!requireAuth) {
        return {
          authorized: true,
          principal: {
            type: "anonymous"
          },
          reason: "auth-disabled"
        };
      }

      const apiKey = readHeader(request.headers, "x-api-key");

      if (apiKey && apiKeys.has(apiKey)) {
        return {
          authorized: true,
          principal: {
            type: "api-key"
          },
          reason: "api-key"
        };
      }

      const authHeader = readHeader(request.headers, "authorization");
      const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/iu);

      if (tokenMatch && jwtSecret) {
        const verified = verifyHs256Token(tokenMatch[1], jwtSecret, {
          issuer: jwtIssuer,
          audiences: jwtAudiences,
          clockSkewSeconds: jwtClockSkewSeconds
        });

        if (verified.valid) {
          return {
            authorized: true,
            principal: {
              type: "jwt",
              claims: verified.payload
            },
            reason: "jwt"
          };
        }

        return {
          authorized: false,
          statusCode: 401,
          error: `Invalid token (${verified.reason}).`,
          reason: verified.reason
        };
      }

      return {
        authorized: false,
        statusCode: 401,
        error: "Authentication required.",
        reason: "missing-credentials"
      };
    }
  };
}
