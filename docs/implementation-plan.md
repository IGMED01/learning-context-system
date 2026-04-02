# NEXUS Implementation Plan — Hardening + Architecture + Visibility

**Versión:** 3.0
**Fecha:** 2026-04-01
**Duración estimada:** 13 días (~68 horas)
**Objetivo:** Transformar NEXUS de "demo impresionante" a "sistema production-ready"

> **v3.0 vs v2.0:** Incorpora 16 patrones adicionales descubiertos en análisis profundo del source completo de referencia: Memory Directory System, Memory Staleness, Memory Scanning, Auto-Compact con circuit breaker, Cost Tracking por provider, Background Agent Summarization, Migration files individuales, y mejoras a Token Estimation. Se agregan Fases 2.6, 3.5, 3.6, y 7.0. El principio clean-room se mantiene estricto.

---

## Principios de Ejecución

1. **Clean-room**: Los patrones de Claude Code se re-implementan desde cero. Nunca copiar código.
2. **No romper contratos**: Ningún cambio modifica respuestas de API existentes.
3. **Feature flags primero**: Todo cambio nuevo detrás de un flag `LCS_*` desactivado por defecto.
4. **Tests antes que código**: Cada módulo nuevo tiene tests antes de integrarse.
5. **Orden estricto**: No saltar fases. Cada fase es prerequisito de la siguiente.
6. **JS primero, TS después**: Los módulos nuevos en `.js` (ESM). La migración a TypeScript es una decisión separada que no bloquea este plan. Los archivos `.ts` existentes no se tocan salvo que la fase lo requiera explícitamente.
7. **Una abstracción por problema**: No crear dos implementaciones de lo mismo. Si ya existe `fs-safe.ts` (Fase 5.0), usarla en todos lados.

---

## Mapa de Vulnerabilidades

> Reemplaza las referencias a `docs/security-master.md` y `docs/nexus-hardening-checklist.md` que no existen en el repo.

| ID | Severidad | Descripción | Fase que lo resuelve |
|----|-----------|-------------|----------------------|
| C1 | Crítica | `/api/demo` público sin auth en producción | 1.6 |
| C2 | Crítica | Subprocess hereda todo `process.env` (API keys expuestas) | 1.1 |
| C3 | Crítica | Chunks inyectados en prompts sin sanitizar (prompt injection) | 1.2 |
| H1 | Alta | Path traversal con regex frágil en vez de resolución absoluta | 1.3 |
| H2 | Alta | 6 catch blocks silenciosos — errores no registrados | 1.4 |
| H3 | Alta | JWT implementado manualmente (sin validar `iss`, `aud`, `nbf`) | 1.5 |
| H4 | Alta | CORS wildcard `*` habilitado | 5.2 |
| H5 | Alta | CSP con `unsafe-inline` | 5.2 |
| H6 | Alta | `connect-src` sin restricción de dominio | 5.2 |
| M1 | Media | Escrituras de memoria no atómicas (corrupción en crash) | 5.1 |
| M2 | Media | Errores 500 exponen stack traces al cliente | 5.3 |
| M3 | Media | Request IDs predecibles (`Date.now` + `Math.random`) | 5.4 |
| M4 | Media | Sin timeout de requests — servidor colgable | 1.7 |
| M5 | Media | `appendFileSync` bloquea el event loop en auditor | 2.3 |
| M6 | Media | Escaneo de workspace secuencial (bottleneck de I/O) | 2.5 |
| KB1 | Baja | 14 funciones duplicadas en el codebase | 0.1 |
| KB2 | Baja | `handlers.js` crece con cada endpoint nuevo (sin registry) | 2.0 |
| KB3 | Baja | `code-gate.js` de 597 líneas ejecuta herramientas en serie | 2.4 |

---

## Patrones Adicionales — Análisis Profundo del Source de Referencia

> Descubiertos en análisis de directorios `memdir/`, `migrations/`, `services/`, `coordinator/` y archivos raíz (`QueryEngine.ts`, `cost-tracker.ts`, `history.ts`, `tasks.ts`). Todos se re-implementan desde cero (clean-room).

| Patrón | Archivo fuente | Dónde aplica en NEXUS | Fase |
|--------|---------------|----------------------|------|
| **Memory Entrypoint Indexing** | `memdir/memdir.ts` | ENGRAM.md como índice, topic files como storage. Truncation dual (200 líneas Y 25KB) | 3.5 |
| **Memory Staleness Detection** | `memdir/memoryAge.ts` | Tag mtime en Engrams, freshness caveat en retrieval | 3.5 |
| **Memory File Scanning** | `memdir/memoryScan.ts` | `Promise.allSettled` + cap 200 archivos + single-pass header | 2.5 (mejorado) |
| **Auto-Compact Thresholds** | `services/compact/autoCompact.ts` | Tiered context: proactive → warning → error → blocking. Circuit breaker | 2.6 |
| **Memory Extraction Forked Agent** | `services/extractMemories/` | Extracción de Engrams como agente forked, cursor-based dedup, sandbox canUseTool | 3.5 |
| **Cost Tracker per Provider** | `cost-tracker.ts` | Tracking de costos por modelo/provider, session restoration, cache tokens | 7.0 |
| **Token Estimation File-Aware** | `services/tokenEstimation.ts` | JSON → 2 bytes/token vs 4 bytes/token default. Fallback cascade | 0.1 (mejorado) |
| **Background Agent Summarization** | `services/AgentSummary/` | Timer 30s → resumen 3-5 palabras de operaciones largas en SSE/UI | 3.6 |
| **Migration Files Individuales** | `migrations/*.ts` | Cada migración = 1 archivo named. Idempotente, no-flag needed | 6.5 (reemplaza ad-hoc) |
| **Idempotent Migration Pattern** | `migrations/` (múltiples) | Read + write same source → no "done" flag. Safe replay. | 6.5 |
| **Compaction with PTL Fallback** | `services/compact/compact.ts` | API-round grouping, orphan cleanup, 20% fallback en prompt-too-long | 2.6 |
| **ResolveOnce for Permissions** | `hooks/toolPermission/` | Autorización atómica de tools: hook > classifier > user. Race-safe | Post-plan |
| **Session History Dual-Store** | `history.ts` | In-memory pending + disk JSONL. Lazy content resolution. Session-priority | Post-plan |
| **Tasks Factory Feature-Gated** | `tasks.ts` | Array builder pattern para routing de task types. Feature gates. | 2.1 (info) |
| **QueryEngine Config-Driven** | `QueryEngine.ts` | 24-field config para orquestación. Callbacks para state. Lazy imports. | 3.3 (info) |
| **Agent Summary Timer** | `services/AgentSummary/` | New AbortController por attempt. `stop()` aborta + limpia timer. | 3.6 |

---

## FASE 0: Preparación (Día 0 — 2 horas)

### 0.1 — Crear Directorio de Utilidades Compartidas

**Problema**: 14 funciones duplicadas en todo el codebase (KB1).

**Acción**: Crear `src/utils/` con módulos independientes.

**Archivos nuevos**:

| Archivo | Contenido | Líneas |
|---------|-----------|--------|
| `src/utils/as-record.js` | Type guard `asRecord(value)` | ~10 |
| `src/utils/clamp.js` | `clamp()`, `clampInteger()`, `clampFloat()` | ~25 |
| `src/utils/text-normalize.js` | `normalizeText()`, `compactText()` | ~20 |
| `src/utils/token-estimate.js` | `estimateTokens()`, `estimateTokensForFileType()` (JSON→2 bytes/token, default→4) | ~20 |
| `src/utils/parse-boolean.js` | `parseBoolean()` para env vars | ~15 |
| `src/utils/slugify.js` | `slugify()` para nombres de archivo | ~10 |
| `src/utils/path-utils.js` | `toPosixPath()`, `resolveSafePathWithinWorkspace()` | ~30 |
| `src/utils/scan-stats.js` | `createScanStats()` factory | ~15 |
| `src/utils/close-summary.js` | `buildCloseSummaryContent()` | ~20 |
| `src/utils/sdd-metrics.js` | `buildSddMetricSummary()`, `buildTeachingMetricSummary()` | ~30 |
| `src/utils/chunk-signals.js` | `defaultSignals`, `classifyKind()` | ~50 |

> **Nota**: `resolveSafePathWithinWorkspace` va SOLO en `src/utils/path-utils.js`. El plan v1.0 la listaba también en `src/utils/safe-path.js` — eso estaba duplicado. `safe-path.js` no se crea.

**Fuentes de donde extraer cada función**:

| Función | Archivos actuales |
|---------|-------------------|
| `asRecord` | `src/api/server.js:115`, `src/api/handlers.js:331`, `src/context/context-mode.js:920`, `src/context/noise-canceler.js:270`, `src/orchestration/conversation-manager.js:190` |
| `clampInteger` / `clampFloat` | `src/api/server.js:289`, `src/context/context-mode.js:414-431`, `src/context/noise-canceler.js:126`, `src/orchestration/nexus-agent-orchestrator.js:126-146`, `src/api/handlers.js:101-121` |
| `normalizeText` / `compactText` | `src/context/context-mode.js:587`, `src/context/noise-canceler.js:181`, `src/memory/memory-hygiene.js:46`, `src/orchestration/conversation-manager.js:183` |
| `estimateTokenCount` / `estimateTokens` | `src/api/server.js:102`, `src/context/context-mode.js:549`, `src/context/noise-canceler.js:326`, `src/llm/context-injector.js:28` |
| `parseBoolean` / `parseBooleanEnv` | `src/api/server.js:281`, `src/context/context-mode.js:438`, `src/orchestration/conversation-manager.js:116`, `src/api/security-runtime.js:31` |
| `slugify` | `src/memory/memory-hygiene.js:54`, `src/io/markdown-adapter.js:18`, `src/io/pdf-adapter.js:18` |
| `toPosixPath` | `src/io/workspace-chunks.js:125`, `src/io/markdown-adapter.js:29`, `src/io/pdf-adapter.js:29`, `src/sync/sync-runtime.js:77` |
| `createScanStats` | `src/io/workspace-chunks.js:228`, `src/io/markdown-adapter.js:133`, `src/io/pdf-adapter.js:90` |
| `buildCloseSummaryContent` | `src/memory/engram-client.js:109`, `src/memory/memory-utils.js:14` |
| `buildSddMetricSummary` / `buildTeachingMetricSummary` | `src/api/server.js:182-237`, `src/api/handlers.js:340-395` |
| `resolveSafePathWithinWorkspace` | `src/api/server.js:921`, `src/api/handlers.js:133` |
| `defaultSignals` / `classifyKind` | `src/io/source-adapter.js:74-106`, `src/io/workspace-chunks.js:167-225` |

