# Propuesta mejorada: 5 dominios, 1 repo ahora

## Decisión recomendada

**Lo que conviene hoy es subir y consolidar todo en el repo de NEXUS**, manteniendo una división **lógica** en 5 dominios internos, **no** separar todavía en 5 repos físicos.

La separación en múltiples repos solo conviene cuando:

- cada dominio tiene releases independientes
- hay ownership de equipo distinto
- existen APIs internas estables
- la integración end-to-end ya está madura

Hoy el estado de madurez no justifica ese costo, especialmente con:

- `LCS CORE` alto
- `OBSERVABILITY` alto
- `VERSIONING` alto
- `SYNC`, `PROCESSING`, `STORAGE` y `LLM LAYER` todavía incompletos

## Qué hacer realmente

### Opción recomendada ahora

Mantener **un solo repo principal NEXUS**:

- `learning-context-system` (nombre actual en GitHub del repo NEXUS)

Y reorganizarlo en 5 dominios internos.

### Opción futura

Separar en repos físicos **más adelante**, solo si el crecimiento real lo pide.

## Estructura objetivo dentro del repo NEXUS

### 1) Core

**Responsabilidad**

- selección de contexto
- ranking y compresión
- teaching packet
- contratos centrales

**Capas**

- LCS CORE
- PROCESSING

**Carpetas**

- `src/context/`
- `src/learning/`
- `src/contracts/`
- `src/types/`
- `src/analysis/`

---

### 2) Memory + Sync

**Responsabilidad**

- memoria local
- recall orchestration
- fallback resiliente
- integraciones de sync

**Capas**

- STORAGE
- SYNC

**Carpetas**

- `src/memory/`
- `src/integrations/`

**Restricción**

- no publicar binarios, datos o wrappers privados de Engram

---

### 3) Ops + Safety

**Responsabilidad**

- guardrails
- secret redaction
- observabilidad
- calidad operativa
- discipline checks

**Capas**

- GUARD
- EVALS
- OBSERVABILITY
- VERSIONING

**Carpetas**

- `src/security/`
- `src/observability/`
- `src/ci/`
- `scripts/`

**Archivos**

- `SECURITY.md`
- `VERSIONING.md`
- `CHANGELOG.md`

---

### 4) Runtime

**Responsabilidad**

- CLI
- comandos
- orquestación ejecutable
- configuración del sistema

**Capas**

- ORCHESTRATION
- INTERFACE
- primer tramo de LLM LAYER

**Carpetas**

- `src/cli/`
- `src/system/`
- `src/io/`
- `src/cli.js`
- `src/index.js`

**Archivos**

- `package.json`
- `tsconfig.json`
- `tsconfig.build.json`
- `learning-context.config.json`

---

### 5) Platform

**Responsabilidad**

- documentación global
- demos
- ejemplos verticales
- benchmarks end-to-end
- visión completa del sistema

**Capas**

- vista integrada del ecosistema

**Carpetas**

- `docs/`
- `examples/`
- `benchmark/`
- `skills/`

**Archivos**

- `README.md`
- `README.es.md`
- `docs/planning/roadmap.md`
- `CONTRIBUTING.md`

## Mapa resumido

| Dominio interno | Capas |
|---|---|
| Core | LCS CORE, PROCESSING |
| Memory + Sync | STORAGE, SYNC |
| Ops + Safety | GUARD, EVALS, OBSERVABILITY, VERSIONING |
| Runtime | ORCHESTRATION, INTERFACE, parte inicial de LLM LAYER |
| Platform | integración, docs, demos, benchmarks |

## Por qué no conviene dividir en 5 repos ahora

Separar ahora agregaría:

- versionado cruzado
- CI duplicado
- contratos internos frágiles
- más fricción para refactors transversales
- más trabajo de release que de producto

Además, hoy muchas piezas cambian juntas:

- CLI + contracts + context selection
- recall + observability + degraded mode
- security + scanning + teach pipeline

Eso indica que todavía están en fase de **co-evolución**, no de independencia.

## Cuándo sí conviene extraer repos físicos

Separar un dominio en repo propio solo cuando cumpla al menos 4 de estas 6 condiciones:

1. tiene tests propios suficientes
2. tiene contratos públicos claros
3. puede versionarse sin romper a los demás
4. tiene CI útil por sí solo
5. tiene owner claro
6. cambia con una cadencia distinta al repo principal

## Orden recomendado

### Fase 1 — ahora

- subir y estabilizar todo en `learning-context-system` (repo NEXUS)
- ordenar carpetas por dominio
- mejorar boundaries internos
- mantener Engram fuera de lo público si corresponde

### Fase 2 — después

si una parte madura de verdad, recién ahí extraer:

- `learning-context-platform` si UI/demo/app crece mucho
- `learning-context-ops` si seguridad/observabilidad se vuelve reusable
- `learning-context-memory-sync` si las integraciones y storage se estabilizan

### Fase 3 — solo si el producto explota en complejidad

pasar de 1 repo a:

- 3 repos
- no 5 de entrada

## Recomendación final

### Lo que conviene hacer ahora

**Subir todo al repo de NEXUS**, pero con esta narrativa:

- un solo repo físico
- cinco dominios internos bien definidos
- boundaries claros
- Engram fuera de lo que no te pertenece publicar

### Lo que no conviene hacer ahora

- abrir 5 repos físicos de entrada
- dividir solo para “tener más proyectos”
- fragmentar ownership antes de tener interfaces estables

## Regla práctica

**Primero modularizar. Después extraer. No al revés.**
