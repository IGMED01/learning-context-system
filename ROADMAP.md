# Roadmap

## Current status

The repository already has:

- context selection
- teaching packets
- Engram-backed memory recall and writes
- selector benchmark
- recall benchmark
- TypeScript backend vertical
- `doctor`, `init`, stable JSON contracts, and incremental typecheck

## Roadmaps by section

- [Core TypeScript](./docs/roadmaps/core-typescript.md)
- [Memory and Engram](./docs/roadmaps/memory-and-engram.md)
- [CLI and Operability](./docs/roadmaps/cli-and-operability.md)
- [Privacy and Security](./docs/roadmaps/privacy-and-security.md)
- [Quality and Benchmarks](./docs/roadmaps/quality-and-benchmarks.md)
- [Open Source Adoption](./docs/roadmaps/open-source-adoption.md)

## Current next focus

1. strengthen shared core typing inside the current one-repo ecosystem
2. keep internal domain boundaries explicit before any future multi-repo extraction
3. migrate more core logic under strict type checks
4. keep operability and privacy visible in CI and docs

## Non-goals for now

- browser UI
- splitting the system into multiple physical repos before contracts are stable
- multi-agent orchestration as the main path
- framework-specific adapters before the core is harder
