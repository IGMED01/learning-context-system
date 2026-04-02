# Documento Maestro de Ciberseguridad: Proyecto NEXUS

**Versión:** 1.0  
**Fecha:** 2026-04-01  
**Estado:** Activo — en ejecución  
**Alcance:** NEXUS Core + Knowledge Backend v4.0

---

## 1. Informe Ejecutivo AppSec & DevSecOps

### Estado Actual

El análisis de la arquitectura base y de la implementación del Knowledge Backend (v4.0) revela que NEXUS posee una estructura modular sólida, pero presenta **3 vulnerabilidades críticas** en los límites de ejecución (interacción con el OS y subprocesos) y carece de automatización defensiva. El modelo actual es reactivo.

### Estrategia de Remediación: Shift-Left

Migrar de un enfoque de parcheo manual a un pipeline DevSecOps donde las validaciones de seguridad ocurran en el IDE del desarrollador, en la Integración Continua (CI) y en la infraestructura inmutable.

### Vectores de Riesgo Críticos Identificados

| Vector | Hallazgos | Estado |
|---|---|---|
| Fuga de entorno en subprocesos | C2, KB6 | 🔴 Pendiente |
| Bypass del Guard System | C3, M8 | 🔴 Pendiente |
| Manipulación de estado (JWT, Path, Rate) | H4, M4, H2 | 🔴 Pendiente |
| Exposición de datos residuales (DLQ) | KB5 | 🔴 Pendiente |
| Auth deshabilitado en rutas públicas | C1 | 🔴 Pendiente |

---

## 2. Hallazgos del Audit — Mapeados a Fases

### Critical (3)

| ID | Hallazgo | Ubicación | Fase | Estado |
|---|---|---|---|---|
| **C1** | Auth deshabilitado en rutas públicas | `src/api/start.js:115`, `server.js:1721-1733` | B.2 | 🔴 |
| **C2** | Secretos heredados por subprocess | `handlers.js:296`, `docker-compose.yml:10-12` | A.1 | 🔴 |
| **C3** | Prompt injection vía chunks no sanitizados | `server.js:1060-1160` | A.2 | 🔴 |

### High (6)

| ID | Hallazgo | Ubicación | Fase | Estado |
|---|---|---|---|---|
| **H1** | Guard deshabilitado en config dev | `learning-context.config.json:50` | B | 🔴 |
| **H2** | Rate limiter solo en memoria | `security-runtime.js:131` | B.3 | 🔴 |
| **H3** | Sin rate limit en `/api/remember` y `/api/recall` | `server.js:1552-1553` | B.3 | 🔴 |
| **H4** | JWT custom sin librería auditada | `auth-middleware.js:55-189` | B.1 | 🔴 |
| **H5** | `x-forwarded-for` sin validación de proxy | `security-runtime.js:61-69` | B.3 | 🔴 |
| **H6** | Subprocess con acceso total al filesystem | `handlers.js:160-170`, `296-313` | A.1 | 🔴 |

### Medium (8)

| ID | Hallazgo | Ubicación | Fase | Estado |
|---|---|---|---|---|
| **M1** | CORS acepta wildcard `*` | `security-runtime.js:44-54` | B | 🟡 |
| **M2** | CSP con `unsafe-inline` | `security-runtime.js:94-95` | B | 🟡 |
| **M3** | CSP `connect-src` permite cualquier dominio | `security-runtime.js:95` | B | 🟡 |
| **M4** | Path traversal con edge cases | `start.js:65-90` | A.3 | 🟡 |
| **M5** | Error messages filtran detalles internos | `router.js:240-245` | B | 🟡 |
| **M6** | Sin timeout de requests | `server.js:1575`, `start.js:163` | B.3 | 🟡 |
| **M7** | Escrituras de memoria no atómicas | `local-memory-store.js:431-436` | B | 🟡 |
| **M8** | Guard middleware saltea endpoints de escritura | `guard-middleware.js:14` | A.2 | 🟡 |

### Low (6)

| ID | Hallazgo | Ubicación | Fase | Estado |
|---|---|---|---|---|
| **L1** | Sin TLS en Docker | `docker-compose.yml:6` | C.1 | 🟢 |
| **L2** | API keys como env vars en Docker | `docker-compose.yml:10-12` | C.2 | 🟢 |
| **L3** | Sin healthcheck en Docker | `docker-compose.yml` | C | 🟢 |
| **L4** | `pdf-parse` sin pinning de versión | `package.json:89` | CI | 🟢 |
| **L5** | Rate limiter eviction puede resetear contadores | `security-runtime.js:155-181` | B.3 | 🟢 |
| **L6** | Request IDs predecibles | `server.js:128-130` | B | 🟢 |

### Info (5)

