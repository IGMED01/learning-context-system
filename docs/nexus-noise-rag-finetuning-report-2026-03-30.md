# Informe NEXUS — Ruido en Contexto, RAG y Fine-Tuning (2026-03-30)

## Resumen ejecutivo

NEXUS tiene una base sólida de selección de contexto (`noise-canceler`) para ruido simple, pero todavía sufre degradación estructural en sesiones largas y drift entre flujos API (`/api/chat`, `/api/ask`, conversación y pipeline).  
RAG existe en piezas (BM25/híbrido/selector), pero no está cerrado de punta a punta con retrieval automático y reranking semántico en todos los endpoints.  
Fine-tuning **sí aplica**, pero solo para comportamiento estable (formato/ruteo/safety), no para conocimiento cambiante del repositorio.

**Update iteración actual:** se implementó `LCS_CONTEXT_MODE=clean` con perfiles por endpoint y lógica SDD (`spec -> test -> code`) en selección de contexto, incluyendo cobertura reportada en respuestas API.

**Update 2026-03-31 (estado vigente):**
- Anti-ruido temporal cerrado: resumen incremental + TTL + dedup + detección de contradicciones + presupuesto por origen.
- RAG E2E cerrado en `/api/ask` y `/api/chat` con auto-retrieval y rerank.
- Embeddings productivos activables por feature flag (`LCS_RAG_EMBEDDINGS_ENABLED`) con provider configurable.
- Piloto FT-1 de formato implementado con gate automático (`benchmark:ft1-format`), con pass y lift medido.
- Piloto FT-2 de intención/ruteo implementado con gate automático (`benchmark:ft2-intent`), con `accuracy` y `macro-F1` mejorados contra baseline.

---

## 1) Verificación de ruido a lo largo del contexto/tiempo

## Pruebas rápidas ejecutadas

### Prueba A — selector bajo ruido masivo sintético
Escenario: 1 chunk señal (`src/auth/middleware.js`) + N chunks chat ruidosos.

Resultados:
- Noise=0 -> señal seleccionada ✅
- Noise=5 -> señal seleccionada ✅
- Noise=15 -> señal seleccionada ✅
- Noise=40 -> señal seleccionada ✅

Interpretación: el `noise-canceler` responde bien ante ruido obvio y redundante.

### Prueba B — crecimiento temporal de conversación
Escenario: sesión con 60 turnos acumulados en `conversation-manager`.

Resultados:
- `buildConversationContext(maxTurns=10)` -> contexto compacto estable.
- `buildConversationContext(maxTurns=50)` -> controlado por resumen incremental/TTL.
- resumen incremental/dedup -> **implementado**

Interpretación: la deriva temporal queda controlada y con telemetría explícita (`noise_ratio`, `redundancy_ratio`, `context_half_life`).

---

## 2) Hallazgos técnicos clave

1. **Métrica structuralHits rota**
   - `src/orchestration/nexus-agent-orchestrator.js` usaba `diagnostics.structuralHit` (campo inexistente).
   - Impacto: observabilidad engañosa en agentes.

2. **Scoring profile inválido en agente**
   - Se usa `scoringProfile: "symbol-aware"` pero no existe en `noise-canceler`.
   - Impacto: fallback silencioso y tuning no aplicado realmente.

3. **Acumulación de ruido en conversación**
   - `conversation-manager` no tiene TTL/límite de sesión ni resumen incremental.
   - Impacto: drift de contexto con el tiempo.

4. **Drift funcional en `/api/conversation/turn`**
   - Comentario indica query aumentada por conversación, pero ejecuta recall con `content` actual.
   - Impacto: se pierde señal histórica útil.

5. **Pipeline ingest sin frontera de workspace**
   - `/api/pipeline/run` + `default-executors.ingestWithAdapter` leen `sourcePath` sin validación de raíz.
   - Impacto: riesgo de lectura fuera de scope.

6. **Pipeline storage/recall sin aislamiento fuerte por proyecto**
   - Usa `upsertChunk/listChunks` legacy (sin `projectId` explícito en flujo).
   - Impacto: potencial mezcla de contexto entre proyectos.

7. **Ingest sin hygiene gate**
   - `runIngestCommand` guarda memoria cruda (`type: ingested`) sin evaluación de higiene.
   - Impacto: aumenta ruido/duplicación de memoria con el tiempo.

8. **Contrato duplicado entre `/api/chat` y `/api/ask`**
   - Validación/normalización no homogénea.
   - Impacto: comportamiento inconsistente y más superficie de bugs.

---

## 3) Estado real de RAG (hoy)

## Lo que sí está
- Chunking + metadata tagging + selector de contexto robusto.
- BM25 + retriever híbrido implementados.
- Evaluación base (`eval-runner`) con métricas de accuracy/relevance/consistency.

## Lo que falta para RAG “cerrado”
- Expandir evaluación retrieval-first por más dominios y tamaño de suite.
- Endurecer observabilidad de embeddings (latencia/costo por request y fallback ratios).
- Mantener tuning de rerank sin degradar latencia p95.

## Casos RAG recomendados (aplicables ya)
1. Soporte de código interno con citas de archivo/línea.
2. Runbooks e incidentes operativos (recuperación por patrón).
3. Policies/compliance internas con trazabilidad documental.
4. Recall de memoria por topic + recency decay para tareas de continuidad.

---

## 4) Fine-tuning: dónde sí y dónde no

## Sí aplicar FT
1. **Formato de salida pedagógica** (Change/Reason/Concepts/Practice consistente).
2. **Ruteo de intención** (clasificar consultas: teach/recall/guard/agent).
3. **Pre-clasificador de riesgo** (safety before guard).
4. **Query rewriting para retrieval** (siempre evaluado contra baseline RAG).

## No aplicar FT
- Conocimiento vivo del repositorio y procedimientos cambiantes.
- Datos de incidentes/configuración reciente.
- Cualquier contenido sensible (PII/secrets).

## Gate mínimo antes de FT
- Dataset curado y versionado (sin ruido, sin secretos, con validación de guard).
- Evaluación offline + canary online contra baseline RAG.
- Regla: FT no se promueve si baja factualidad o trazabilidad.

---

## 5) Recomendación de ejecución

1. Corregir primero bugs de señal/seguridad (structuralHits, profile inválido, path safety, aislamiento por proyecto).
2. Implementar anti-ruido temporal (resumen incremental + novelty filter + límites de sesión).
3. Cerrar RAG end-to-end en `/api/ask` y `/api/chat`.
4. Escalar desde FT-1 hacia FT-2 (intención) con dataset versionado + canary controlado.

