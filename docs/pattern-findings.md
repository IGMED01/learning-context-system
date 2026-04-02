# Pattern Findings — Implementación NEXUS (Fase 1.5)

**Fecha:** 2026-04-02  
**Estado:** Cerrado

Este documento registra decisiones de arquitectura tomadas durante la fase de exploración de patrones faltantes.

---

## 1) Command Registry vs handlers monolítico

**Decisión:** mantener `Command Registry` como punto único de ruteo para endpoints modulares.

**Razón:**
- reduce drift entre rutas nuevas y runtime base;
- permite alta extensibilidad (`src/api/commands/*.js`) sin crecer `handlers.js`;
- habilita guardas de duplicados en startup.

**Evidencia en código:**
- `src/core/command-registry.js`
- `src/api/commands/health.js`
- `src/api/commands/agent.js`
- `src/api/commands/costs.js`

---

## 2) Agent loop dedicado vs control embebido

**Decisión:** usar loop dedicado para operaciones largas del agente.

**Razón:**
- separa estados de query/repair/retry del endpoint HTTP;
- mejora cancelación (AbortSignal) y resiliencia de stream;
- facilita resúmenes en background y observabilidad de fases.

**Evidencia en código:**
- `src/orchestration/agent-query-loop.js`
- `src/orchestration/agent-summarizer.js`
- `src/api/commands/agent.js`

---

## 3) Migraciones idempotentes por archivo vs estado ad-hoc

**Decisión:** migraciones en archivos individuales idempotentes, sin flag global de “done”.

**Razón:**
- soporta replay seguro tras fallos;
- cada migration documenta una transformación puntual;
- evita dependencia en un archivo de estado frágil.

**Evidencia en código:**
- `src/migrations/migrateLocalOnlyToKnowledgeBackend.js`
- `src/migrations/migrateMemoryJSONLAddTimestamps.js`
- `src/migrations/migrateNotionSyncToNotionProvider.js`

---

## 4) Nota operativa de cierre

Las decisiones anteriores quedan como base para evolución incremental:
- FT-3 (risk classifier) y FT-4 (query rewriting) como gates de calidad;
- pipeline de etiquetado versionado para datasets de fine-tuning;
- validación externa con GGA sólo como auditoría, nunca acoplada al runtime.