| ID | Hallazgo | Ubicación | Fase | Estado |
|---|---|---|---|---|
| **I1** | Patrón `system:` causa falsos positivos | `guard-engine.js:128` | B | ℹ️ |
| **I2** | Sin versionado de API | Todos los endpoints | Futuro | ℹ️ |
| **I3** | Request IDs con `Math.random()` | `server.js:128-130` | B | ℹ️ |
| **I4** | Demo page sin CSP nonce | `server.js:1721-1724` | B | ℹ️ |
| **I5** | Config ambiguity `allowSensitivePaths` | `learning-context.config.json:35` | B | ℹ️ |

---

## 3. Knowledge Backend v4.0 — Controles de Seguridad

### Riesgos Identificados y Mitigaciones

| ID | Riesgo | Mitigación | Referencia v4.0 | Estado |
|---|---|---|---|---|
| **KB1** | Path traversal en ObsidianProvider | Sanitización `^[a-z0-9_-]+$` + realpath check | Fase 3.3 | ✅ Planificado |
| **KB2** | Symlink attacks en bóveda | Detección y rechazo de symlinks | Fase 3.3 | ✅ Planificado |
| **KB3** | Race conditions en escritura concurrente | `async-mutex` + `proper-lockfile` + `p-queue` | Fase 3.4 | ✅ Planificado |
| **KB4** | Caché de Obsidian como vector de inyección | `proper-lockfile` + validación de integridad | Fase 3.2 | ✅ Planificado |
| **KB5** | DLQ como punto de exposición de datos | Permisos `0o600` + redacción + TTL + quarantine | Fase 5.2 + C.2 | 🔴 Pendiente |
| **KB6** | Notion API token exposure | Sanitizar environment en subprocess (mismo fix que C2) | Fase A.1 | 🔴 Pendiente |
| **KB7** | Migración como vector de duplicación/corrupción | Upsert idempotente + `.migration-state.json` | Fase 5.5 | ✅ Planificado |

### Controles Específicos del Knowledge Backend