**Archivos a modificar después de crear utils/**:

| Archivo | Qué reemplazar |
|---------|---------------|
| `src/api/server.js` | Eliminar `asRecord`, `clampInteger`, `estimateTokenCount`, `buildSddMetricSummary`, `buildTeachingMetricSummary` — importar de `src/utils/` |
| `src/api/handlers.js` | Eliminar `asRecord`, `clampInteger`, `resolveSafePathWithinWorkspace`, `buildSddMetricSummary` — importar de `src/utils/` |
| `src/context/context-mode.js` | Eliminar `asRecord`, `clampInteger`, `parseBoolean`, `normalizeText` — importar de `src/utils/` |
| `src/context/noise-canceler.js` | Eliminar `asRecord`, `clampInteger`, `normalizeText`, `estimateTokens` — importar de `src/utils/` |
| `src/orchestration/conversation-manager.js` | Eliminar `asRecord`, `parseIntEnv`, `parseBooleanEnv`, `normalizeText` — importar de `src/utils/` |
| `src/orchestration/nexus-agent-orchestrator.js` | Eliminar `clampNumber`, `clampFloat` — importar de `src/utils/` |
| `src/memory/memory-hygiene.js` | Eliminar `compactText`, `slugify`, `tokenize` — importar de `src/utils/` |
| `src/io/workspace-chunks.js` | Eliminar `toPosixPath`, `createScanStats`, `classifyChunkKind`, `defaultSignals` — importar de `src/utils/` |
| `src/io/markdown-adapter.js` | Eliminar `slugify`, `toPosixPath`, `createScanStats` — importar de `src/utils/` |
| `src/io/pdf-adapter.js` | Eliminar `slugify`, `toPosixPath`, `createScanStats` — importar de `src/utils/` |
| `src/io/source-adapter.js` | Mover `classifyKind`, `defaultSignals` a `src/utils/chunk-signals.js` — re-exportar |
| `src/api/security-runtime.js` | Eliminar `parseBoolean` — importar de `src/utils/` |
| `src/llm/provider.js` | Eliminar `asFiniteNumber`, `asPositiveInteger` — mover a `src/utils/` |
| `src/memory/engram-client.js` | Eliminar `buildCloseSummaryContent` — importar de `src/utils/` |

### 0.2 — Crear Directorio Core

**Acción**: Crear `src/core/` para módulos fundamentales del sistema.

**Archivos nuevos en esta fase**:
- `src/core/task.js` — Task State Machine (ver Fase 2.1)
- `src/core/safe-env.js` — Safe environment para subprocesses (ver Fase 1.1)
- `src/core/logger.js` — Structured logging (ver Fase 1.4)

**DoD**:
- [ ] `src/utils/` contiene 11 módulos independientes
- [ ] `src/core/` existe y está vacío (los módulos se crean en sus fases)
- [ ] 0 funciones duplicadas en el codebase (verificar con grep)
- [ ] `npm test` sigue verde después de los imports

---

## FASE 1: Seguridad Crítica (Día 1-2 — 8 horas)

### 1.1 — Allowlist de Entorno en Subprocess (C2)

**Problema**: `child_process` hereda todo `process.env` — API keys, tokens, secrets expuestos a procesos hijos.

**Archivos a modificar**:
- `src/api/handlers.js` — líneas 296-313 (CLI execution), 160-170 (agent spawning)
- `src/cli/app.js` — cualquier `execFile`/`spawn` sin env limitado
- `src/guard/code-gate.js` — ya tiene `buildCodeGateEnv()` (línea 76), verificar que se use en todos los spawns

**Archivo nuevo**: `src/core/safe-env.js`

```javascript
const ALLOWED_ENV_KEYS = [
  "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "TMP", "TEMP", "TMPDIR", "APPDATA", "LOCALAPPDATA",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "TERM", "CI", "FORCE_COLOR", "NO_COLOR",
  "LANG", "LC_ALL",
  "NODE_ENV", "NODE_OPTIONS"
];

export function buildSafeEnv(overrides = {}) {
  const env = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    // value === undefined significa "no incluir esta key"
    // value === null o "" significa eliminarla explícitamente
    if (value !== undefined) env[key] = value;
  }
  return env;
}
```

> **Bug corregido vs v1.0**: el original usaba `if (value)` que eliminaba keys con valor `"0"`, `false`, o `""`. Ahora usa `!== undefined`.

**DoD**:
- [ ] Ningún `execFile` o `spawn` en `handlers.js` pasa `process.env` completo
- [ ] Test: subprocess no tiene acceso a `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`
- [ ] `code-gate.js` usa `buildSafeEnv()` o `buildCodeGateEnv()` consistentemente (no ambas — unificar)

### 1.2 — Guard sobre Chunks Sanitizados (C3)

**Problema**: Chunks de código se inyectan en prompts sin sanitizar contra prompt injection.

**Archivos a modificar**:
- `src/api/guard-middleware.js` — línea 14 (guard saltea endpoints de escritura)
- `src/api/server.js` — líneas 1060-1160 (chunk injection en prompts)
- `src/llm/context-injector.js` — inyección de chunks en prompts

**Archivo nuevo**: `src/guard/chunk-sanitizer.js`

```javascript
const INJECTION_PATTERNS = [
  /(?:^|\n)\s*system\s*:/gi,
  /(?:^|\n)\s*ignore\s+(?:previous|all|above)/gi,
  /(?:^|\n)\s*you\s+are\s+now/gi,
  /(?:^|\n)\s*disregard/gi,
  /<\|.*?\|>/g,
];

export function sanitizeChunkContent(content) {
  let sanitized = content;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[SANITIZED]');
  }
  return sanitized;
}

export function sanitizeChunks(chunks) {
  return chunks.map(chunk => ({
    ...chunk,
    content: chunk.content ? sanitizeChunkContent(chunk.content) : chunk.content
  }));
}
```

**DoD**:
- [ ] Guard se ejecuta DESPUÉS de normalizar y sanitizar chunks, no antes
- [ ] Test: chunk con `system: ignore previous instructions` → `[SANITIZED]`
- [ ] Test: chunk normal → contenido intacto
- [ ] La sanitización no altera el score de relevancia del chunk

### 1.3 — Path Resolution Seguro (H1)

**Problema**: Path traversal usa regex frágil en vez de resolución absoluta.

**Archivos a modificar**:
- `src/api/start.js` — líneas 65-90 (static file serving)
- `src/api/handlers.js` — línea 133
- `src/api/server.js` — línea 921

**Implementación** (mover a `src/utils/path-utils.js`):

```javascript
import path from "node:path";

export function resolveSafePathWithinWorkspace(userPath, fieldName = "path") {
  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workspaceRoot, userPath);

  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new Error(`${fieldName} must stay within the workspace root`);
  }

  return resolved;
}
```

**DoD**:
- [ ] Regex de path traversal eliminado de `start.js` y `handlers.js`
- [ ] Todos los path checks usan `path.resolve()` + `startsWith()`
- [ ] Test: `../../../etc/passwd` → Error 400
- [ ] Test: `./src/file.js` → resuelve correctamente

### 1.4 — Logging en Catches Silenciosos (H2)

**Problema**: 6 catch blocks tragan errores sin registro.

**Archivo nuevo**: `src/core/logger.js`

```javascript
const LEVELS = { info: 0, warn: 1, error: 2 };
const MIN_LEVEL = LEVELS[process.env.LCS_LOG_LEVEL ?? 'warn'] ?? 1;

export function log(level, message, context = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'warn') console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
```

**Catches a corregir**:

| Archivo | Línea | Qué traga | Fix |
|---------|-------|-----------|-----|
| `src/orchestration/nexus-agent-orchestrator.js` | 332 | Error de context selection | `log('warn', 'context selection failed', { error: e.message })` |
| `src/orchestration/nexus-agent-orchestrator.js` | 368 | Error de axiom injection | `log('warn', 'axiom injection failed', { error: e.message })` |
| `src/llm/openrouter-provider.js` | 90-92 | Provider failures | `log('warn', 'provider failed', { provider: p.name, error: e.message })` |
| `src/api/start.js` | 87 | Static file serving errors | `log('warn', 'static file error', { path, error: e.message })` |
| `src/memory/engram-client.js` | 273 | Binary execution errors | Preservar stack trace completo |
| `src/memory/memory-hygiene.js` | 112 | Corrupted JSONL lines | Per-line error handling con `log` |

**DoD**:
- [ ] Los 6 catches registran el error con `log()`
- [ ] Formato JSON estructurado con `timestamp`, `level`, `message`, `context`
- [ ] Configurable via `LCS_LOG_LEVEL` (info/warn/error)
- [ ] No expone datos sensibles en logs (no API keys, no tokens)

### 1.5 — Migrar JWT a Librería Auditada (H3)

**Problema**: JWT implementado manualmente en `auth-middleware.js` sin validar `iss`, `aud`, `nbf`.

**Archivo a modificar**: `src/api/auth-middleware.js` — líneas 55-189

```bash
npm install jsonwebtoken
```

```javascript
import jwt from "jsonwebtoken";

jwt.verify(token, secret, {
  algorithms: ["HS256"],
  issuer: process.env.LCS_JWT_ISSUER,
  audience: process.env.LCS_JWT_AUDIENCE,
  clockTolerance: parseInt(process.env.LCS_JWT_CLOCK_SKEW ?? "30")
});
```

**DoD**:
- [ ] `jsonwebtoken` como dependencia en `package.json`
- [ ] Algoritmo forzado a HS256
- [ ] `iss`, `aud`, `nbf`, `iat` validados
- [ ] Clock skew configurable via `LCS_JWT_CLOCK_SKEW`
- [ ] Tests: JWT inválido → 401, expirado → 401, algoritmo incorrecto → 401

### 1.6 — Auth en Rutas Públicas (C1)

**Problema**: `/api/openapi.json`, `/api/demo` son públicas sin auth.

**Decisión**: Opción B — sanear `/api/openapi.json` para no exponer topología interna, y proteger `/api/demo` con feature flag.

**Archivos a modificar**:
- `src/api/start.js` — línea 115
- `src/api/server.js` — líneas 1721-1733

```javascript
// Feature flag para demo
if (!parseBoolean(process.env.LCS_DEMO_ENABLED ?? 'false')) {
  // return 404 para /api/demo
}
```

**DoD**:
- [ ] `/api/openapi.json` no expone rutas internas ni detalles de auth
- [ ] `/api/demo` requiere `LCS_DEMO_ENABLED=true` para estar activo
- [ ] Por defecto (`LCS_DEMO_ENABLED` no seteado) → 404

### 1.7 — Timeouts de Request (M4)

**Problema**: Sin timeout de requests — un request lento puede colgar el servidor.

**Archivos a modificar**:
- `src/api/server.js` — línea 1575 (server creation)
- `src/api/start.js` — línea 163

```javascript
const server = http.createServer(handler);
server.keepAliveTimeout = parseInt(process.env.LCS_KEEP_ALIVE_TIMEOUT ?? "30000");
server.headersTimeout = parseInt(process.env.LCS_HEADERS_TIMEOUT ?? "30000");
server.requestTimeout = parseInt(process.env.LCS_REQUEST_TIMEOUT ?? "60000");
```

**DoD**:
- [ ] `keepAliveTimeout` = 30s (configurable)
- [ ] `headersTimeout` = 30s (configurable)
- [ ] `requestTimeout` = 60s (configurable)
- [ ] Test: request que tarda más del timeout → 408

---

## FASE 1.5: Exploración de Patrones Faltantes (Día 2 — 2 horas)

> **Por qué esta fase existe**: El plan v1.0 se construyó mirando solo 7 archivos raíz de `src/` en Claude Code. Hay directorios con patrones de alto valor que podrían cambiar el diseño de las Fases 2 y 3 si se ignoran.

**Acción**: Leer y documentar los patrones en los siguientes directorios **antes** de implementar las fases siguientes:

| Directorio | Qué buscar | Impacto en el plan |
|------------|-----------|-------------------|
| `src/commands/` | Cómo cada comando es un módulo independiente | Informa el diseño del Command Registry (Fase 2.0) |
| `src/agent/` | Loop de agente real, tool execution, abort handling | Puede cambiar el diseño de `agent-query-loop.js` (Fase 3.3) |
| `src/llm/` | Streaming, fallback entre providers, retry | Puede cambiar la Fase 3.2 (error reporting de providers) |
| `src/permissions/` | Sistema de permisos para tools | Puede complementar la Fase 1.1 (safe env) |
| `src/config/` | Feature flags, carga de config | Puede reemplazar el manejo manual de `LCS_*` vars |
| `src/versioning/` | Sistema de migraciones de datos | Puede reemplazar el `.migration-state.json` ad-hoc de la Fase 6 |

**Output esperado**: Documento `docs/pattern-findings.md` con:
- Decisión de adoptar o descartar cada patrón
- Si se adopta: en qué fase y cómo
- Si se descarta: por qué

**DoD**:
- [ ] `docs/pattern-findings.md` creado con hallazgos de cada directorio
- [ ] Decisión documentada para Command Registry (Fase 2.0 necesita esto)
- [ ] Decisión documentada para agent loop vs `agent-query-loop.js`
- [ ] Decisión documentada para versioning vs migración ad-hoc

---

## FASE 2: Estructura y Performance (Día 3-5 — 14 horas)

### 2.0 — Command Registry (KB2)

> **Por qué antes de 2.1**: Las Fases 2.1, 3.1, 3.4, y 4.1 agregan endpoints nuevos. Sin registry, todos van a `handlers.js`. Con registry, cada endpoint es un módulo independiente. El orden importa.

**Problema**: `handlers.js` crece con cada endpoint nuevo. Cada feature = modificar el archivo core.

**Patrón**: `commands.ts` de Claude Code — carga dinámica, memoizado por cwd, deduplicado, availability-gated.

**Archivos nuevos**:

`src/core/command-registry.js` (~80 líneas):

```javascript
import { randomUUID } from "node:crypto";

/** @type {Map<string, CommandDef>} */
const registry = new Map();

