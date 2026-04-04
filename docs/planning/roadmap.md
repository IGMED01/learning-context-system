# Roadmap

## Current status

The repository already has:

- context selection
- teaching packets
- Engram-backed memory recall and writes
- NEXUS processing/storage/guard foundations implemented
- NEXUS LLM layer + API/auth + orchestration pipeline base
- NEXUS sync/eval/versioning/observability quality base
- selector benchmark
- recall benchmark
- TypeScript backend vertical
- `doctor`, `init`, stable JSON contracts, and incremental typecheck

Detailed execution checklists and implementation plans are now maintained as local-only artifacts (not versioned on GitHub).

## Roadmaps by section

- [Core TypeScript](../roadmaps/core-typescript.md)
- [Memory and Engram](../roadmaps/memory-and-engram.md)
- [CLI and Operability](../roadmaps/cli-and-operability.md)
- [Privacy and Security](../roadmaps/privacy-and-security.md)
- [Quality and Benchmarks](../roadmaps/quality-and-benchmarks.md)
- [Open Source Adoption](../roadmaps/open-source-adoption.md)

## Current next focus

1. strengthen shared core typing inside the current one-repo ecosystem
2. close FASE 4 polish items (SDK, OpenAPI, dashboard UI, full demo)
3. keep internal domain boundaries explicit before any future multi-repo extraction
4. migrate more core logic under strict type checks

## Non-goals for now

- browser UI
- splitting the system into multiple physical repos before contracts are stable
- multi-agent orchestration as the main path
- framework-specific adapters before the core is harder
