# Project Agents Contract

## Mission

Build an AI-assisted learning workspace where code generation and teaching happen together. Every meaningful code change should also produce a short explanation of:

- what changed
- why it changed
- which concept it teaches
- what to practice next

## Strategic Base

Use the following external repositories as inspiration, not as blind dependencies:

- `engram`: primary reference for persistent memory and context retrieval
- `gentleman-architecture-agents`: pattern for `AGENTS.md`, scope control, and framework-specific agent behavior
- `Gentle-Learning`: reference for educational UX and multi-agent teaching workflows
- `Gentleman-MCP`: future integration layer, not the initial base

Current decision: treat `engram` as the core repo to emulate for memory/context architecture.

Current implementation note: in this repository, Engram is used only for durable memory persistence and recall. It is not the selector, teaching engine, or code generator.

## Product Goals

1. Teach while coding.
2. Attach language-aware skills to each implementation flow.
3. Reduce context-window noise before sending code, docs, memories, or logs to an LLM.
4. Keep the context packet small, relevant, and pedagogically useful.

## Agent Operating Rules

1. Explain intent before large edits.
2. Prefer short context packets over raw dumps.
3. Prioritize code, tests, specs, and durable decisions over chat residue.
4. Suppress duplicated snippets, verbose logs, and stale discussion.
5. When teaching, move from concept to code to exercise.
6. End substantial tasks with a brief "what you learned" recap.
7. Before and after each substantial change, verify repo integrity (`git status`, current commit, and CI result when available).
8. Treat data and metadata preservation as critical: never drop files, contracts, or memory metadata silently.

## Lean Engineering Rule (No "more for the sake of more")

For each change, apply this filter in order:

1. **Need first**: if it does not improve reliability, security, operability, or learning value, skip it.
2. **Smallest valid change**: prefer minimal deltas over broad rewrites.
3. **Delete before adding**: remove duplication/dead branches before introducing new abstractions.
4. **Measure impact**: every meaningful change must be validated by tests/typecheck/build and, when relevant, CI.
5. **Stop condition**: once DoD is met, do not keep polishing aesthetic details.

## Data + Metadata Integrity (Critical)

For every relevant change:

1. confirm local branch and remote branch are synchronized
2. confirm file tree consistency with remote before closing the task
3. keep JSON contracts backward-compatible unless explicitly versioned
4. if a behavior writes memory, include explicit status metadata in outputs

## Teaching Loop

For every implementation task, try to produce these artifacts in the final answer:

1. `Change`: what changed in the codebase.
2. `Reason`: why this approach was chosen.
3. `Concepts`: 1-3 ideas the user should retain.
4. `Practice`: a tiny follow-up exercise or question.

## Context Noise Cancellation Rules

Before building a prompt or handing context to another agent:

1. Canonicalize input chunks.
2. Score each chunk by relevance, certainty, recency, and teaching value.
3. Penalize redundancy aggressively.
4. Compress oversized chunks by keeping focus-heavy sentences.
5. Keep an explicit record of what was suppressed and why.

## Preferred Context Sources

Highest priority:

- current task
- edited files
- tests touching the same behavior
- architectural decisions
- durable memory summaries

Lower priority:

- raw logs
- repeated stack traces
- exploratory chat
- generated files without semantic value

## Repository Map

- `README.md`: project overview
- `docs/repo-analysis.md`: decision on which Gentleman-Programming repo to use as base
- `docs/context-noise-cancellation.md`: mathematical and architectural design
- `src/context/noise-canceler.js`: scoring, deduplication, compression
- `src/learning/mentor-loop.js`: teaching packet builder
- `skills/`: language-specific and workflow-specific teaching skills
- `examples/typescript-backend/`: real TypeScript backend vertical for middleware/auth flows

## Current Runtime Constraint

This workspace currently has Node.js available. Python and Go are not available in the shell, so the initial prototype should stay runnable with plain Node.
