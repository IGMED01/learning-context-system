---
name: nexus-comparative-benchmark
description: Run and interpret the technical comparison between NEXUS and a raw/no-NEXUS context baseline. Use when the user asks for proof of value, context/token/chunk/memory savings, a benchmark before or after selector/recall changes, or a short evidence report with concrete numbers and improvement signals.
---

# NEXUS Comparative Benchmark

## Core behavior

- Run the repo benchmark before estimating numbers manually.
- Prefer JSON output first, then summarize only the metrics the user asked for.
- Compare **raw context** vs **selected NEXUS context** without mixing extra assumptions.
- Keep the report focused on chunks, tokens, memory retention, overflow risk, and quality pass/fail.
- End with 2-3 concrete improvement signals when the benchmark reveals pressure points.

## Default command path

1. From repo root, run:
   - `cmd /c npm.cmd run benchmark:nexus-vs-raw -- --format json`
2. If PowerShell allows npm directly, `npm run benchmark:nexus-vs-raw -- --format json` is also valid.
3. For a human-readable pass, run:
   - `cmd /c npm.cmd run benchmark:nexus-vs-raw`

## What to report

1. `withoutNexus.chunks`
2. `withoutNexus.tokens`
3. `withNexus.chunks`
4. `withNexus.tokens`
5. `savings.percent`
6. `memory.retentionRate`
7. `summary.qualityPassRate`
8. `improvements`

## Interpretation rules

- If `overflowWithoutNexusRate` is high, say that raw context is operationally unsafe without NEXUS.
- If `avgTokenSavingsPercent` is high but `qualityPassRate` drops, prioritize quality over savings.
- If `memory.retentionRate` is low, inspect recall reserve and recall scoring before changing storage.
- If the corpus is too small, recommend adding new real cases instead of over-tuning heuristics.

## File map for follow-up fixes

- `src/context/noise-canceler.js` -> ranking, suppression, redundancy
- `src/memory/teach-recall.js` -> recall recovery flow
- `src/memory/engram-auto-orchestrator.js` -> auto-recall merge logic
- `src/benchmark/nexus-comparison.js` -> comparative benchmark logic
- `benchmark/vertical-benchmark.json` -> real cases under test
- `docs/benchmark.md` -> benchmark policy and meaning

## Validation after changes

- `npm test`
- `npm run benchmark:vertical`
- `npm run benchmark:nexus-vs-raw`
- `npm run doctor:json`
