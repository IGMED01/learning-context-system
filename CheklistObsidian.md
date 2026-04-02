# Checklist: Knowledge Backend por Proyecto (Obsidian/Notion/Local)

**Versión:** v4.0 Final  
**Estado:** Pendiente de implementación  
**Última actualización:** 2026-04-01

---

## Objetivo

Permitir que cada proyecto elija su backend de conocimiento (Notion, Obsidian, o local-only). La decisión vive en `sync.knowledgeBackend` de la config del proyecto. El sistema resuelve automáticamente qué provider usar, con resiliencia, concurrencia segura y migración idempotente.

**Arquitectura de capas:**
```
Agente NEXUS
  → KnowledgeResolver (Factory + DLQ + getPendingSyncs)
    → NotionProvider | ObsidianProvider | Local-only
  → MemoryProvider (JSONL + Engram) ← capa de infraestructura, no cambia
```

---

## Fase 1: Config, Contratos y Dependencias

- [ ] **1.1** Instalar dependencias: `npm install graceful-fs proper-lockfile async-mutex p-queue gray-matter`
- [ ] **1.2** Extender `learning-context.config.json` con:
  - `sync.knowledgeBackend`: `"notion" | "obsidian" | "local-only"` (default: `"local-only"`)
  - `sync.retryPolicy`: `{ maxAttempts, backoffMs, maxBackoffMs }`
  - `sync.dlq`: `{ enabled: boolean, path?: string, ttlDays?: number }`
- [ ] **1.3** Actualizar `src/contracts/config-contracts.ts` con validación Zod
  - Requerir credenciales solo si el backend está activo
- [ ] **1.4** Actualizar `learning-context.config.production.json`

---

## Fase 2: Interface y Abstracciones

- [ ] **2.1** Crear `src/integrations/knowledge-provider.ts`:
  - `name: string`
  - `sync(entry: KnowledgeEntry): Promise<SyncResult>`
  - `delete(id: string): Promise<DeleteResult>`
  - `search(query: string, options?: SearchOptions): Promise<KnowledgeEntry[]>`
  - `list(project?: string, options?: ListOptions): Promise<KnowledgeEntry[]>`
  - `health(): Promise<ProviderHealth>`
  - `getPendingSyncs(project: string): Promise<PendingSync[]>`
- [ ] **2.2** Jerarquía de errores:
  - `ProviderConnectionError`
  - `ProviderWriteError`
  - `ProviderRateLimitError` (con `retryAfterMs`)
  - `ProviderValidationError`
- [ ] **2.3** Decorador `withRetry(provider, policy)` con exponential backoff
- [ ] **2.4** Crear `src/integrations/fs-safe.ts` — wrapper de `graceful-fs` (no monkey-patch global)
  - Exponer: `readFile`, `writeFile`, `rename`, `stat`, `unlink`, `readdir`
- [ ] **2.5** Agregar tipos en `src/types/core-contracts.d.ts`

---

## Fase 3: Provider Obsidian (Fast & Thread-Safe)

- [ ] **3.1** Crear `src/integrations/obsidian-provider.ts`
  - Escritura: `.md` en `NEXUS/{project}/{type}/{slug}.md`
  - Lectura: caché incremental en memoria
- [ ] **3.2** Caché incremental:
  - Archivo `.nexus-index.json` por proyecto: `{ filePath, mtime, size, parsedAt }`
  - Al iniciar: `fs.stat()` de cada `.md` → comparar con caché → solo parsear con `gray-matter` si cambió
  - Actualización del caché protegida con `proper-lockfile`
  - Polling cada 30s con `fs.stat()` (solo si proyecto usa Obsidian)
