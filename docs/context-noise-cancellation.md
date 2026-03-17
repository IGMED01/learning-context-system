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

1. Normalize each chunk.
2. Tokenize in a language-agnostic way.
3. Score chunk utility.
4. Sort by utility.
5. Re-score against already selected chunks to penalize redundancy.
6. Compress long chunks by preserving focus-rich sentences.
7. Emit a final packet with:
   - selected chunks
   - suppressed chunks
   - scoring diagnostics
   - a teaching-oriented view of the same context

## Mathematical Intuition

This is not literal audio denoising. It is a signal selection problem.

We want to improve the ratio:

`useful task evidence / total prompt tokens`

When that ratio increases, the model receives a denser approximation of the task distribution. The expected next-token distribution becomes less influenced by irrelevant evidence, which reduces drift.

## Initial Implementation Choice

The first prototype uses plain Node.js and applies:

- keyword overlap scoring
- source-type priors
- certainty and teaching-value bonuses
- Jaccard-style redundancy penalties
- sentence-level compression

## Next Evolution

After this local prototype stabilizes, connect it to an `engram`-style memory layer so the selector can pull durable facts instead of depending only on the current session.