/**
 * @typedef {{
 *   name: string,
 *   method: string,
 *   path: string,
 *   handler: (req: Request) => Promise<Response>,
 *   isAvailable?: () => boolean | Promise<boolean>
 * }} CommandDef
 */

export function registerCommand(def) {
  const key = `${def.method}:${def.path}`;
  if (registry.has(key)) {
    throw new Error(`Command already registered: ${key}`);
  }
  registry.set(key, def);
}

export function getCommand(method, path) {
  return registry.get(`${method}:${path}`);
}

export async function isCommandAvailable(method, path) {
  const cmd = registry.get(`${method}:${path}`);
  if (!cmd) return false;
  if (typeof cmd.isAvailable === 'function') {
    return cmd.isAvailable();
  }
  return true;
}

export function getAllCommands() {
  return [...registry.values()];
}
```

`src/api/commands/` — directorio para comandos modulares:
```
src/api/commands/
├── tasks.js       ← endpoints de Task FSM (Fase 2.1)
├── health.js      ← health check endpoint (Fase 3.1)
├── agent.js       ← SSE endpoint (Fase 3.4)
└── axioms.js      ← axioms endpoint (Fase 4.1)
```

**Archivo a modificar**: `src/api/handlers.js` — agregar bootstrap:

```javascript
import { registerCommand } from "../core/command-registry.js";
import "./commands/tasks.js";     // auto-registers on import
import "./commands/health.js";
import "./commands/agent.js";
import "./commands/axioms.js";

// Router usa getCommand() en vez de if-else chain
```

**DoD**:
- [ ] `registerCommand()` lanza si se registra la misma ruta dos veces
- [ ] Agregar nuevo endpoint = crear 1 archivo en `src/api/commands/`, 0 cambios al core
- [ ] `handlers.js` no crece con cada feature nueva
- [ ] Test: registrar comando duplicado → error en startup, no en runtime

### 2.1 — Task State Machine

**Patrón**: `Task.ts` de Claude Code — FSM con `TaskType` + `TaskStatus`, IDs con prefijo, `isTerminal()` guard, `abortController`.

**Archivo nuevo**: `src/core/task.js` (~140 líneas)

```javascript
import { randomBytes } from "node:crypto";

export const TASK_TYPES = Object.freeze({
  AGENT: "agent", GATE: "gate", REPAIR: "repair",
  WORKFLOW: "workflow", MITOSIS: "mitosis", INGEST: "ingest"
});

export const TASK_STATUS = Object.freeze({
  PENDING: "pending", RUNNING: "running",
  COMPLETED: "completed", FAILED: "failed", CANCELLED: "cancelled"
});

const ID_PREFIXES = {
  agent: "a", gate: "g", repair: "r",
  workflow: "w", mitosis: "m", ingest: "i"
};

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** @type {Map<string, Task>} */
const tasks = new Map();

// ── Cleanup periódico — se activa al crear el primer task ──────────────
let cleanupInterval = null;

function ensureCleanupScheduled() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    cleanupExpiredTasks(3_600_000); // TTL: 1 hora
  }, 600_000); // cada 10 minutos
  cleanupInterval.unref(); // no impide que el proceso termine
}

function generateTaskId(type) {
  const prefix = ID_PREFIXES[type] ?? "x";
  const bytes = randomBytes(5);
  const random = Array.from(bytes)
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join("");
  return `${prefix}${random}`;
}

export function isTerminal(status) {
  return status === TASK_STATUS.COMPLETED
    || status === TASK_STATUS.FAILED
    || status === TASK_STATUS.CANCELLED;
}

export function createTask(type, description, metadata = {}) {
  ensureCleanupScheduled();
  const id = generateTaskId(type);
  const now = new Date().toISOString();
  const task = {
    id, type,
    status: TASK_STATUS.PENDING,
    description: String(description).slice(0, 500),
    createdAt: now, updatedAt: now,
    abortController: new AbortController(),
    metadata
  };
  tasks.set(id, task);
  return task;
}

export function getTask(id) { return tasks.get(id); }
export function getTasksByStatus(status) {
  return [...tasks.values()].filter((t) => t.status === status);
}
export function getAllTasks() { return [...tasks.values()]; }

export function updateTaskStatus(id, status, error) {
  const task = tasks.get(id);
  if (!task) return false;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (status === TASK_STATUS.RUNNING && !task.startedAt) task.startedAt = task.updatedAt;
  if (isTerminal(status) && !task.endedAt) task.endedAt = task.updatedAt;
  if (error) task.error = String(error).slice(0, 2000);
  return true;
}

export function cancelTask(id) {
  const task = tasks.get(id);
  if (!task || isTerminal(task.status)) return false;
  task.abortController.abort();
  updateTaskStatus(id, TASK_STATUS.CANCELLED);
  return true;
}

export function cleanupExpiredTasks(maxAgeMs = 3_600_000) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [id, task] of tasks.entries()) {
    const endedAt = task.endedAt ? Date.parse(task.endedAt) : 0;
    if (isTerminal(task.status) && endedAt && endedAt < cutoff) {
      tasks.delete(id);
      removed += 1;
    }
  }
  return removed;
}
```

> **Bug corregido vs v1.0**: `cleanupExpiredTasks` ahora se invoca automáticamente cada 10 minutos via `setInterval(...).unref()`. El plan original no definía quién la llamaba.

**Archivo nuevo**: `src/api/commands/tasks.js`

```javascript
import { registerCommand } from "../../core/command-registry.js";
import { getAllTasks, getTask, cancelTask } from "../../core/task.js";
import { jsonResponse } from "../router.js";

registerCommand({
  method: "GET", path: "/api/tasks",
  handler: async () => jsonResponse(200, { tasks: getAllTasks().map(serializeTask) })
});

registerCommand({
  method: "GET", path: "/api/tasks/:id",
  handler: async (req) => {
    const task = getTask(req.params.id);
    if (!task) return jsonResponse(404, { error: "Task not found" });
    return jsonResponse(200, serializeTask(task));
  }
});

registerCommand({
  method: "POST", path: "/api/tasks/:id/cancel",
  handler: async (req) => {
    const ok = cancelTask(req.params.id);
    if (!ok) return jsonResponse(409, { error: "Task not found or already terminal" });
    return jsonResponse(200, { cancelled: true });
  }
});

function serializeTask(task) {
  const { abortController, ...rest } = task;
  return rest; // no serializar AbortController
}
```

**Archivos a modificar**:
- `src/orchestration/nexus-agent-orchestrator.js` — integrar `createTask('agent', ...)` + `updateTaskStatus`
- `src/orchestration/repair-loop.js` — integrar `createTask('repair', ...)`

**DoD**:
- [ ] `createTask()` genera IDs legibles: `a3x8k2`, `g7f1n4`
- [ ] Cleanup automático cada 10 minutos, no bloquea el proceso
- [ ] `cancelTask()` aborta el AbortController
- [ ] `GET /api/tasks` lista todos los tasks
- [ ] `POST /api/tasks/:id/cancel` cancela un task corriendo
- [ ] Verificación con NEXUS: `node src/cli.js shell` → crear task → ver en `/api/tasks`

### 2.2 — Context Memoization

**Patrón**: `context.ts` de Claude Code — `memoize()` por conversación, computed once, reused throughout session.

**Archivo a modificar**: `src/orchestration/conversation-manager.js`

**Cambio 1 — Policy memoization** (líneas 132-178):
```javascript
let cachedPolicy = null;
let cachedPolicyEnv = null;

const POLICY_ENV_KEYS = [
  "LCS_CONVERSATION_SESSION_TTL_MS", "LCS_CONVERSATION_MAX_TURNS",
  "LCS_CONVERSATION_SUMMARY_EVERY", "LCS_CONVERSATION_SUMMARY_KEEP_TURNS",
  "LCS_CONVERSATION_CONTEXT_MAX_CHARS", "LCS_CONVERSATION_RECALL_QUERY_MAX_CHARS",
  "LCS_CONVERSATION_CONTRADICTION_LOOKBACK_TURNS",
  "LCS_CONVERSATION_CONTRADICTION_MAX_ITEMS",
  "LCS_CONVERSATION_INCLUDE_CONTRADICTIONS"
];

function resolveConversationPolicy() {
  const envSnapshot = POLICY_ENV_KEYS
    .map(k => `${k}=${process.env[k] ?? ''}`)
    .join('|');
  if (envSnapshot === cachedPolicyEnv) return cachedPolicy;
  cachedPolicyEnv = envSnapshot;
  cachedPolicy = { /* compute policy */ };
  return cachedPolicy;
}
```

**Cambio 2 — Context cache** (líneas 798-846):
```javascript
// Cap de 200 entradas para evitar memory leak con sesiones largas
const MAX_CONTEXT_CACHE_SIZE = 200;
const contextCache = new Map();

export function buildConversationContext(sessionId, maxTurns = 10) {
  const session = sessions.get(sessionId);
  if (!session) return "";

  const cacheKey = `${sessionId}:${session.turns.length}:${maxTurns}`;
  if (contextCache.has(cacheKey)) return contextCache.get(cacheKey);

  const result = /* ... existing computation ... */;

  // Evict oldest entry si se supera el cap
  if (contextCache.size >= MAX_CONTEXT_CACHE_SIZE) {
    const firstKey = contextCache.keys().next().value;
    contextCache.delete(firstKey);
  }
  contextCache.set(cacheKey, result);
  return result;
}

// Invalidar al agregar turn
export function addTurn(sessionId, role, content, metadata) {
  // ... existing code ...
  for (const key of contextCache.keys()) {
    if (key.startsWith(`${sessionId}:`)) contextCache.delete(key);
  }
}
```

> **Bug corregido vs v1.0**: se agrega `MAX_CONTEXT_CACHE_SIZE = 200` con eviction del entry más antiguo. El original no tenía cap → memory leak con sesiones largas.

**DoD**:
- [x] `resolveConversationPolicy()` no lee `process.env` si las vars no cambiaron
- [x] `buildConversationContext()` retorna cache si los turns no cambiaron
- [x] Cache se invalida al agregar un turn
- [x] Cache no supera 200 entradas
- [x] Test: 100 llamadas sin cambios → 1 computación real

### 2.3 — Operaciones Síncronas → Asíncronas (M5)

**`src/guard/output-auditor.js` — línea 78**:
```javascript
// Antes: appendFileSync → bloquea event loop
// Después:
import { appendFile } from "node:fs/promises";
await appendFile(filePath, JSON.stringify(entry) + "\n");
```

**`src/api/start.js` — línea 78**:
```javascript
import { readFile } from "node:fs/promises";
const content = await readFile(filePath, "utf8");
// + cache in-memory para archivos estáticos frecuentes
```

**`src/observability/metrics-store.js` — línea 370**:
```javascript
// Buffer de 1 segundo + batch write + flush en SIGTERM
let metricsBuffer = [];
let metricsFlushTimer = null;

