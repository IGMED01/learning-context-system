# Core TypeScript Roadmap

## Goal

Move the core from "disciplined JavaScript" to "strictly typed and safer to refactor" without breaking the local CLI.

## Scope

- context selection
- mentor loop
- recall strategy
- Engram adapter contracts
- shared type contracts

## Current state

- incremental `typecheck` exists
- config/bootstrap/scanner already pass strict checking
- core runtime still lives mostly in `.js`

## Milestones

### Milestone 1 — Shared contracts

- define shared core types for chunks, packets, memory recall, doctor checks, and CLI metadata
- replace repeated ad-hoc JSDoc object shapes
- keep runtime behavior unchanged

### Milestone 2 — Core modules under strict typing

- harden:
  - `src/context/noise-canceler.js`
  - `src/learning/mentor-loop.js`
  - `src/memory/teach-recall.js`
  - `src/memory/engram-client.js`
- eliminate the most fragile implicit `any` paths

### Milestone 3 — Real `.ts` migration

- move selected core files to `.ts`
- add build output strategy for publishable CLI use
- preserve current command behavior and benchmark outputs

## Done means

- typecheck covers the core, not only bootstrap
- refactors of scoring/packet/memory shape are safer
- CI fails on type regressions before runtime breaks

## Non-goals

- rewriting the whole repo to TS in one shot
- changing the product flow just to satisfy the compiler
