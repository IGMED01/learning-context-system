---
name: engram-auto-orchestrator
description: Orchestrate automatic Engram usage for daily coding flows. Use when the user is implementing or debugging code and wants memory to be recalled/saved without manually remembering each command, while preserving degraded mode and scan-safety defaults.
---

# Engram Auto Orchestrator

## Core behavior

- Detect implementation intent first (`task`, `objective`, changed files, focused subsystem).
- Run memory recall before teaching output when memory is enabled.
- Fall back to degraded recall when Engram is unavailable.
- Keep scan-safety protections enabled by default.
- Persist only durable outcomes (decision, bugfix, pattern), not raw chat residue.

## Automatic flow

1. Load project config and resolve memory settings.
2. Build or load context chunks (`workspace` or `input`).
3. Recall memory using focused query variants.
4. Merge workspace context + recalled memory and run `teach`.
5. Save a concise durable memory when a meaningful fix/decision happened.

## Guardrails

- Do not save secrets, credentials, or full logs.
- Prefer `project` scope unless the user asks otherwise.
- If recall fails and `degradedRecall=true`, continue with empty memory and explain the degraded state.
- If `strictRecall=true`, fail loudly when recall is unavailable.

## Required output

1. Change
2. Reason
3. Concepts
4. Practice
