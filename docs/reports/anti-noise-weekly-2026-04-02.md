# Weekly Anti-Noise Report — 2026-04-02

## 1) Resumen ejecutivo

- Estado anti-ruido: **PASS**
- Decisión FT-2 (intent routing): **GO**
- Próximo paso: mantener monitoreo semanal y abrir baseline para FT-3/FT-4.

---

## 2) Evidencia (comandos ejecutados)

```bash
npm run benchmark:conversation-noise -- --format json
npm run benchmark:ft2-intent -- --format json
```

### Resultado anti-ruido (`benchmark:conversation-noise`)

- `passed=true`
- turns: `100`
- token reduction p95: `0.5509` (umbral >= `0.25`)
- optimized anchor hit rate: `1.0` (umbral >= `0.9`)
- anchor hit-rate drop: `0.0` (umbral <= `0.05`)
- optimized redundancy ratio: `0.6264` (umbral >= `0.6`)

### Resultado FT-2 (`benchmark:ft2-intent`)

- `passed=true`
- candidate accuracy: `1.0`
- baseline accuracy: `0.4167`
- accuracy lift: `0.5833`
- candidate macro-F1: `1.0`
- baseline macro-F1: `0.361`
- macro-F1 lift: `0.639`
- candidate unknown rate: `0.0`

---

## 3) Decisión go/no-go FT-2

**GO**: se cumple el gate de accuracy/macro-F1/lift con margen alto y sin unknowns.

Condiciones para mantener GO:
1. no degradar factualidad retrieval-first;
2. mantener dataset versionado y auditado;
3. revisar semanalmente drift de intención.
