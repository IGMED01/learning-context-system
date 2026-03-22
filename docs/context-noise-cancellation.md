# Context Noise Cancellation

## Problem

Large context windows do not automatically preserve quality. When low-value tokens dominate the window, the model spreads attention over irrelevant material and the probability mass assigned to the most useful continuations becomes less concentrated.

In practice, that means:

- more distraction from logs and repeated snippets
- weaker grounding in the real task
- lower precision in code generation and explanation

## Goal

Maximize signal per token before context reaches the model.

## Working Definition

Context noise cancellation is the process of:

1. scoring incoming context chunks
2. suppressing duplicated or stale material
3. compressing oversized chunks without losing the task signal
4. preserving the pieces that best explain the current change

## Core Heuristics

### Relevance

Prefer chunks that overlap with:

- the current task
- the active files
- the requested concepts
- the expected implementation area

### Certainty

Prefer facts, specs, code, and tests over speculation or exploratory chat.

### Recency

Prefer chunks tied to the current task or most recent decisions.

### Teaching Value

Prefer chunks that explain intent, constraints, or examples that help the learner understand the implementation.

### Redundancy Penalty

Two chunks that say almost the same thing should not both consume the prompt budget.

## Pipeline

1. Normalize and compress each chunk (sentence-level compression preserving focus-rich sentences).
2. Tokenize once per chunk and cache tokens in `PreparedChunk.tokens` for reuse.
3. Tokenize the focus query once and cache as `focusTokens`.
4. Score all chunks using cached tokens (overlap, kind prior, certainty, recency, teaching value, source affinity, implementation fit, recall origin boost, minus penalties for redundancy, generic sources, narrative memory, and generic test runners).
5. Sort by score and split into recall-ranked (engram origin) and workspace-ranked lists.
6. **Two-pass selection with reserved recall budget**:
   - Pass 1 (recall): select engram chunks within `recallReserveRatio` of the token budget.
   - Pass 2 (workspace): fill remaining budget with workspace chunks.
   - Pass 3 (overflow): give recall chunks that exceeded the reserve budget a second chance in the general budget.
7. Re-score each candidate against already-selected chunks using cached tokens to penalize redundancy (Jaccard similarity ≥ 0.65 triggers suppression).
8. **Bounded rebalance**: swap low-scoring recall chunks for higher-scoring workspace candidates when justified, limited to `maxChunks` iterations.
9. Sort final selection by score (highest first).
10. Emit a final packet with:
    - selected chunks (with origin metadata: `engram` or `workspace`)
    - suppressed chunks (with reason: `score-below-threshold`, `token-budget-exceeded`, `max-chunks-reached`, `generic-doc-noise`, `generic-test-noise`, `redundant-context`, `workspace-priority-over-recall`)
    - scoring diagnostics
    - a teaching-oriented view of the same context

## Mathematical Intuition

This is not literal audio denoising. It is a signal selection problem.

We want to improve the ratio:

`useful task evidence / total prompt tokens`

When that ratio increases, the model receives a denser approximation of the task distribution. The expected next-token distribution becomes less influenced by irrelevant evidence, which reduces drift.

## Current Implementation

Plain Node.js with no external ML dependencies. Applies:

- keyword overlap scoring with cached tokenization (focus tokenized once, chunk tokens cached in `PreparedChunk`)
- source-type priors (`code > test > spec > memory > doc > chat > log`)
- certainty, recency, and teaching-value bonuses
- source affinity, change anchor, and implementation fit scoring
- recall origin boost for engram-sourced chunks
- Jaccard-style redundancy penalties (using cached tokens)
- generic source, narrative memory, and test runner penalties
- sentence-level compression preserving focus-rich sentences
- two-pass selection with configurable `recallReserveRatio`
- bounded recall↔workspace rebalance loop

## Engram Integration

The selector pulls durable memory from Engram when available, with resilient degraded-mode fallback to local store. Recalled chunks receive a `recallOriginBoost` during scoring and are allocated a reserved token budget via `recallReserveRatio` (default 15%). Chunk origin (`engram` or `workspace`) is always exposed in the output packet.