function scheduleMetricsFlush() {
  if (metricsFlushTimer) return;
  metricsFlushTimer = setTimeout(async () => {
    metricsFlushTimer = null;
    const batch = metricsBuffer.splice(0);
    if (batch.length) {
      await appendFile(metricsPath, batch.map(m => JSON.stringify(m)).join("\n") + "\n");
    }
  }, 1000);
}

// Flush antes de terminar el proceso
process.once('SIGTERM', async () => {
  clearTimeout(metricsFlushTimer);
  metricsFlushTimer = null;
  const batch = metricsBuffer.splice(0);
  if (batch.length) {
    await appendFile(metricsPath, batch.map(m => JSON.stringify(m)).join("\n") + "\n");
  }
  process.exit(0);
});

export function recordCommandMetric(metric) {
  metricsBuffer.push(metric);
  scheduleMetricsFlush();
}
```

> **Mejora vs v1.0**: se agrega `process.once('SIGTERM', ...)` para flush del buffer antes de terminar. El original podía perder métricas en shutdown limpio.

**DoD**:
- [x] `output-auditor.log()` no bloquea el event loop
- [x] `tryServeStatic()` no usa `readFileSync`
- [ ] `recordCommandMetric()` hace batch writes cada 1 segundo
- [ ] Métricas no se pierden en `SIGTERM`

### 2.4 — Tool Interface Pattern (KB3)

**Patrón**: `Tool.ts` de Claude Code — clase base con `run()`, factory `buildGateTool()`, ejecución paralela con `Promise.all`.

**Archivos nuevos**:

`src/tools/gate-tool.js` (~50 líneas):
```javascript
export class GateTool {
  constructor({ name, displayName, checkFn, parseFn, shouldRunFn, timeoutMs = 60000 }) {
    this.name = name;
    this.displayName = displayName || name;
    this.checkFn = checkFn;
    this.parseFn = parseFn;
    this.shouldRunFn = shouldRunFn;
    this.timeoutMs = timeoutMs;
  }

  async isEnabled(cwd, pkg) { return this.shouldRunFn(cwd, pkg); }

  async run(cwd, pkg) {
    const start = Date.now();
    const shouldRun = await this.isEnabled(cwd, pkg);

    if (!shouldRun) {
      return { tool: this.name, status: "skipped", errors: [], durationMs: 0,
               raw: `${this.displayName} not available` };
    }

    try {
      const output = await this.checkFn(cwd, pkg);
      const errors = this.parseFn(output);
      const hasErrors = errors.some((e) => e.severity === "error");
      return { tool: this.name, status: hasErrors ? "fail" : "pass",
               errors, durationMs: Date.now() - start, raw: output.trim() };
    } catch (error) {
      const raw = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      const errors = this.parseFn(raw);
      return { tool: this.name, status: errors.length ? "fail" : "degraded",
               errors, durationMs: Date.now() - start, raw: raw.trim() };
    }
  }
}

export function buildGateTool(def) { return new GateTool(def); }
```

`src/tools/gate-tools/typecheck.js`, `lint.js`, `build.js`, `test.js` — migrar de `code-gate.js`

`src/tools/gate-tools/index.js`:
```javascript
export { typecheckTool } from "./typecheck.js";
export { lintTool } from "./lint.js";
export { buildTool } from "./build.js";
export { testTool } from "./test.js";
export const allGateTools = [typecheckTool, lintTool, buildTool, testTool];
```

`src/guard/code-gate.js` (de 597 → ~80 líneas):
```javascript
import { allGateTools } from "../tools/gate-tools/index.js";

export async function runCodeGate(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const tools = opts.tools ?? ["typecheck", "lint", "build"];
  const pkg = await readPackageJson(cwd);

  const activeTools = allGateTools.filter(t => !tools || tools.includes(t.name));

  // Ejecución paralela
  const results = await Promise.all(activeTools.map(t => t.run(cwd, pkg)));

  const errorCount = results.flatMap(r => r.errors).filter(e => e.severity === "error").length;
  const warningCount = results.flatMap(r => r.errors).filter(e => e.severity === "warning").length;
  const hasFail = results.some(r => r.status === "fail");
  const allSkipped = results.every(r => r.status === "skipped");
  const hasDegraded = results.some(r => r.status === "degraded");
  const status = hasFail ? "fail" : allSkipped ? "skipped" : hasDegraded ? "degraded" : "pass";

  return { status, tools: results, errorCount, warningCount,
           durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
           passed: status === "pass" || status === "skipped" };
}

export { getGateErrors, formatGateErrors } from "./code-gate-errors.js";
```

`src/guard/code-gate-errors.js` (~30 líneas) — extraer funciones de error.

**DoD**:
- [ ] `runCodeGate()` ejecuta herramientas en paralelo
- [ ] Agregar nueva herramienta = crear 1 archivo + 1 línea en `index.js`
- [ ] `code-gate.js` reducido de 597 a ~80 líneas
- [ ] Tests existentes de code-gate siguen verdes

### 2.5 — Escaneo Paralelo del Workspace (M6)

**Patrón**: `memoryScan.ts` — single-pass header extraction con `Promise.allSettled`, cap duro de 200 archivos, sort por freshness antes del cap.

**Archivo a modificar**: `src/io/workspace-chunks.js` — líneas 544-624

```javascript
// Cap duro: 200 archivos. Ordenar por mtime desc antes del cap
// para que los archivos más recientes siempre entren.
const MAX_SCAN_FILES = 200;

async function readFilesInParallel(files, concurrency = 10) {
  // Ordenar por mtime antes de cap (solo los más recientes)
  const sorted = files.slice().sort((a, b) => b.mtime - a.mtime);
  const capped = sorted.slice(0, MAX_SCAN_FILES);

  const results = [];
  for (let i = 0; i < capped.length; i += concurrency) {
    const batch = capped.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (file) => {
        const content = await readFile(file.path, "utf8");
        return { file: file.path, content, mtime: file.mtime };
      })
    );
    results.push(...batchResults);
  }
  return results;
}

// Para Engram/manifest: single-pass header (solo primeras 30 líneas)
const FRONTMATTER_MAX_LINES = 30;

async function readFileHeader(filePath) {
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").slice(0, FRONTMATTER_MAX_LINES);
  return lines.join("\n");
}
```

**DoD**:
- [ ] Cap duro de 200 archivos, ordenados por mtime desc
- [ ] 1 archivo corrupto no cancela el escaneo completo
- [ ] Single-pass header para manifests (solo 30 líneas)
- [ ] Benchmark: tiempo de escaneo reducido vs secuencial (medir con `console.time`)

### 2.6 — Auto-Compact y Circuit Breaker para Contexto

**Patrón**: `autoCompact.ts` + `compact.ts` — tiered thresholds, circuit breaker on failures, API-round grouping.

**Problema**: `conversation-manager.js` no tiene límites de contexto proactivos. Las conversaciones crecen hasta que el LLM falla, sin warning previo.

**Archivo nuevo**: `src/orchestration/context-budget.js` (~100 líneas)

```javascript
import { log } from "../core/logger.js";

// Thresholds (en tokens). Configurables via env.
const getThresholds = () => ({
  contextWindow:      parseInt(process.env.LCS_CONTEXT_WINDOW ?? "200000"),
  summaryOutputMax:   parseInt(process.env.LCS_SUMMARY_OUTPUT_MAX ?? "20000"),
  autocompactBuffer:  parseInt(process.env.LCS_AUTOCOMPACT_BUFFER ?? "13000"),
  warningBuffer:      parseInt(process.env.LCS_WARNING_BUFFER ?? "20000"),
  blockingBuffer:     parseInt(process.env.LCS_BLOCKING_BUFFER ?? "3000"),
});

// Circuit breaker: máx 3 fallos consecutivos de compaction antes de desistir
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

const state = {
  consecutiveFailures: 0,
  compacted: false
};

export function calculateTokenBudgetState(currentTokens) {
  const t = getThresholds();
  const effective = t.contextWindow - t.summaryOutputMax;
  const tokensLeft = t.contextWindow - currentTokens;
  const pctLeft = tokensLeft / t.contextWindow;

  return {
    pctLeft,
    aboveWarning:      currentTokens > (effective - t.warningBuffer),
    aboveAutocompact:  currentTokens > (effective - t.autocompactBuffer),
    aboveBlocking:     currentTokens > (t.contextWindow - t.blockingBuffer),
    shouldCompact:     currentTokens > (effective - t.autocompactBuffer)
                         && state.consecutiveFailures < MAX_CONSECUTIVE_COMPACT_FAILURES
                         && !parseBoolean(process.env.LCS_DISABLE_AUTO_COMPACT ?? 'false')
  };
}

export function recordCompactFailure() {
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
    log('warn', 'auto-compact circuit breaker open', {
      failures: state.consecutiveFailures
    });
  }
}

export function recordCompactSuccess() {
  state.consecutiveFailures = 0;
  state.compacted = true;
}

export function resetCompactState() {
  state.consecutiveFailures = 0;
  state.compacted = false;
}
```

**Archivo a modificar**: `src/orchestration/conversation-manager.js`

```javascript
import { calculateTokenBudgetState, recordCompactFailure, recordCompactSuccess } from "./context-budget.js";

// En addTurn() — antes de añadir el nuevo turn:
const budget = calculateTokenBudgetState(estimatedCurrentTokens);

if (budget.aboveBlocking) {
  throw new Error("Context window at capacity. Start a new session.");
}

if (budget.aboveWarning) {
  log('warn', 'context approaching limit', { pctLeft: budget.pctLeft });
}

if (budget.shouldCompact) {
  try {
    await compactConversation(sessionId);
    recordCompactSuccess();
  } catch (error) {
    recordCompactFailure();
    log('error', 'compaction failed', { error: error.message });
    // No throw — continuar sin compaction
  }
}
```

**DoD**:
- [ ] `calculateTokenBudgetState()` retorna los 5 booleans (pct, warning, autocompact, blocking, shouldCompact)
- [ ] Circuit breaker abre después de 3 fallos consecutivos
- [ ] `LCS_DISABLE_AUTO_COMPACT=true` desactiva la compaction
- [ ] Warning en logs cuando contexto supera el threshold
- [ ] Test: 4 fallos consecutivos → circuit breaker abierto → no más intentos de compact

---

## FASE 3: Visibilidad y Experiencia (Día 5-7 — 10 horas)

### 3.1 — Health Check Endpoint

**Archivo nuevo**: `src/api/commands/health.js` (~80 líneas)

```javascript
import { registerCommand } from "../../core/command-registry.js";
import { access } from "node:fs/promises";
import path from "node:path";

async function getHealthStatus(cwd = process.cwd()) {
  const checks = {};

  // Memory — verificar que Engram puede operar
  try {
    await access(path.join(cwd, ".lcs/memory"));
    checks.memory = { status: "ok" };
  } catch {
    checks.memory = { status: "degraded", detail: "Memory directory not found" };
  }

  // Axioms
  try {
    await access(path.join(cwd, ".lcs/axioms"));
    checks.axioms = { status: "ok" };
  } catch {
    checks.axioms = { status: "degraded", detail: "Axioms directory not found" };
  }

  // Engram binary
  try {
    const { resolveENgramConfig } = await import("../../memory/engram-client.js");
    const config = resolveENgramConfig({ cwd });
    await access(config.binaryPath);
    checks.engram = { status: "ok", binary: config.binaryPath };
  } catch {
    checks.engram = { status: "unavailable", detail: "Engram binary not found" };
  }

  // LLM providers
  const providers = [];
  if (process.env.ANTHROPIC_API_KEY) providers.push("anthropic");
  if (process.env.OPENAI_API_KEY) providers.push("openai");
  if (process.env.OPENROUTER_API_KEY) providers.push("openrouter");
  if (process.env.GROQ_API_KEY) providers.push("groq");
  checks.llmProviders = { status: providers.length ? "ok" : "unavailable", providers };

  const overall = Object.values(checks).every(c => c.status === "ok")
    ? "healthy"
    : Object.values(checks).some(c => c.status === "unavailable")
      ? "degraded"
      : "unhealthy";

  return { schemaVersion: "1.0.0", status: overall,
           timestamp: new Date().toISOString(), checks };
}

