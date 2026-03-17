# Benchmark

## Qué es

Este proyecto ahora tiene dos benchmarks formales:

1. **selector benchmark**: mide si entra el contexto correcto
2. **recall benchmark**: mide si la estrategia de memoria encuentra recuerdos útiles sin duplicarlos

No mide “si se siente bien”. Mide comportamiento repetible.

## Archivos de casos

- `benchmark/selector-benchmark.json`
- `benchmark/recall-benchmark.json`

## Runners

```bash
npm run benchmark
npm run benchmark:recall
```

## Qué mide el selector benchmark

- `mustSelectRecall`: porcentaje de chunks obligatorios que sí fueron seleccionados
- `exclusionSuccess`: porcentaje de chunks prohibidos que sí quedaron afuera
- `relevantRatio`: porcentaje del contexto seleccionado que realmente es útil
- `topPrefixPass`: valida si los primeros lugares del ranking coinciden con el orden esperado

## Qué mide el recall benchmark

- `requiredRecall`: porcentaje de memorias esperadas que sí fueron recuperadas
- `queryEfficiency`: cuán rápido apareció la primera memoria útil
- `queryLimitPass`: valida que la estrategia no desperdicie demasiados intentos
- `firstMatchPass`: valida que el primer acierto ocurra dentro del rango esperado
- `exactChunkPass`: valida que la deduplicación no meta memorias repetidas

## Cómo usarlo

1. corrés ambos benchmarks antes de tocar ranking o recall
2. hacés cambios
3. los corrés de nuevo
4. comparás métricas

Si baja el `pass rate`, baja el `relevantRatio` o empeora `queryEfficiency`, el sistema retrocedió.
