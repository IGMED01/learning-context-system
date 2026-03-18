# Ops Runbook

## Goal

Operate the CLI safely in day-to-day work with reproducible validation and memory safeguards.

## 1) Daily startup checks

```bash
npm.cmd ci
npm.cmd run doctor
```

Expected:

- `doctor` has no `fail`
- `warn` is acceptable only for optional Engram runtime in clean environments

## 2) Core validation gate (before push)

```bash
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:smoke
npm.cmd test
npm.cmd run benchmark
npm.cmd run benchmark:recall
npm.cmd run benchmark:vertical
```

Push only when all pass.

## 3) Memory safety operating rules

- Keep `memory.autoRecall=true` for normal teach flows.
- Keep `memory.autoRemember=false` by default unless explicitly needed.
- When `autoRemember=true`, verify `autoMemory.rememberRedactionCount` and `autoMemory.rememberSensitivePathCount` in output.
- Treat any `Auto remember failed:` warning as degraded output and investigate before relying on persisted memory.

## 4) Incident / degraded mode response

If Engram is unavailable:

1. Run `node src/cli.js doctor --format text`.
2. Continue with `teach` in degraded mode (no hard stop unless `strictRecall=true`).
3. Fix Engram path/runtime and rerun `doctor`.

## 5) Release checkpoint

For a stable cut:

1. Ensure CI is green on `main`.
2. Create annotated tag.
3. Publish GitHub release.
4. Record validation evidence in release notes.

## 6) Branch safety

`main` is branch-protected with required CI checks:

- `validate (20)`
- `validate (22)`

Do not bypass protections for routine changes.