registerCommand({
  method: "GET", path: "/api/health",
  handler: async () => {
    const health = await getHealthStatus();
    const httpStatus = health.status === "unhealthy" ? 503 : 200;
    return jsonResponse(httpStatus, health);
  }
});
```

**DoD**:
- [ ] `GET /api/health` responde con estado de cada componente
- [ ] Status: "healthy", "degraded", "unhealthy"
- [ ] Incluye: memoria, axiomas, Engram, proveedores LLM
- [ ] Docker healthcheck: `curl -f http://localhost:3100/api/health`
- [ ] Verificación manual: `node src/cli.js doctor --format json` debe coincidir con `/api/health`

### 3.2 — Error Reporting en Proveedores LLM

**Archivo a modificar**: `src/llm/openrouter-provider.js`

```javascript
const failures = [];

for (const p of providers) {
  try {
    // ... fetch logic ...
  } catch (error) {
    failures.push({
      provider: p.name,
      error: error.message ?? String(error),
      status: error.status ?? "unknown"
    });
    log('warn', 'llm provider failed', { provider: p.name, error: error.message });
    continue;
  }
}

// Si todos fallan:
return { ok: false, response: "All LLM providers failed.",
         model: "none", tokens: 0, provider: "none", failures };
```

**DoD**:
- [ ] Cada fallo de proveedor registrado con nombre, error, y status
- [ ] Respuesta incluye array `failures` con detalles diagnósticos
- [ ] Test: todos los proveedores fallan → response incluye `failures` con detalle de cada uno

### 3.3 — Query Loop con Recovery

**Patrón**: `query.ts` de Claude Code — async generator con recovery paths: abort handling, repair loop, task tracking.

> **Nota**: Si la Fase 1.5 reveló un loop de agente en `src/agent/` con patrones superiores, ajustar esta implementación antes de crearla.

**Archivo nuevo**: `src/orchestration/agent-query-loop.js` (~200 líneas)

```javascript
import { spawnNexusAgent } from "./nexus-agent-orchestrator.js";
import { runRepairLoop } from "./repair-loop.js";
import { createTask, updateTaskStatus, isTerminal, TASK_STATUS } from "../core/task.js";

export async function* runAgentWithRecovery(opts) {
  const { maxRepairIterations = 3, signal } = opts;
  const task = createTask("agent", opts.task);

  if (signal) {
    signal.addEventListener("abort", () => {
      if (!isTerminal(task.status)) updateTaskStatus(task.id, TASK_STATUS.CANCELLED);
    });
  }

  try {
    updateTaskStatus(task.id, TASK_STATUS.RUNNING);

    yield { phase: "select", status: "started" };
    // ... context selection ...
    yield { phase: "select", status: "done" };

    yield { phase: "axioms", status: "started" };
    // ... axiom injection ...
    yield { phase: "axioms", status: "done" };

    let agentOutput = null;

    for (let i = 0; i <= maxRepairIterations; i++) {
      if (signal?.aborted) {
        yield { phase: "agent", status: "cancelled" };
        updateTaskStatus(task.id, TASK_STATUS.CANCELLED);
        return { success: false, output: "", error: "cancelled" };
      }

      yield { phase: "agent", attempt: i + 1, status: "started" };

      const result = await spawnNexusAgent({
        ...opts, signal: task.abortController.signal
      });

      if (result.success) {
        agentOutput = result.output;
        yield { phase: "agent", attempt: i + 1, status: "success" };
        break; // ← salir del loop inmediatamente al tener éxito
      }

      yield { phase: "agent", attempt: i + 1, status: "failed", error: result.error };

      if (i < maxRepairIterations && result.output) {
        yield { phase: "repair", attempt: i + 1, status: "started" };
        const repairResult = await runRepairLoop({
          code: result.output, cwd: opts.workspace, maxIterations: 1
        });

        if (repairResult.success) {
          agentOutput = repairResult.finalCode;
          yield { phase: "repair", attempt: i + 1, status: "success" };
          break; // ← repair exitoso → salir del loop, no reintentar el agente
        }

        yield { phase: "repair", attempt: i + 1, status: "failed" };
        // continuar al siguiente intento del agente
      }
    }

    if (agentOutput === null) {
      updateTaskStatus(task.id, TASK_STATUS.FAILED, "Max iterations reached");
      return { success: false, output: "", error: "Max iterations reached" };
    }

    updateTaskStatus(task.id, TASK_STATUS.COMPLETED);
    return { success: true, output: agentOutput };

  } catch (error) {
    updateTaskStatus(task.id, TASK_STATUS.FAILED, String(error));
    throw error;
  }
}
```

> **Bug corregido vs v1.0**: el original hacía `continue` después de `repair.success`, lo que volvía a ejecutar `spawnNexusAgent` en la siguiente iteración sobreescribiendo `agentOutput`. Ahora usa `break` para salir del loop inmediatamente.

**DoD**:
- [ ] Generator yields: select → axioms → agent → (repair?) → done
- [ ] Abort signal cancela limpiamente sin throw
- [ ] Repair exitoso sale del loop, no reintenta el agente
- [ ] Task status actualizado en cada transición de fase

### 3.4 — SSE para Operaciones Largas

**Archivo nuevo**: `src/api/commands/agent.js`

```javascript
import { registerCommand } from "../../core/command-registry.js";
import { runAgentWithRecovery } from "../../orchestration/agent-query-loop.js";

registerCommand({
  method: "POST", path: "/api/agent/stream",
  handler: async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Abort cuando el cliente desconecta
    const ac = new AbortController();
    req.socket.once('close', () => ac.abort());

    try {
      const generator = runAgentWithRecovery({ ...req.body, signal: ac.signal });
      for await (const event of generator) {
        sendEvent(event);
      }
      sendEvent({ phase: "done", status: "complete" });
    } catch (error) {
      sendEvent({ phase: "error", error: error.message });
    } finally {
      res.end();
    }
  }
});
```

**DoD**:
- [ ] Cliente recibe eventos SSE: select → axioms → agent → done
- [ ] Desconexión del cliente aborta el agente
- [ ] Test: `curl -N http://localhost:3100/api/agent/stream -d '{"task":"..."}'`

### 3.5 — Memory Staleness Layer para Engram

**Patrón**: `memoryAge.ts` + `memdir.ts` + `memoryScan.ts` — entrypoint indexing, dual-constraint truncation, freshness caveats.

**Problema**: Los Engrams en NEXUS no tienen noción de antigüedad. Un hecho aprendido hace 3 semanas se presenta con la misma confianza que uno de hoy.

**Archivo nuevo**: `src/memory/memory-staleness.js` (~80 líneas)

```javascript
const STALE_THRESHOLD_DAYS = 1; // memorias > 1 día reciben caveat

/**
 * Calcula la antigüedad de una memoria en días completos.
 * Clampea a 0 si mtime es en el futuro (clock skew).
 */
export function memoryAgeDays(mtimeMs) {
  const ageMs = Date.now() - mtimeMs;
  return Math.max(0, Math.floor(ageMs / 86_400_000));
}

/**
 * Retorna texto de advertencia para memorias antiguas.
 * Vacío si la memoria es fresca.
 */
export function memoryFreshnessText(mtimeMs) {
  const days = memoryAgeDays(mtimeMs);
  if (days <= STALE_THRESHOLD_DAYS) return "";
  return (
    `Note: This memory is ${days} day${days === 1 ? "" : "s"} old. ` +
    `It is a point-in-time observation. Verify against current state ` +
    `before acting on it. Citations in old memories can sound more ` +
    `authoritative than intended.`
  );
}

/**
 * Dual-constraint truncation: 200 líneas Y 25KB.
 * Line-based first (preserva límites semánticos), luego byte-based.
 */
export function truncateMemoryContent(content, maxLines = 200, maxBytes = 25_600) {
  let result = content;
  let wasLineTruncated = false;
  let wasByteTruncated = false;

  const lines = result.split("\n");
  if (lines.length > maxLines) {
    result = lines.slice(0, maxLines).join("\n");
    wasLineTruncated = true;
  }

  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    // Truncar en límite de línea, no en medio de UTF-8
    let byteCount = 0;
    const truncLines = [];
    for (const line of result.split("\n")) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf8");
      if (byteCount + lineBytes > maxBytes) break;
      truncLines.push(line);
      byteCount += lineBytes;
    }
    result = truncLines.join("\n");
    wasByteTruncated = true;
  }

  return { content: result, wasLineTruncated, wasByteTruncated };
}
```

**Archivo a modificar**: `src/memory/engram-client.js`

```javascript
import { memoryFreshnessText, truncateMemoryContent } from "./memory-staleness.js";

// En recall/retrieve: agregar caveat a cada resultado
function enrichEngramResult(engram) {
  const freshness = memoryFreshnessText(engram.createdAt ?? engram.updatedAt);
  const { content, wasLineTruncated, wasByteTruncated } = truncateMemoryContent(engram.content);

  return {
    ...engram,
    content,
    freshnessNote: freshness || null,
    truncated: wasLineTruncated || wasByteTruncated
  };
}
```

**Archivo a modificar**: `src/memory/local-memory-store.js`

```javascript
// Al escribir una nueva memoria: agregar timestamp
const entry = {
  ...memoryData,
  createdAt: Date.now(),
  updatedAt: Date.now()
};

// Al actualizar: preservar createdAt, actualizar updatedAt
entry.updatedAt = Date.now();
```

**DoD**:
- [ ] `memoryAgeDays(mtime)` retorna días enteros, clampeado a 0 para fechas futuras
- [ ] `memoryFreshnessText()` retorna caveat para memorias > 1 día
- [ ] `truncateMemoryContent()` respeta AMBOS límites: 200 líneas Y 25KB
- [ ] Engrams tienen `createdAt` y `updatedAt` en milisegundos
- [ ] En recall: resultados incluyen `freshnessNote` (null si fresco)
- [ ] Test: memoria de 2 días → caveat. Memoria de hoy → null.
- [ ] Test: contenido de 201 líneas → truncado a 200. Contenido de 30KB → truncado a 25KB.
- [ ] Verificar con Engram: `node src/cli.js recall --project learning-context-system --format json` muestra `freshnessNote`

### 3.6 — Background Agent Summarization

**Patrón**: `AgentSummary/agentSummary.ts` — timer 30s, forked summarizer, New AbortController per attempt, `stop()` clean.

**Problema**: Las operaciones largas de NEXUS (scan, teach, agent run) no dan feedback en tiempo real. El usuario no sabe si está progresando o colgado.

**Archivo nuevo**: `src/orchestration/agent-summarizer.js` (~120 líneas)

