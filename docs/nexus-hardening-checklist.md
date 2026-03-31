# NEXUS Hardening + SDD + Noise/RAG/FT Checklist (v5)

**Fecha base:** 2026-03-30  
**Última revisión:** 2026-03-31 (piloto FT-1 + gate automático de formato)

---

## 1) ✅ Confirmado en código (cierre actual)

### Seguridad API / runtime
- [x] `/api/chat` valida `chunks` inválidos (evita 500 por `null`/tipos inesperados).
- [x] Rate limiting no confía en `X-Forwarded-For` salvo `LCS_API_TRUST_PROXY=true`.
- [x] `suitePath` traversal bloqueado en rutas JS y TS (`/api/eval`, `/api/rollback-check`, `/api/evals/domain-suite`).
- [x] Error body demasiado grande devuelve `413` (`readJsonBody` y `router.parseRequestBody`).
- [x] Runtime de `/api/agent` local-first operativo (sin dependencia externa obligatoria).

### Contexto limpio + SDD
- [x] Feature flag `LCS_CONTEXT_MODE=clean`.
- [x] Perfiles por endpoint implementados (`/api/ask`, `/api/chat`, `/api/agent`).
- [x] Selección SDD integrada en contexto (`spec -> test -> code`) con cobertura por endpoint.
- [x] Respuesta de `/api/ask`, `/api/chat` y `/api/agent` ahora expone metadata de modo/contexto + SDD.
- [x] Agente NEXUS usa selección con `forceSelection` para endpoint `agent` + `sddCoverage`.

### Bugfixes críticos detectados en critique
- [x] `structuralHits` corregido (`diagnostics.structuralSignalCount`).
- [x] `scoringProfile` inválido removido (`symbol-aware` -> perfil soportado).

### Quality gates CI (riesgo controlado)
- [x] Gate retrieval-first (`benchmark:retrieval-gate`) integrado como paso bloqueante en CI.
- [x] Gate anti-ruido de conversación (`benchmark:conversation-noise`) integrado como paso bloqueante en CI.
- [x] Gate de readiness para FT (`ft:readiness`) integrado como paso bloqueante en CI.
- [x] Gate de golden set RAG (`benchmark:golden-set`) integrado como paso bloqueante en CI con dataset de 200 casos.
- [x] Gate de memory poisoning (`benchmark:memory-poisoning`) integrado como paso bloqueante en CI.

---

## 2) 🚨 Hallazgos pendientes (backlog priorizado)

### P1 inmediatos
- [x] **P1-09 | Ruido temporal en conversación:** TTL + summarization incremental implementados en `conversation-manager`.
- [x] **P1-10 | Drift funcional en `/api/conversation/turn`:** recall usa query aumentada con contexto conversacional.
- [x] **P1-11 | Path safety en pipeline ingest:** frontera de workspace validada en `/api/pipeline/run` + adapters.
- [x] **P1-12 | Aislamiento estricto por proyecto en storage/recall pipeline:** `projectId` propagado y `save/load` scoped por proyecto.
- [x] **P1-13 | Ingest sin hygiene gate:** chunks ingestado por adapter pasan por `evaluateMemoryWrite` antes de persistir.
- [x] **P1-14 | Duplicación `/api/chat` vs `/api/ask`:** validación/normalización compartida de payload para evitar drift.
- [x] **P1-15 | Rate limiter y cardinalidad:** eviction activa TTL-aware + LRU bajo presión de buckets (`maxBuckets`).

