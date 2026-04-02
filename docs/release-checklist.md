# NEXUS Release Checklist

Use this checklist before promoting changes to `main`.

Last execution: **2026-04-02**

## Code and quality

- [x] `npm test`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm run build:smoke`
- [x] `npm run eval:domains`
- [x] `npm run benchmark:vertical`
- [x] `npm run benchmark:tune`
- [x] `npm run benchmark:foundations`

## Security and safety

- [x] `npm run security:pipeline:example`
- [x] `npm run northstar:check -- --min-runs 20 --min-blocked-runs 1 --min-prevented-errors 1 --min-prevented-error-rate 0.005`
- [x] Confirm no secrets in changed files
- [x] Confirm output guard behavior for new API/LLM surfaces

## API and contracts

- [x] `npm run openapi:export`
- [x] Validate `/api/openapi.json` and `/api/demo`
- [x] Validate `/api/versioning/*` and `/api/observability/*`
- [x] Confirm SDK methods still match API paths

## Repository hygiene

- [x] Update `docs/planning/nexus-plan.md` if scope changed
- [x] Update `README.md` / `README.es.md` if user-facing behavior changed
- [x] Update docs index (`docs/README.md`) when adding/removing docs
- [ ] Ensure branch is synced with `origin/main` and PR checks are green