```javascript
import { spawnNexusAgent } from "./nexus-agent-orchestrator.js";
import { log } from "../core/logger.js";

const SUMMARY_INTERVAL_MS = parseInt(process.env.LCS_SUMMARY_INTERVAL ?? "30000");

/**
 * Inicia summarización de background para una operación larga.
 * Retorna { stop() } para cancelar.
 *
 * @param {string} operationId - ID de la operación (taskId)
 * @param {() => string[]} getTranscript - Función que retorna el transcripto actual
 * @param {(summary: string) => void} onSummary - Callback con el resumen (3-5 palabras)
 */
export function startBackgroundSummary(operationId, getTranscript, onSummary) {
  if (parseBoolean(process.env.LCS_DISABLE_AGENT_SUMMARY ?? 'false')) {
    return { stop: () => {} };
  }

  let timeoutId = null;
  let currentAbort = null;
  let previousSummary = "";

  async function runSummary() {
    const transcript = getTranscript();
    if (!transcript || transcript.length === 0) return;

    currentAbort = new AbortController();

    try {
      const result = await spawnNexusAgent({
        task: buildSummaryPrompt(transcript, previousSummary),
        signal: currentAbort.signal,
        maxTokens: 50,
        skipGate: true,
        skipMemory: true
      });

      if (result.success && result.output) {
        const summary = result.output.trim().slice(0, 100);
        previousSummary = summary;
        onSummary(summary);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        log('warn', 'background summary failed', { operationId, error: error.message });
      }
    } finally {
      currentAbort = null;
      // Reschedule solo si no fue detenido
      if (timeoutId !== null) {
        timeoutId = setTimeout(runSummary, SUMMARY_INTERVAL_MS);
      }
    }
  }

  // Iniciar primer timer
  timeoutId = setTimeout(runSummary, SUMMARY_INTERVAL_MS);

  return {
    stop() {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
    }
  };
}

function buildSummaryPrompt(transcript, previousSummary) {
  return [
    "Describe in 3-5 words (present tense) what this agent is currently doing.",
    "Examples: 'Reading workspace files', 'Fixing null check', 'Analyzing test results'.",
    previousSummary ? `Previous summary: "${previousSummary}" — don't repeat.` : "",
    "Transcript (last 20 messages):",
    transcript.slice(-20).join("\n")
  ].filter(Boolean).join("\n");
}
```

**Integración en SSE endpoint** (`src/api/commands/agent.js`):

```javascript
import { startBackgroundSummary } from "../../orchestration/agent-summarizer.js";

// Dentro del handler SSE, después de crear el generator:
const summaryController = startBackgroundSummary(
  task.id,
  () => currentTranscript, // función que retorna el transcripto acumulado
  (summary) => sendEvent({ phase: "summary", text: summary })
);

try {
  for await (const event of generator) {
    sendEvent(event);
    // actualizar currentTranscript...
  }
} finally {
  summaryController.stop(); // siempre limpiar
}
```

**DoD**:
- [ ] `startBackgroundSummary()` retorna `{ stop() }` — control limpio
- [ ] Timer reinicia DESPUÉS de completar el summary, no en cada ciclo (evita overlap)
- [ ] `stop()` aborta el summary en curso Y limpia el timer
- [ ] `LCS_DISABLE_AGENT_SUMMARY=true` desactiva completamente
- [ ] Summary no excede 100 caracteres
- [ ] Test: operación de 60s → recibe al menos 1 evento `summary` en el SSE stream
- [ ] Test: `stop()` antes de que el timer dispare → no genera ningún summary

---

## FASE 4: Conocimiento Accionable (Día 7-8 — 5 horas)

### 4.1 — Implementar `/api/axioms`

**Archivo nuevo**: `src/api/axioms-loader.js` (~200 líneas)

```javascript
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const AXIOM_SOURCES = [
  { name: "obsidian-vault", path: ".lcs/obsidian-vault/NEXUS/Axioms" },
  { name: "agents-axioms", path: ".lcs/agents" }
];