- [ ] **3.3** Seguridad:
  - Sanitización de `{slug}`: regex `^[a-z0-9_-]+$`
  - Rechazar `..`, `/`, `\`, null bytes
  - Realpath check: path resuelto debe quedar dentro de `NEXUS/`
  - Symlink detection: rechazar symlinks en ruta
- [ ] **3.4** Concurrencia:
  - `async-mutex` por `{slug}` (lock lógico intra-proceso)
  - `proper-lockfile` para escritura de archivos (lock de filesystem)
  - `p-queue` con concurrencia = 1 por proyecto (cola serializada)
  - Escritura atómica: `.tmp` → `fs.rename()`
- [ ] **3.5** Formato de nota con frontmatter YAML
- [ ] **3.6** Búsqueda: sobre caché en memoria, no sobre disco

---

## Fase 4: Provider Notion (Resiliente)

- [ ] **4.1** Renombrar `notion-sync.js` → `notion-provider.ts`
- [ ] **4.2** Implementar interface completa `KnowledgeProvider`
- [ ] **4.3** Paginación: cursores para `list` y `search`
- [ ] **4.4** Rate limits:
  - Capturar HTTP 429 → `ProviderRateLimitError` con `retryAfterMs`
  - Respetar header `Retry-After` de Notion
  - Delegar espera a `p-queue` con delay
- [ ] **4.5** Actualizar imports en archivos que referencien `notion-sync`

---

## Fase 5: Factory, DLQ y Migración

- [ ] **5.1** Crear `src/integrations/knowledge-resolver.ts` (Factory Pattern)
  - Lee config → instancia provider con dependencias inyectadas
  - Cache por proyecto
  - Health check al instanciar
- [ ] **5.2** Dead Letter Queue:
  - Formato: JSONL en `.lcs/dlq/{project}/pending.jsonl`
  - Cada entrada: `{ originalEntry, backend, attempts, lastError, createdAt, nextRetryAt }`
  - **Auto-retry**: cada sync, si health check pasa, intentar reprocesar entradas con `nextRetryAt <= now`
  - **Manual**: `knowledge dlq retry --project X`
  - **TTL**: entradas older than `ttlDays` (default 7) → `.lcs/dlq/{project}/quarantine.jsonl`
  - **Contexto del agente**: `getPendingSyncs()` expone count al system prompt
- [ ] **5.3** Actualizar CLI `sync-knowledge` para usar resolver
- [ ] **5.4** Nuevos CLI commands:
  - `knowledge sync --project X`
  - `knowledge search <query> --project X`
  - `knowledge list --project X`
  - `knowledge migrate --from <backend> --to <backend> --project X`
  - `knowledge dlq status --project X`
  - `knowledge dlq retry --project X`
- [ ] **5.5** Migración idempotente:
  - Formato intermedio: `KnowledgeEntry` canónico
  - Upsert por ID (si existe → update, si no → insert)
  - Estado en `.migration-state.json`: `{ source, dest, project, completedIds: [], total, startedAt }`
  - Resume: si crashea, al relanzar salta los `completedIds`
  - Verificación final: count match + spot-check de contenido

---

## Fase 6: Estructura de Bóveda

- [ ] **6.1** `NEXUS/_templates/memory-entry.md`
- [ ] **6.2** `NEXUS/_templates/session-close.md`
- [ ] **6.3** `NEXUS/_index.md` (Map of Content)
- [ ] **6.4** Estructura por proyecto: `NEXUS/{project}/{memories,axioms,sessions}/`

---

## Fase 7: Testing

- [ ] **7.1** Test unitario: Caché incremental (validar que gray-matter NO se llama si mtime es igual)
- [ ] **7.2** Test de concurrencia: 10 promesas de sync() al mismo `{slug}` → validar mutex
- [ ] **7.3** Test de idempotencia de migración: cortar a la mitad, relanzar, validar sin duplicados
- [ ] **7.4** Test de resolución de rutas: path traversal `../../` → bloqueado
- [ ] **7.5** Test de resiliencia: simular caída de Notion (500/429) → validar fallback a DLQ
- [ ] **7.6** Tests unitarios `ObsidianProvider`, `NotionProvider`, `KnowledgeResolver`
- [ ] **7.7** Tests de integración CLI
- [ ] **7.8** Test fallback `local-only` no rompe flujo existente

---

## Fase 8: Documentación

- [ ] **8.1** Actualizar `README.md`
- [ ] **8.2** Crear `docs/knowledge-backends.md` (guía de config + migrate + DLQ + troubleshooting)
- [ ] **8.3** Actualizar `NEXUS/Bienvenido.md`

---

## Archivos Nuevos

| Archivo | Propósito |
|---|---|
| `src/integrations/knowledge-provider.ts` | Interface + errores + decorador retry |
| `src/integrations/obsidian-provider.ts` | Obsidian provider (caché + mutex + atomic) |
| `src/integrations/knowledge-resolver.ts` | Factory + DLQ + getPendingSyncs |
| `src/integrations/notion-provider.ts` | Renombrado + adaptado |
| `src/integrations/fs-safe.ts` | Wrapper graceful-fs (no global) |
| `NEXUS/_templates/memory-entry.md` | Template notas |
| `NEXUS/_templates/session-close.md` | Template sesiones |
| `NEXUS/_index.md` | Map of Content |
| `docs/knowledge-backends.md` | Guía completa |

## Archivos Modificados

| Archivo | Cambio |
|---|---|
| `src/contracts/config-contracts.ts` | Nuevo campo `sync.knowledgeBackend` + retryPolicy + dlq |
| `src/types/core-contracts.d.ts` | Tipos KnowledgeProvider |
| `src/integrations/notion-sync.js` | Renombrar + adaptar interface |
| CLI commands | Usar resolver |
| Config files | Agregar campos ejemplo |

---

## Riesgos y Mitigaciones

| Riesgo | Mitigación |
|---|---|
| Cold Start Obsidian | Caché incremental con `fs.stat()` — solo parsea cambios |
| Race conditions | `async-mutex` + `proper-lockfile` + `p-queue` |
| Path traversal | Sanitización estricta + realpath check |
| Symlink attacks | Detección y rechazo |
| Pérdida de datos en crash | DLQ con auto-retry + TTL + quarantine |
| Notion 429 | Rate limit handling explícito + Retry-After |
| Windows EBUSY | `graceful-fs` con retry automático |
| Split-brain | `getPendingSyncs()` inyectado en contexto del agente |
| Migración corrupta | Upsert idempotente + `.migration-state.json` para resume |
| Breaking changes | Default `local-only` mantiene comportamiento actual |
| Contexto extra | Cero impacto — mismo chunking, mismos límites |
