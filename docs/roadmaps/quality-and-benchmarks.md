# Quality and Benchmarks Roadmap

## Goal

Make changes defendable with tests and benchmarks instead of intuition.

## Scope

- portable tests
- selector benchmark
- recall benchmark
- vertical benchmark
- CI gates

## Current state

- tests pass
- selector / recall / vertical benchmarks pass
- CI runs typecheck, tests, and benchmarks

## Milestones

### Milestone 1 — Better regression coverage

- keep every meaningful bug behind a test
- add more edge cases around degraded recall and scan policy

### Milestone 2 — Harder benchmark scenarios

- tighter token budgets
- noisier repos
- more memory-vs-code conflicts

### Milestone 3 — Real-world repo evaluation

- run on larger or less curated repos
- track latency, relevance, and suppression quality
- compare before/after changes with evidence

## Done means

- a ranking or recall change can be judged with data, not vibes

## Non-goals

- benchmark theater without actionable conclusions