export async function loadApiAxioms(cwd = process.cwd(), options = {}) {
  const { project, domain, protectedOnly, format } = options;
  const axioms = [];
  const sources = [];
  const warnings = [];

  for (const source of AXIOM_SOURCES) {
    const sourcePath = path.join(cwd, source.path);
    try {
      const files = await readdir(sourcePath);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const content = await readFile(path.join(sourcePath, file), "utf8");
        const parsed = parseAxiomMarkdown(content, file, source.name);
        axioms.push(...parsed);
        sources.push({ name: source.name, file });
      }
    } catch {
      warnings.push(`Source unavailable: ${source.path}`);
    }
  }

  // Deduplicar por topic:statement
  const seen = new Set();
  const deduped = axioms.filter(a => {
    const key = `${a.topic}:${a.statement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let filtered = deduped;
  if (protectedOnly) filtered = filtered.filter(a => a.protected);
  if (domain) filtered = filtered.filter(a => a.domain === domain);
  if (project) filtered = filtered.filter(a => !a.project || a.project === project);
  filtered.sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));

  if (format === "markdown") {
    return { schemaVersion: "1.0.0", status: "ok", count: filtered.length,
             content: formatAxiomsAsMarkdown(filtered), sources, warnings };
  }

  return { schemaVersion: "1.0.0", status: "ok", count: filtered.length,
           axioms: filtered, sources, warnings };
}

/**
 * Parsea un archivo markdown de axiomas al formato canónico.
 * Formato esperado: encabezados H2 como statements, frontmatter YAML con metadatos.
 *
 * IMPORTANTE: Esta función debe implementarse leyendo un archivo real de axiomas
 * del vault (.lcs/obsidian-vault/NEXUS/Axioms/) para inferir el formato exacto.
 * El stub abajo retorna [] y debe reemplazarse antes de que el DoD sea alcanzable.
 *
 * @param {string} content - Contenido del archivo markdown
 * @param {string} filename - Nombre del archivo (para extraer tipo/topic)
 * @param {string} sourceName - Nombre de la fuente
 * @returns {AxiomEntry[]}
 */
function parseAxiomMarkdown(content, filename, sourceName) {
  // TODO: leer .lcs/obsidian-vault/NEXUS/Axioms/*.md para inferir formato
  // y reemplazar este stub con la implementación real
  throw new Error(
    `parseAxiomMarkdown not implemented. ` +
    `Read an actual axiom file from .lcs/obsidian-vault/NEXUS/Axioms/ ` +
    `to understand the format before implementing this function.`
  );
}
```

> **Bug corregido vs v1.0**: `parseAxiomMarkdown` retornaba `[]` silenciosamente (stub invisible). Ahora lanza explícitamente para que el error sea obvio en desarrollo, y el comentario documenta exactamente qué hay que hacer antes de implementarlo.

**Archivo nuevo**: `src/api/commands/axioms.js`

```javascript
import { registerCommand } from "../../core/command-registry.js";
import { loadApiAxioms } from "../axioms-loader.js";

registerCommand({
  method: "GET", path: "/api/axioms",
  handler: async (req) => {
    const result = await loadApiAxioms(process.cwd(), {
      project: req.query.project,
      domain: req.query.domain,
      protectedOnly: req.query.protectedOnly === "true",
      format: req.query.format
    });
    return jsonResponse(200, result);
  }
});
```

**DoD**:
- [ ] **Prerrequisito**: leer un archivo real de `.lcs/obsidian-vault/NEXUS/Axioms/` e implementar `parseAxiomMarkdown` antes de marcar este ítem
- [ ] P0: `GET /api/axioms` responde JSON con `schemaVersion`, `status`, `count`, `axioms`
- [ ] P0: Si no hay fuentes, devuelve `status=ok`, `count=0`, `warnings`
- [ ] P1: Sin duplicados, orden determinista
- [ ] P2: Filtros `protectedOnly`, `domain`, `project` funcionan
- [ ] P2: `format=markdown` devuelve salida legible
- [ ] P3: Endpoint aparece en OpenAPI
- [ ] Verificación con Engram: `node src/cli.js recall --project nexus --query "axioms"` debe correlacionar con lo que retorna el endpoint

### 4.2 — Limpiar Memorias de Test

**Acción**: Eliminar entradas de test del store de Engram.

```bash
# Ver estado actual
node src/cli.js recall --project learning-context-system --format json

# Identificar entradas de test
node src/cli.js doctor-memory --project learning-context-system --format json

# Limpiar manualmente (editar .lcs/memory/learning-context-system/memories.jsonl)
# Eliminar líneas con: "CLI integration memory", "Auth boundary memory",
# "Local-only memory", "Fallback memory write"

# Verificar después
node src/cli.js doctor-memory --project learning-context-system --format json
```

**DoD**:
- [ ] Memorias de test eliminadas del JSONL
- [ ] `doctor-memory` reporta menos entradas en cuarentena
- [ ] `recall` devuelve solo conocimiento real

---

## FASE 5: Endurecimiento Adicional (Día 8-9 — 6 horas)

### 5.0 — Abstracción de Escritura Segura de Archivos

> **Por qué esta fase existe**: La v1.0 tenía escrituras atómicas en 3 lugares distintos (Fase 5.1, `ObsidianProvider`, y un posible wrapper en `fs-safe.ts`). Esta fase crea **una sola abstracción** que todos los demás usan.

**Acción**: Verificar si `src/integrations/fs-safe.ts` ya existe (lo crea la Fase 6). Si no existe, crearlo aquí.

**Archivo**: `src/integrations/fs-safe.js` (o `.ts` si la Fase 6 ya está en marcha)

```javascript
import { writeFile, rename, readFile, stat, unlink, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Escritura atómica: escribe a .tmp, luego rename al destino.
 * Seguro en NTFS (Windows) y POSIX.
 * Usa randomUUID para evitar colisiones en escrituras concurrentes.
 */
export async function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

export { readFile, stat, unlink, readdir };
```

> **Bug corregido vs v1.0**: el original usaba `${filePath}.tmp.${Date.now()}` — colisión posible si dos escrituras ocurren en el mismo ms. Ahora usa `randomUUID()`.

**DoD**:
- [ ] `atomicWrite` en un solo archivo — no reimplementada en otro lado
- [ ] Usada por `local-memory-store.js` (5.1) y `ObsidianProvider` (Fase 6)

### 5.1 — Escrituras Atómicas de Memoria (M1)

**Archivo a modificar**: `src/memory/local-memory-store.js` — líneas 431-436

```javascript
import { atomicWrite } from "../integrations/fs-safe.js";

// Reemplazar writeFile directo con:
await atomicWrite(filePath, content);
```

**DoD**:
- [ ] Escrituras de memoria usan `atomicWrite` de `fs-safe.js`
- [ ] Test: kill durante write → archivo original intacto (verificar con Engram recall post-crash)

### 5.2 — CSP/COOP/CORS Hardening (H4, H5, H6)

**Archivo a modificar**: `src/api/security-runtime.js`

- H4: Rechazar CORS wildcard `*` — requerir origen explícito via `LCS_CORS_ORIGIN`
- H5: Remover `unsafe-inline` de CSP
- H6: Restringir `connect-src` a `self` + dominios configurados

**DoD**:
- [ ] CORS sin `*` en producción
- [ ] CSP sin `unsafe-inline`
- [ ] `connect-src` restringido a `self` + `LCS_CONNECT_SRC_EXTRA` si existe

### 5.3 — Error Message Sanitization (M2)

**Archivo a modificar**: `src/api/router.js` — líneas 240-245

```javascript
// Error interno: no exponer stack
res.statusCode = 500;
res.end(JSON.stringify({
  error: "Internal server error",
  requestId: req.requestId,
  timestamp: new Date().toISOString()
}));
// Log completo server-side:
log("error", "Unhandled error", { requestId: req.requestId, stack: error.stack });
```

**DoD**:
- [ ] Respuestas 500 no exponen stack traces
- [ ] Log server-side tiene el error completo con `requestId`

### 5.4 — Request IDs con `crypto.randomUUID()` (M3)

**Archivo a modificar**: `src/api/server.js` — línea 128-130

```javascript
import { randomUUID } from "node:crypto";
function createRequestId() { return randomUUID(); }
```

**DoD**:
- [ ] Request IDs son UUIDs v4
- [ ] Header `x-request-id` en todas las respuestas

---

## FASE 6: Knowledge Backends — Integración Obsidian/Notion/Local (Día 9-10 — 10 horas)

> **Fuente**: `CheklistObsidian.md` (v4.0, pendiente de implementación). Esta fase ejecuta esa checklist con las correcciones identificadas en revisión.

**Prerrequisito**: Fase 5.0 (`fs-safe.js`) completada — `ObsidianProvider` la usa.

**Prerrequisito**: Fase 1.5 revisó `src/versioning/` — si hay un sistema de migraciones existente, usarlo en 6.5 en vez del `.migration-state.json` ad-hoc.

### 6.1 — Config, Contratos y Dependencias

```bash
npm install graceful-fs proper-lockfile async-mutex p-queue gray-matter
```

Extender `learning-context.config.json`:
```json
{
  "sync": {
    "knowledgeBackend": "local-only",
    "retryPolicy": { "maxAttempts": 3, "backoffMs": 1000, "maxBackoffMs": 30000 },
    "dlq": { "enabled": true, "path": ".lcs/dlq", "ttlDays": 7 }
  }
}
```

Actualizar `src/contracts/config-contracts.ts` con validación Zod para los nuevos campos.

**DoD**:
- [ ] Dependencias instaladas
- [ ] Config schema actualizado con validación
- [ ] Default `local-only` mantiene comportamiento actual (no breaking change)

### 6.2 — Interface y Abstracciones

**Archivo nuevo**: `src/integrations/knowledge-provider.ts`

Interface `KnowledgeProvider` con: `sync`, `delete`, `search`, `list`, `health`, `getPendingSyncs`

Jerarquía de errores: `ProviderConnectionError`, `ProviderWriteError`, `ProviderRateLimitError` (con `retryAfterMs`), `ProviderValidationError`

Decorador `withRetry(provider, policy)` con exponential backoff.

> `fs-safe.js` ya existe por Fase 5.0 — no recrear.

### 6.3 — Provider Obsidian

**Archivo nuevo**: `src/integrations/obsidian-provider.ts`

Puntos clave de implementación:
- Escritura usando `atomicWrite` de `src/integrations/fs-safe.js` (no reimplementar)
- Caché incremental: `.nexus-index.json` por proyecto con `mtime` + `size`
- Polling cada 30s con `fs.stat()` (solo si proyecto usa Obsidian)
- Lock lógico: `async-mutex` por `{slug}` intra-proceso
- Lock de filesystem: `proper-lockfile` solo para la escritura del `.md` final (no para el caché)
- Cola serializada: `p-queue` con concurrencia = 1 por proyecto
- Sanitización de slug: `^[a-z0-9_-]+$`, longitud mínima 1, máximo 100

> **Corrección vs CheklistObsidian.md**: `proper-lockfile` NO para el caché en memoria — solo para la escritura de archivos. Usar `proper-lockfile` para el caché es overkill y puede causar EBUSY en Windows.

### 6.4 — Provider Notion

**Acción**: Renombrar `src/integrations/notion-sync.js` → `src/integrations/notion-provider.ts`

Implementar interface `KnowledgeProvider` completa. Capturar HTTP 429 → `ProviderRateLimitError` con `retryAfterMs` del header `Retry-After`.

### 6.5 — Factory, DLQ y Migración

**Archivo nuevo**: `src/integrations/knowledge-resolver.ts` (Factory Pattern)

**DLQ** — puntos clave:
- Formato: JSONL en `.lcs/dlq/{project}/pending.jsonl`
- Auto-retry: en `setInterval` cada 5 minutos (no en cada `sync()` — evitar overhead)
- TTL: entradas older than `ttlDays` → `.lcs/dlq/{project}/quarantine.jsonl`
- `getPendingSyncs()` expone count al system prompt de NEXUS

> **Corrección vs CheklistObsidian.md**: el retry no va en cada `sync()`. Va en un `setInterval(retryDlq, 5 * 60 * 1000)` propio. Esto evita que un burst de syncs dispare N health checks concurrentes.

**Migración** — usar el patrón de **migration files individuales** (cada migración = 1 archivo con nombre descriptivo):

```
src/migrations/
├── migrateLocalOnlyToKnowledgeBackend.js   ← mover config legacy al nuevo campo
├── migrateMemoryJSONLAddTimestamps.js       ← agregar createdAt/updatedAt a entries existentes
└── migrateNotionSyncToNotionProvider.js    ← actualizar references a notion-sync.js
```

**Patrón de cada migration file**:
```javascript
// src/migrations/migrateMemoryJSONLAddTimestamps.js
import { readFile, atomicWrite } from "../integrations/fs-safe.js";
import { log } from "../core/logger.js";

export async function migrate(cwd) {
  const memoryPath = path.join(cwd, ".lcs/memory/.../memories.jsonl");
  try {
    const lines = (await readFile(memoryPath, "utf8")).split("\n").filter(Boolean);
    const migrated = lines.map(line => {
      const entry = JSON.parse(line);
      // Idempotente: si ya tiene timestamps, no-op
      if (entry.createdAt) return line;
      return JSON.stringify({ ...entry, createdAt: Date.now(), updatedAt: Date.now() });
    });
    await atomicWrite(memoryPath, migrated.join("\n") + "\n");
    log('info', 'migration completed', { migration: 'addTimestamps', count: migrated.length });
  } catch (error) {
    log('error', 'migration failed', { migration: 'addTimestamps', error: error.message });
    // No throw — migrations no bloquean startup
  }
}
```

**Runner** en startup (`src/api/start.js`):
```javascript
import { migrate as migrateTimestamps } from "../migrations/migrateMemoryJSONLAddTimestamps.js";
import { migrate as migrateConfig } from "../migrations/migrateLocalOnlyToKnowledgeBackend.js";

// Al iniciar: correr todas las migrations idempotentes
await Promise.allSettled([
  migrateTimestamps(process.cwd()),
  migrateConfig(process.cwd()),
]);
```

**Propiedades clave del patrón**:
- **Idempotente**: read + write mismo archivo. Segunda corrida detecta que ya está migrado → no-op
- **Sin "done" flag**: la condición de migración ES el estado del dato
- **No bloquea startup**: errores logueados, no thrown
- **Nombre descriptivo**: el filename documenta qué hace la migration

**DoD de la fase completa**:
- [ ] `local-only` funciona igual que antes (no regresión)
- [ ] `obsidian` escribe `.md` en `NEXUS/{project}/{type}/{slug}.md`
- [ ] `notion` implementa interface completa con rate limit handling
- [ ] DLQ retries automáticos cada 5 minutos
- [ ] Migración idempotente con resume

### 6.6 — Tests (críticos para esta fase)

> **Corrección vs CheklistObsidian.md**: la checklist no tenía tests para el DLQ. Se agregan aquí.

| Test | Qué verifica |
|------|-------------|
| Caché incremental | `gray-matter` NO se llama si `mtime` es igual |
| Concurrencia | 10 syncs al mismo slug → mutex garantiza orden |
| Idempotencia migración | Cortar a la mitad, relanzar → sin duplicados |
| Path traversal | `../../` en slug → bloqueado |
| DLQ retry | Simular fallo → entrada en DLQ → health check pasa → auto-retry |
| DLQ TTL | Entrada older than `ttlDays` → quarantine |
| DLQ `getPendingSyncs` | Count correcto en system prompt |
| Notion 429 | Rate limit handling con `Retry-After` |
| Fallback `local-only` | No rompe flujo existente con Engram |
| Engram + Obsidian | `remember` + `recall` funciona con ambos backends activos |

**DoD**:
- [ ] Todos los tests de la tabla pasan
- [ ] `node src/cli.js doctor --format json` sigue verde

---

## FASE 7: Cost Tracking por Provider (Día 10 — 3 horas)

### 7.0 — Cost Tracker Multi-Provider

**Patrón**: `cost-tracker.ts` — per-model aggregation, session restoration, cache token tracking, advisor recursion.

**Problema**: NEXUS no tiene visibilidad de cuánto cuesta cada operación. Con múltiples providers (Anthropic, OpenRouter, Groq), es imposible optimizar sin métricas.

**Archivo nuevo**: `src/observability/cost-tracker.js` (~200 líneas)

```javascript
import { atomicWrite, readFile } from "../integrations/fs-safe.js";
import path from "node:path";

// Nombres cortos por model ID
const MODEL_SHORT_NAMES = {
  "claude-opus-4-6":              "opus-4-6",
  "claude-sonnet-4-6":            "sonnet-4-6",
  "claude-haiku-4-5-20251001":    "haiku-4-5",
  "gpt-4o":                       "gpt-4o",
  "gpt-4o-mini":                  "gpt-4o-mini",
  "llama-3.3-70b-versatile":      "llama-3.3-70b",
  "mixtral-8x7b-32768":           "mixtral-8x7b",
};

function getShortName(modelId) {
  return MODEL_SHORT_NAMES[modelId] ?? modelId.split("/").pop() ?? modelId;
}

// State por session
const sessions = new Map();

export function initSession(sessionId) {
  sessions.set(sessionId, {
    sessionId,
    totalCostUSD: 0,
    totalDurationMs: 0,
    modelUsage: {}
  });
}

export function recordUsage(sessionId, { modelId, provider, inputTokens, outputTokens,
                                         cacheReadTokens = 0, cacheWriteTokens = 0,
                                         costUSD = 0, durationMs = 0 }) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const key = getShortName(modelId);
  const existing = session.modelUsage[key] ?? {
    modelId, provider, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, calls: 0
  };

  existing.inputTokens += inputTokens;
  existing.outputTokens += outputTokens;
  existing.cacheReadTokens += cacheReadTokens;
  existing.cacheWriteTokens += cacheWriteTokens;
  existing.costUSD += costUSD;
  existing.calls += 1;

  session.modelUsage[key] = existing;
  session.totalCostUSD += costUSD;
  session.totalDurationMs += durationMs;
}

export function getSessionCosts(sessionId) {
  return sessions.get(sessionId) ?? null;
}

export function formatSessionCosts(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return "No cost data";

  const lines = [`Session cost: $${s.totalCostUSD.toFixed(4)} (${s.totalDurationMs}ms total)`];
  for (const [name, usage] of Object.entries(s.modelUsage)) {
    lines.push(
      `  ${name} [${usage.provider}]: ` +
      `in=${usage.inputTokens} out=${usage.outputTokens} ` +
      `cache_r=${usage.cacheReadTokens} cache_w=${usage.cacheWriteTokens} ` +
      `calls=${usage.calls} cost=$${usage.costUSD.toFixed(4)}`
    );
  }
  return lines.join("\n");
}

// Persistir costos de sesión al cerrar
export async function saveSessionCosts(sessionId, cwd) {
  const s = sessions.get(sessionId);
  if (!s) return;

  const costPath = path.join(cwd, ".lcs", "costs", `${sessionId}.json`);
  await atomicWrite(costPath, JSON.stringify(s, null, 2));
}

// Restaurar costos al retomar sesión
export async function restoreSessionCosts(sessionId, cwd) {
  const costPath = path.join(cwd, ".lcs", "costs", `${sessionId}.json`);
  try {
    const data = JSON.parse(await readFile(costPath, "utf8"));
    if (data.sessionId === sessionId) {
      sessions.set(sessionId, data);
      return data;
    }
  } catch {
    // No hay costos previos, OK
  }
  return null;
}
```

**Integración**:

| Archivo | Cambio |
|---------|--------|
| `src/llm/openrouter-provider.js` | Llamar `recordUsage()` después de cada respuesta exitosa |
| `src/llm/claude-provider.js` | Ídem — incluir `cacheReadTokens` y `cacheWriteTokens` |
| `src/orchestration/nexus-agent-orchestrator.js` | `initSession()` al arrancar, `saveSessionCosts()` al finalizar |
| `src/api/handlers.js` | Endpoint `GET /api/costs/:sessionId` |

**Nuevo endpoint**: `src/api/commands/costs.js`

```javascript
registerCommand({
  method: "GET", path: "/api/costs/:sessionId",
  handler: async (req) => {
    const costs = getSessionCosts(req.params.sessionId);
    if (!costs) return jsonResponse(404, { error: "Session not found" });
    return jsonResponse(200, costs);
  }
});
```

**DoD**:
- [ ] `recordUsage()` agrega correctamente por modelo + provider
- [ ] Tokens de cache (read vs write) trackeados por separado
- [ ] `formatSessionCosts()` imprime breakdown legible por modelo
- [ ] `saveSessionCosts()` + `restoreSessionCosts()` round-trip correcto
- [ ] Endpoint `GET /api/costs/:sessionId` responde con estado actual
- [ ] Test: 3 llamadas a Anthropic + 2 a OpenRouter → aggregation correcta por provider
- [ ] Verificar: `node src/cli.js shell` → hacer query → costo visible en logs

---

## FASE 8: Cleanup y Verificación (Día 12-13 — 2 horas)

### 8.1 — Verificar Todos los Tests

```bash
npm test
npm run typecheck
npm run build
npm run build:smoke
node src/cli.js doctor --format json
node src/cli.js doctor-memory --project learning-context-system --format json
```

**DoD**:
- [ ] Tests ≥ cantidad pre-plan + nuevos tests agregados (no regresión)
- [ ] 0 errores de typecheck
- [ ] Build exitoso
- [ ] Smoke test exitoso
- [ ] Doctor: 15+ pass, 0 fail
- [ ] Doctor-memory: status ok

### 8.2 — Actualizar Documentación de Seguridad

**Archivos a modificar**:
- `docs/security-model.md` — agregar sección sobre subprocess env (C2) y prompt injection (C3)
- `SECURITY.md` — sin cambios (ya está correcto)

**Archivo nuevo**: `docs/security-master.md` — documentar todos los hallazgos con su ID, descripción, y fase que lo resolvió (para que el Mapa de Vulnerabilidades de este plan tenga fuente canónica).

### 8.3 — Actualizar Checklists

- `CheklistObsidian.md` — marcar ítems de Fase 6 completados
- `docs/checklists/pr-hardening-ingest-security.md` — ya completa, sin cambios
- `docs/pattern-findings.md` — creado en Fase 1.5, debe estar completo

---

## Mapa de Directorios — Resumen de Cambios

### Directorios Nuevos

```
src/
├── core/                         # FASE 0, 1.1, 1.4, 2.0, 2.1
│   ├── safe-env.js               # Safe subprocess env (FASE 1.1)
│   ├── logger.js                 # Structured logging (FASE 1.4)
│   ├── command-registry.js       # Command Registry (FASE 2.0)
│   └── task.js                   # Task State Machine (FASE 2.1)
├── utils/                        # FASE 0 — 11 módulos de utilidades
│   ├── as-record.js
│   ├── clamp.js
│   ├── text-normalize.js
│   ├── token-estimate.js
│   ├── parse-boolean.js
│   ├── slugify.js
│   ├── path-utils.js             # includes resolveSafePathWithinWorkspace
│   ├── scan-stats.js
│   ├── close-summary.js
│   ├── sdd-metrics.js
│   └── chunk-signals.js
├── tools/                        # FASE 2.4 — Tool interface pattern
│   ├── gate-tool.js
│   └── gate-tools/
│       ├── typecheck.js
│       ├── lint.js
│       ├── build.js
│       ├── test.js
│       └── index.js
├── api/
│   └── commands/                 # FASE 2.0 — Endpoints modulares
│       ├── tasks.js              # (FASE 2.1)
│       ├── health.js             # (FASE 3.1)
│       ├── agent.js              # (FASE 3.4)
│       ├── axioms.js             # (FASE 4.1)
│       └── costs.js              # (FASE 7.0)
├── guard/
│   ├── chunk-sanitizer.js        # FASE 1.2
│   └── code-gate-errors.js       # FASE 2.4
├── orchestration/
│   ├── context-budget.js         # FASE 2.6 — Auto-compact + circuit breaker
│   ├── agent-query-loop.js       # FASE 3.3 — Async generator con recovery
│   └── agent-summarizer.js       # FASE 3.6 — Background summarization
├── memory/
│   └── memory-staleness.js       # FASE 3.5 — Age tagging + freshness + truncation
├── migrations/                   # FASE 6.5 — Migration files individuales idempotentes
│   ├── migrateLocalOnlyToKnowledgeBackend.js
│   ├── migrateMemoryJSONLAddTimestamps.js
│   └── migrateNotionSyncToNotionProvider.js
└── observability/
    └── cost-tracker.js           # FASE 7.0 — Cost tracking multi-provider
```

### Archivos Modificados

| Archivo | Fases | Qué cambia |
|---------|-------|------------|
| `src/api/server.js` | 0, 1.3, 1.7, 5.4 | Eliminar duplicados, timeouts, request IDs |
| `src/api/handlers.js` | 0, 1.1, 1.3, 2.0 | Eliminar duplicados, bootstrap del registry |
| `src/api/start.js` | 1.3, 1.6, 1.7, 2.3 | Async reads, auth, timeouts |
| `src/api/security-runtime.js` | 1.7, 5.2 | Timeouts, CSP/CORS hardening |
| `src/api/router.js` | 5.3 | Error sanitization |
| `src/api/auth-middleware.js` | 1.5 | JWT library migration |
| `src/api/guard-middleware.js` | 1.2 | Guard repositioning |
| `src/api/axioms-loader.js` | 4.1 | Nuevo — axiom loading |
| `src/guard/code-gate.js` | 2.4 | 597 → ~80 líneas |
| `src/guard/output-auditor.js` | 2.3 | Async append |
| `src/llm/openrouter-provider.js` | 1.4, 3.2 | Error logging, failure details |
| `src/orchestration/nexus-agent-orchestrator.js` | 1.4, 2.1 | Task integration, error logging |
| `src/orchestration/repair-loop.js` | 2.1 | Task integration |
| `src/orchestration/conversation-manager.js` | 0, 2.2 | Utils imports, context memoization con cap |
| `src/orchestration/agent-query-loop.js` | 3.3 | Nuevo — async generator con recovery |
| `src/io/workspace-chunks.js` | 0, 2.5 | Utils imports, parallel scanning |
| `src/io/markdown-adapter.js` | 0 | Utils imports |
| `src/io/pdf-adapter.js` | 0 | Utils imports |
| `src/io/source-adapter.js` | 0 | Re-export desde utils/chunk-signals.js |
| `src/memory/memory-hygiene.js` | 0, 1.4 | Utils imports, per-line error handling |
| `src/memory/local-memory-store.js` | 5.1 | Usar atomicWrite de fs-safe.js |
| `src/memory/engram-client.js` | 0, 1.4 | Utils imports, error stack preservation |
| `src/context/context-mode.js` | 0 | Utils imports |
| `src/context/noise-canceler.js` | 0 | Utils imports |
| `src/integrations/fs-safe.js` | 5.0 | Nuevo — abstracción atómica única |
| `src/integrations/knowledge-provider.ts` | 6.2 | Nuevo — interface + errores |
| `src/integrations/obsidian-provider.ts` | 6.3 | Nuevo — caché + mutex + atomic |
| `src/integrations/notion-sync.js` | 6.4 | Renombrar → `notion-provider.ts` |
| `src/integrations/knowledge-resolver.ts` | 6.5 | Nuevo — factory + DLQ |
| `src/contracts/config-contracts.ts` | 6.1 | Nuevos campos sync.* |

---

## Criterios de Cierre Final

**Seguridad**:
- [ ] C1, C2, C3 resueltas (demo deshabilitado, subprocess env, prompt injection)
- [ ] H1-H6 resueltas (path traversal, catches, JWT, CORS/CSP)
- [ ] M1-M6 resueltas (atomic writes, error messages, request IDs, timeouts, async I/O, parallel scan)

**Arquitectura**:
- [ ] Código DRY — 0 funciones duplicadas
- [ ] Command Registry activo — agregar endpoint = 1 archivo nuevo
- [ ] Task FSM operativo con endpoints de API
- [ ] Context memoization activo con cap de memoria
- [ ] Code Gate ejecuta herramientas en paralelo
- [ ] Escrituras atómicas consolidadas en `fs-safe.js`

**Visibilidad**:
- [ ] `GET /api/health` operativo con estado real de Engram
- [ ] `GET /api/axioms` operativo (con `parseAxiomMarkdown` implementado)
- [ ] SSE en `/api/agent/stream` funcional
- [ ] 0 catches silenciosos

**Knowledge Backends**:
- [ ] `local-only` funciona igual que antes
- [ ] `obsidian` y `notion` backends operativos
- [ ] DLQ con auto-retry y TTL funcionando
- [ ] Migrations idempotentes en `src/migrations/` — no `.migration-state.json` ad-hoc
- [ ] `createdAt`/`updatedAt` en todos los Engrams existentes (via migration)

**Engram / Memory**:
- [ ] `freshnessNote` en resultados de recall (null si < 1 día)
- [ ] Truncation dual: 200 líneas Y 25KB
- [ ] Memorias de test limpiadas
- [ ] `node src/cli.js recall --format json` muestra `freshnessNote` en results viejos

**Observabilidad**:
- [ ] `GET /api/costs/:sessionId` operativo
- [ ] Cost breakdown por modelo y provider en logs
- [ ] Background summaries visibles en SSE stream para ops > 30s
- [ ] Circuit breaker de auto-compact visible en logs tras 3 fallos

**Calidad**:
- [ ] Tests ≥ 207 + nuevos tests de cada fase
- [ ] `npm run typecheck` verde
- [ ] `npm run build` verde
- [ ] `node src/cli.js doctor --format json` → 15+ pass, 0 fail
- [ ] `node src/cli.js doctor-memory --project learning-context-system --format json` → ok
- [ ] Memorias de test limpiadas (Engram clean)

---

## Riesgos y Mitigaciones

| Riesgo | P | I | Mitigación |
|--------|---|---|-----------|
| `code-gate.js` refactor rompe tests | M | A | Migrar una herramienta a la vez, tests existentes como red de seguridad |
| JWT migration rompe auth existente | M | A | Feature flag `LCS_JWT_LEGACY` para fallback |
| Context cache cap demasiado bajo | B | M | Monitorear hit rate; subir a 500 si hay misses frecuentes |
| Fase 1.5 revela que `src/agent/` invalida diseño de 3.3 | M | M | Hacer Fase 1.5 antes de empezar 3.3; ajustar si es necesario |
| `proper-lockfile` EBUSY en Windows con Obsidian | M | M | Limitar uso a escrituras de `.md` finales, no al caché |
| DLQ retry concurrente con sync activo | B | M | `p-queue` por proyecto serializa; DLQ retry usa la misma queue |
| `parseAxiomMarkdown` stub bloquea DoD de 4.1 | A | A | Leer archivos reales de axiomas antes de empezar la implementación |
| SSE consume recursos con clientes lentos | M | M | Timeout de 5 minutos + abort en desconexión del socket |

---

## Post-Implementación: Lo que Sigue

1. **CLI Startup Pattern** (`main.tsx`): parallel prefetching al arrancar, startup profiling checkpoints, deferred warmup. El plan actual deja `server.js` cargando todo secuencialmente.

2. **Memory Relevance Side-Query** (`findRelevantMemories.ts`): usar Sonnet como ranker de Engrams — top 5 más relevantes por turn con `alreadySurfaced` tracking. Evita re-surfacear lo mismo. Tool-awareness para no mostrar docs de APIs que el agente ya usó.

3. **Permission Context System** (`toolPermission/`): autorización atómica multi-source (hook > classifier > user) con ResolveOnce. Escala a controlar qué agentes NEXUS pueden invocar qué tools.

4. **Session History Dual-Store** (`history.ts`): in-memory pending + JSONL disk. Inline pequeños (<1KB), hashed references para pastes grandes. Session-priority en up-arrow.

5. **Docker hardening**: TLS, secrets via env, rootless container, healthcheck integrado con `/api/health`

6. **SDD policies como JSON**: Extraer matrices de `context-mode.js` a archivos JSON editables

7. **Split de god objects**: `server.js` (2200+ líneas) en módulos

8. **Fine-tuning FT-3 y FT-4**: Clasificador de riesgo y query rewriting

9. **Compaction full (`compact.ts`)**: API-round grouping para dropear contexto de forma quirúrgica. Post-compact re-injection de skills, axioms, y MCP instructions. PTL fallback (20% drop si el gap es imprevisible).

10. **Auto-Memory Extraction Agent**: agente forked con closure-scoped state machine, cursor UUID para no re-extraer, `canUseTool` whitelist para sandbox al directorio de memory.
