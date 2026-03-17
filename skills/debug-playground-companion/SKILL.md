---
name: debug-playground-companion
description: Debug the Learning Context System playground and CLI flows. Use when `select`, `teach`, or `recall` behave unexpectedly; when chunks are missing or suppressed; when Engram recall is empty or recovered memory is not selected; when token budget, changed files, or score signals need explanation; or when the user wants a minimal reproduction plus a teaching-oriented root cause.
---

# Debug Playground Companion

## Core behavior

- Reproduce with the smallest existing playground command before editing code.
- Prefer the repo's built-in playground scripts over ad-hoc commands.
- Compare normal output and `--debug` output before changing heuristics.
- Separate workspace-context problems from Engram-memory problems early.
- End with root cause, smallest fix, validation, and one tiny practice step.

## Fast triage

1. **Selection-only problem**
   - Run `cmd /c npm.cmd run playground:select`
   - Then run `cmd /c npm.cmd run playground:select:debug`
2. **Synthetic teaching problem**
   - Run `cmd /c npm.cmd run playground:teach:synthetic`
   - Use this path when the behavior should be deterministic and should not depend on historical memory.
3. **Memory or recall problem**
   - Run `cmd /c npm.cmd run playground:recall:debug`
   - Then run `cmd /c npm.cmd run playground:teach:memory:debug`
4. **Environment problem**
   - If PowerShell blocks `npm.ps1`, use `cmd /c npm.cmd ...` or `node ...` directly.

## Decision rules

- Stay in the synthetic playground when the issue is about the auth example, teaching wording, or deterministic selection behavior.
- Move to the memory-backed playground when the issue mentions Engram, empty recall, query quality, recovered memory, or recalled chunks being suppressed.
- If memory is recovered but not selected, inspect `Selected recalled ids`, `Suppressed recalled ids`, and `Suppression reasons` before changing query generation.
- Fix the smallest layer first instead of refactoring broadly.

## Symptom to file map

- Recall query quality or fallback order -> `src/memory/recall-queries.js`
- Recall retry or merge behavior -> `src/memory/teach-recall.js`
- Chunk scoring, suppression, or token budget effects -> `src/context/noise-canceler.js`
- Debug presentation or missing diagnostics -> `src/cli/formatters.js`
- CLI option wiring -> `src/cli/app.js`
- Playground entrypoints or discoverability -> `package.json`, `docs/usage.md`
- Regression coverage -> `test/run-tests.js`

## Required output

1. Reproduction
2. Root cause
3. Smallest fix
4. Validation
5. Change
6. Reason
7. Concepts
8. Practice

## Pay extra attention to

- `workspace` vs `engram` chunk origin
- `token-budget-exceeded` versus `score-below-threshold`
- `generic-doc-noise` and `generic-test-noise`
- recovered memory ids that never survive final selection
- deterministic reproduction before changing heuristics