### P2 de robustez SDD
- [x] **P2-01 | SDD fail-fast opcional:** con `runGate=true`, bloqueo temprano si cobertura SDD mínima no se cumple (tunable por `LCS_AGENT_SDD_MIN_COVERAGE` y `LCS_AGENT_SDD_MIN_REQUIRED_KINDS`).
- [x] **P2-02 | Métricas SDD en observabilidad:** `sdd_coverage_rate`, `sdd_injected_kinds`, `sdd_skipped_reason`.
- [x] **P2-03 | Perfiles SDD por dominio/framework:** perfiles `default/backend/frontend/security` con resolución por `domain/framework/language/agentType` + override explícito `sddProfile`/env.
- [x] **P2-04 | Unificar métricas SDD + Teaching en todos los runtimes API:** `server.js` y `handlers.js` registran métricas Teaching (`coverage/practice`) y SDD bajo contrato común en observabilidad.
- [x] **P2-05 | Budget adaptativo inicial con feature flag:** `LCS_ADAPTIVE_BUDGET` + override por endpoint (`LCS_ADAPTIVE_BUDGET_ASK/CHAT/AGENT`) aplicado en selección de contexto y perfil de `/api/agent`.

---

## 3) 📦 Desacople de runtime legado (cerrado)

- [x] Renombrar adaptador legacy `*-swarm-adapter.js` -> `nexus-agent-runtime.js`.
- [x] Renombrar orquestador legacy `*-nexus-agent.js` -> `nexus-agent-orchestrator.js`.
- [x] Eliminar referencias legadas en imports de `src/` y `test/`.
- [x] Unificar imports finales en `src/orchestration/nexus-agent-bridge.js`.
- [x] Política GGA: uso externo como referencia/validador, sin incorporarla al código de NEXUS ni modificar su upstream.
- [x] GGA instalada en sistema como herramienta externa (validada con `gga v2.8.1` en shell MSYS).
- [x] GGA explícitamente fuera del runtime de NEXUS (no dependencia de `package.json`, no import en `src/`).

---

## 4) 🧠 Plan anti-ruido (contexto/tiempo) — NEXUS:3

### Objetivo
Reducir degradación por acumulación temporal y mantener señal estable en sesiones largas.

### Implementar
- [x] Windowing inteligente por turnos (sliding window + resumen incremental).
- [x] Compresión incremental cada N turnos (hechos/decisiones/tareas).
- [x] Filtro de novedad semántica (dedup temporal).
- [x] Detección de contradicciones entre memoria y contexto reciente.
- [x] Presupuesto configurable por origen (workspace/memoria/chat).
- [x] Telemetry anti-ruido: `noise_ratio`, `redundancy_ratio`, `context_half_life`, `source_entropy`.

### DoD
- [x] p95 de tokens de contexto baja >= 25% en sesiones >40 turnos (gate `benchmark:conversation-noise`).
- [x] hit-rate de chunks ancla (archivos cambiados) no cae con el tiempo (A/B baseline vs optimized).
- [x] supresión redundante > 0.6 sin pérdida de exactitud (A/B en gate anti-ruido).

---

## 5) 🔎 RAG (estado + casos aplicables)

### Estado auditado
- [x] BM25 + híbrido + selector de contexto disponibles.
- [x] RAG end-to-end unificado en `/api/ask` y `/api/chat` (auto-retrieval cuando no hay chunks explícitos + merge deduplicado).
- [x] Reranker semántico previo al prompt (hybrid score + semantic score) con flags `LCS_RAG_AUTO_RETRIEVE` y `LCS_RAG_ENABLE_RERANK`.
- [x] Métricas retrieval-first con gate operativo (`benchmark:retrieval-gate`) y umbrales (`Recall@k`, `MRR`, `nDCG@k`, `errorRate`, `p95 latency`).
- [x] Embeddings productivos en runtime con provider configurable y feature-flag (`LCS_RAG_EMBEDDINGS_ENABLED`) + test API de rerank por embeddings.

### Casos a aplicar
- [x] **Caso A (Alta):** soporte de código interno con citas de archivo/línea.
- [x] **Caso B (Alta):** runbooks + postmortems por patrón de incidente.
- [x] **Caso C (Media):** policies/compliance con trazabilidad documental.
- [x] **Caso D (Media):** memory recall por topic + recency decay.