| Control | Implementación | Detalle |
|---|---|---|
| **Sanitización de slug** | Regex `^[a-z0-9_-]+$` | Rechazar `..`, `/`, `\`, null bytes |
| **Realpath check** | `path.resolve()` + `startsWith(NEXUS/)` | Path resuelto debe quedar dentro de `NEXUS/` |
| **Symlink detection** | `fs.lstat()` + `isSymbolicLink()` | Rechazar symlinks en ruta de escritura |
| **Atomic writes** | `.tmp` → `fs.rename()` | Atómico en NTFS y POSIX |
| **File locking** | `proper-lockfile` | Lock de filesystem para escrituras |
| **Intra-process lock** | `async-mutex` por `{slug}` | Previene race conditions dentro del mismo proceso |
| **Write queue** | `p-queue` con concurrencia = 1 | Cola serializada por proyecto |
| **Caché incremental** | `.nexus-index.json` + `fs.stat()` | Solo parsea archivos modificados (mtime) |
| **Caché lock** | `proper-lockfile` en `.nexus-index.json` | Previene corrupción del índice |
| **DLQ security** | Permisos `0o600` + TTL 7 días + quarantine | Datos sensibles protegidos, lifecycle definido |
| **fs-safe wrapper** | `src/integrations/fs-safe.ts` | No monkey-patch global de `graceful-fs` |

---

## 4. Procedimiento Operativo de Remediación (Roadmap)

### FASE A: Hotfixes Críticos (Inmediato — Próximas 24h)

- [ ] **A.1** Allowlist estricto para variables de entorno en `child_process`
  - **Fix:** Nunca pasar `process.env` completo. Usar `{ env: { PATH, NODE_ENV, ...allowed } }`
  - **Cubre:** C2, H6, KB6
  - **Archivos:** `src/api/handlers.js`, `src/cli/app.js`

- [ ] **A.2** Reposicionar guard-engine después de normalizar chunks
  - **Fix:** Ejecutar guard sobre el prompt reconstruido, no solo sobre `query`
  - **Cubre:** C3, M8
  - **Archivos:** `src/api/guard-middleware.js`, `src/api/server.js`

- [ ] **A.3** Reemplazar Regex de Path Traversal por `path.resolve()` + `startsWith()`
  - **Fix:** Eliminar regex frágil, usar resolución absoluta + validación contra directorio base
  - **Cubre:** M4
  - **Archivos:** `src/api/start.js`, `src/api/handlers.js`

### FASE B: Endurecimiento Core (Semana 1)

- [ ] **B.1** Migrar JWT a `jsonwebtoken` con algoritmo forzado
  - **Fix:** `jwt.verify(token, secret, { algorithms: ['HS256'] })`
  - **Cubre:** H4
  - **Archivos:** `src/api/auth-middleware.js`

- [ ] **B.2** Bloquear endpoints públicos detrás de auth o sanear
  - **Fix:** `/api/openapi.json` y `/api/demo` requieren auth o no exponen topología sensible
  - **Cubre:** C1
  - **Archivos:** `src/api/server.js`, `src/api/start.js`

- [ ] **B.3** Timeouts nativos + Rate Limiter persistente
  - **Fix:** `server.keepAliveTimeout`, `server.headersTimeout` = 30s. Migrar `Map()` a LRU con persistencia en disco
  - **Cubre:** H2, H3, H5, M6, L5
  - **Archivos:** `src/api/security-runtime.js`, `src/api/server.js`

- [ ] **B.4** CSP/COOP/CORS hardening
  - **Fix:** Rechazar CORS wildcard `*`, remover `unsafe-inline` de CSP, restringir `connect-src`
  - **Cubre:** M1, M2, M3
  - **Archivos:** `src/api/security-runtime.js`

- [ ] **B.5** Error message sanitization para 500s
  - **Fix:** Mensaje genérico en respuesta, log completo solo server-side
  - **Cubre:** M5
  - **Archivos:** `src/api/router.js`

- [ ] **B.6** Escrituras atómicas de memoria
  - **Fix:** `.tmp` → `rename` + file locking
  - **Cubre:** M7
  - **Archivos:** `src/memory/local-memory-store.js`

- [ ] **B.7** Guard habilitado por defecto
  - **Fix:** `"enabled": true` en config dev, requerir opt-out explícito con warning
  - **Cubre:** H1
  - **Archivos:** `learning-context.config.json`

- [ ] **B.8** Request IDs con `crypto.randomUUID()`
  - **Fix:** Reemplazar `Date.now()` + `Math.random()`
  - **Cubre:** L6, I3
  - **Archivos:** `src/api/server.js`

### FASE C: Infraestructura y Ops (Semana 2)

- [ ] **C.1** Proxy inverso con TLS en Docker
  - **Fix:** Nginx o Caddy como reverse proxy, terminación TLS forzosa
  - **Cubre:** L1
  - **Archivos:** `docker-compose.yml`, `Dockerfile`

- [ ] **C.2** Permisos restrictivos para DLQ
  - **Fix:** `0o600` en `.lcs/dlq/`, mismo tratamiento que memorias sensibles
  - **Cubre:** KB5
  - **Archivos:** `src/integrations/knowledge-resolver.ts`

- [ ] **C.3** Docker secrets para credenciales
  - **Fix:** Eliminar env vars planas, usar montajes `/run/secrets/`
  - **Cubre:** L2
  - **Archivos:** `docker-compose.yml`

- [x] **C.4** Healthcheck en Docker
  - **Fix:** `HEALTHCHECK` en Dockerfile + `healthcheck` en compose apuntando a `/api/health`
  - **Cubre:** L3
  - **Archivos:** `docker-compose.yml`

- [x] **C.5** Contenedores inmutables (rootless)
  - **Fix:** `USER node` en Dockerfile, `read_only: true` en compose
  - **Cubre:** L1, L2
  - **Archivos:** `Dockerfile`, `docker-compose.yml`

---

## 5. Checklist de Automatización DevSecOps

### Defensa Local (Pre-Commit)

- [ ] **9.1** Husky + lint-staged — bloquear commits sin análisis estático
- [ ] **9.2** Escáner de secretos (TruffleHog / git-secrets) — abortar commit si detecta API keys/tokens
- [ ] **9.3** ESLint-plugin-security — reglas para ReDoS, `eval()`, `fs` sin validación

### Defensa en CI/CD

- [ ] **9.4** SCA (Dependabot / `npm audit`) — romper build con CVEs Altos/Críticos
- [ ] **9.5** SAST (Semgrep) — reglas Node.js + OWASP Top 10 en pipeline
- [ ] **9.6** DAST ligero en tests — payloads maliciosos (`../../../etc/passwd`) → exigir 400/403

### Defensa en Runtime & Docker

- [x] **9.7** Contenedores rootless — `USER node`, `read_only: true`
- [ ] **9.8** Docker secrets — credenciales via `/run/secrets/`
- [ ] **9.9** Logging estructurado de seguridad — JSON `SECURITY_ALERT` para guard blocks, rate limit exceeds

---

## 6. Referencias Cruzadas

| Documento | Ubicación | Propósito |
|---|---|---|
| `CheklistObsidian.md` | Local-only (no versionado en GitHub) | Plan de implementación Knowledge Backend v4.0 |
| `NEXUS-PLAN.md` + `docs/implementation-plan.md` | Local-only (no versionado en GitHub) | Planes/checklists privados de ejecución |
| `SECURITY.md` | Raíz del repo | Política de seguridad y reporte de vulnerabilidades |
| `learning-context.config.production.json` | Raíz del repo | Config de producción con guard habilitado |

---

## 7. Resumen de Estado

| Severidad | Total | Pendientes | Planificados v4.0 | Completados |
|---|---|---|---|---|
| **Critical** | 3 | 3 | 0 | 0 |
| **High** | 6 | 6 | 0 | 0 |
| **Medium** | 8 | 8 | 0 | 0 |
| **Low** | 6 | 6 | 0 | 0 |
| **Info** | 5 | 5 | 0 | 0 |
| **KB nuevos** | 7 | 2 | 5 | 0 |
| **TOTAL** | **35** | **30** | **5** | **0** |
