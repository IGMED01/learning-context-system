// @ts-check

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @param {string} value
 */
function decodeBase64Url(value) {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4 || 4)) % 4)}`;
  return Buffer.from(padded, "base64");
}

/**
 * @param {unknown} value
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} payload
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, value: Record<string, unknown> }}
 */
function parseJsonObject(payload) {
  try {
    const parsed = JSON.parse(payload);
    if (!isRecord(parsed)) {
      return {
        ok: false,
        value: {}
      };
    }
    return {
      ok: true,
      value: parsed
    };
  } catch {
    return {
      ok: false,
      value: {}
    };
  }
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
  const parts = token.split(".");
  const issuer = String(options.issuer ?? "").trim();
  const audiences = Array.isArray(options.audiences)
    ? options.audiences.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const clockSkewSeconds = Number.isFinite(Number(options.clockSkewSeconds))
    ? Math.max(0, Math.trunc(Number(options.clockSkewSeconds)))
    : 30;
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (parts.length !== 3) {
    return {
      valid: false,
      reason: "malformed-token",
      payload: {}
    };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const headerJson = decodeBase64Url(encodedHeader).toString("utf8");
  const parsedHeader = parseJsonObject(headerJson);
  const header = parsedHeader.value;

  if (!parsedHeader.ok) {
    return {
      valid: false,
      reason: "malformed-token",
      payload: {}
    };
  }

  if (typeof header.alg !== "string" || header.alg.toUpperCase() !== "HS256") {
    return {
      valid: false,
      reason: "invalid-algorithm",
      payload: {}
    };
  }

  if (
    header.typ !== undefined &&
    (typeof header.typ !== "string" || header.typ.toUpperCase() !== "JWT")
  ) {
    return {
      valid: false,
      reason: "invalid-token-type",
      payload: {}
    };
  }

  const expected = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const signature = decodeBase64Url(encodedSignature);

  if (
    expected.length !== signature.length ||
    !timingSafeEqual(expected, signature)
  ) {
    return {
      valid: false,
      reason: "invalid-signature",
      payload: {}
    };
  }

  const payloadJson = decodeBase64Url(encodedPayload).toString("utf8");
  const parsedPayload = parseJsonObject(payloadJson);
  const payload = parsedPayload.value;

  if (!parsedPayload.ok) {
    return {
      valid: false,
      reason: "malformed-token",
      payload: {}
    };
  }

  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + clockSkewSeconds) {
    return {
      valid: false,
      reason: "token-not-active",
      payload
    };
  }

  if (typeof payload.iat === "number" && payload.iat > nowSeconds + clockSkewSeconds) {
    return {
      valid: false,
      reason: "invalid-issued-at",
      payload
    };
  }

  if (typeof payload.exp === "number" && nowSeconds >= payload.exp + clockSkewSeconds) {
    return {
      valid: false,
      reason: "token-expired",
      payload
    };
  }

  if (issuer) {
    if (typeof payload.iss !== "string" || payload.iss.trim() !== issuer) {
      return {
        valid: false,
        reason: "invalid-issuer",
        payload
      };
    }
  }

  if (audiences.length > 0) {
    const tokenAudiences = Array.isArray(payload.aud)
      ? payload.aud.filter((entry) => typeof entry === "string").map((entry) => entry.trim())
      : typeof payload.aud === "string"
        ? [payload.aud.trim()]
        : [];
    const audienceMatched = tokenAudiences.some((entry) => audiences.includes(entry));

    if (!audienceMatched) {
      return {
        valid: false,
        reason: "invalid-audience",
        payload
      };
    }
  }

  return {
    valid: true,
    reason: "",
    payload
  };
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
