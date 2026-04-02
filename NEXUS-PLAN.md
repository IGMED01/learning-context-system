# NEXUS Plan (Canonical Snapshot)

> **Actualizado:** 2026-04-02  
> **Fuente canónica de ejecución:** `docs/planning/nexus-plan.md`  
> **Plan de hardening/arquitectura:** `docs/implementation-plan.md`

## Convención oficial

- **NEXUS** = plataforma completa (11 capas)
- **LCS** = motor de contexto (`NEXUS:3`)
- **NEXUS:N** = referencia directa por capa

## Estado global por fase

| Fase | Capas | Estado |
|---|---|---|
| FASE 1 — Foundations | `NEXUS:1` + `NEXUS:2` + `NEXUS:4` | ✅ **COMPLETADA + HARDENING** |
| FASE 2 — Intelligence | `NEXUS:6` + `NEXUS:10` + `NEXUS:5` | ✅ **COMPLETADA + HARDENING** |
| FASE 3 — Quality | `NEXUS:0` + `NEXUS:7` + `NEXUS:9` + `NEXUS:8` | ✅ **COMPLETADA + HARDENING** |
| FASE 4 — Polish | `NEXUS:3` + `NEXUS:10` + `NEXUS:5` | ✅ **COMPLETADA + HARDENING** |

## Checklist operativo por capa (estado actual)

- [x] **NEXUS:0 — SYNC** (change detector, version tracker, scheduler, drift monitor, APIs)
- [x] **NEXUS:1 — PROCESSING** (parser, extractor, metadata tagger, chunker, integración adapters)
- [x] **NEXUS:2 — STORAGE** (chunk-repository, BM25, hybrid retriever, vector interface)
- [x] **NEXUS:3 — LCS CORE** (scoring retrieval/vector, custom scorers, tuning vertical)
- [x] **NEXUS:4 — GUARD** (output guard, auditor, compliance, domain-scope, API)
- [x] **NEXUS:5 — ORCHESTRATION** (pipeline builder, executors reales, retries, trazabilidad)
- [x] **NEXUS:6 — LLM LAYER** (provider registry, prompt/context/response pipeline, `/api/ask`)
- [x] **NEXUS:7 — EVALS** (consistency scorer, CI gate, suites por dominio)
- [x] **NEXUS:8 — OBSERVABILITY** (persistencia, dashboard data, alerts)
- [x] **NEXUS:9 — VERSIONING** (store de versiones, rollback policy/plan, compare)
- [x] **NEXUS:10 — INTERFACE** (auth-first API, OpenAPI, SDK, demo, contratos de error)

## Validaciones de cierre ejecutadas

- [x] `npm test`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm run build:smoke`
- [x] `npm run eval:domains`
- [x] `npm run benchmark:vertical`
- [x] `npm run benchmark:tune`
- [x] `npm run benchmark:foundations`
- [x] `npm run security:pipeline:example`
- [x] `npm run northstar:check -- --min-runs 20 --min-blocked-runs 1 --min-prevented-errors 1 --min-prevented-error-rate 0.005`

## Próximo tramo (post-plan)

Con el plan principal cerrado, los próximos bloques recomendados son:

- [x] Startup pattern CLI/API con prefetch paralelo, checkpoints de arranque y warmup diferido (`src/api/start.js`, `src/core/startup-runtime.js`).
- [ ] Memory relevance side-query para evitar re-surfaceo redundante.
- [ ] Permission context system con resolución atómica de permisos.
- [ ] Session history dual-store (memoria + JSONL) para sesiones largas.
- [ ] Hardening Docker/TLS/secrets sobre `/api/health`.

---

Para detalle operativo por ítem y evidencias, revisar:

- `docs/planning/nexus-plan.md`
- `docs/implementation-plan.md`
- `docs/nexus-hardening-checklist.md`
- `docs/release-checklist.md`