---

## 6) 🧪 Fine-tuning (uso recomendado)

### Sí aplicar FT
- [x] **FT-1 (Alta):** piloto de formato estable (Change/Reason/Concepts/Practice) con gate automático (`benchmark:ft1-format`) + thresholds de lift.
- [ ] **FT-2 (Alta):** clasificador de intención/ruteo.
- [ ] **FT-3 (Media):** clasificador de riesgo previo al guard.
- [ ] **FT-4 (Media):** query rewriting controlado para retrieval.

### No aplicar FT (mantener en RAG)
- [ ] conocimiento cambiante del repo/config/incidentes.
- [ ] datos sensibles/secrets/PII.

### Gate previo
- [x] dataset curado + guard + sin ruido + sin secretos (gate `ft:readiness` con secret/duplicados/cobertura/practice).
- [ ] pipeline de etiquetado versionado.
- [x] benchmark offline/online contra baseline retrieval-first (gate dedicado sin degradar factualidad).

---

## 7) 🛠️ Practices (lista de implementación al final)

1. [x] Stress test 100 turnos: medir ruido + calidad de recall (`benchmark:conversation-noise`).
2. [x] A/B con y sin resumen incremental (`baseline` vs `optimized` en el mismo benchmark).
3. [x] Benchmark retrieval-first (`benchmark:retrieval-gate`) con umbrales de `Recall@k`, `MRR`, `nDCG@k`, `errorRate`, `p95 latency`.
4. [x] Golden set (200 queries reales + expected chunks) + gate (`benchmark:golden-set`) y generador (`benchmark:golden-set:generate`).
5. [x] Simulación memory poisoning + validación de hygiene gate (`benchmark:memory-poisoning`).
6. [x] Prueba aislamiento por proyecto en storage/recall.
7. [x] Prueba path safety de pipeline (`outside workspace` -> 400).
8. [x] Prueba rate-limit bajo alta cardinalidad IP.
9. [x] Piloto FT-1 (solo formato) + evaluación automática (`benchmark:ft1-format`).
10. [ ] Reporte semanal anti-ruido + decisión go/no-go FT-2.

---

## 8) Orden sugerido

### Fase A (inmediata)
- [x] P1-09 (TTL/summarization), P1-10 (drift conversación) y P1-11 (path safety pipeline) cerrados.

### Fase B (estabilidad)
- [x] P1-15.

### Fase C (evolución)
- [ ] Cerrar pendientes de evolución: FT-2, FT-3, FT-4 y pipeline de etiquetado versionado.

---

## 9) 📅 Plan operativo siguiente (ejecución)

### Bloque 1 — Seguridad de pipeline (P1-11)
- [x] Añadir `resolveSafePathWithinWorkspace` en ingest adapters de `/api/pipeline/run`.
- [x] Test: `outside workspace` devuelve 400.
- [x] Test de regresión: ingest válido dentro de root sigue funcionando.

### Bloque 2 — Ruido temporal (P1-09 + P1-10)
- [x] TTL configurable en `conversation-manager`.
- [x] Resumen incremental cada N turnos con dedup semántico.
- [x] Corregir `/api/conversation/turn` para usar query aumentada real.
- [x] Métrica mínima: reducción de tokens en sesiones largas sin pérdida de chunks ancla.

### Bloque 3 — Memoria y consistencia API (P1-12 + P1-13 + P1-14)
- [x] Aislamiento estricto por `projectId` en storage/recall.
- [x] Hygiene gate obligatorio antes de persistir `ingested`.
- [x] Unificar normalización/validación compartida entre `/api/chat` y `/api/ask`.
- [x] Paridad contractual por tests de API.

### Validación externa (sin integrar en NEXUS)
- [ ] Ejecutar GGA en modo externo sobre staged files del repo.
- [ ] Consumir findings como insumo del checklist, sin acoplar GGA al runtime ni al core.
