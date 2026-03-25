# NEXUS Release Checklist

Use this checklist before promoting changes to `main`.

## Code and quality

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run build:smoke`
- [ ] `npm run eval:domains`
- [ ] `npm run benchmark:vertical`
- [ ] `npm run benchmark:tune`
- [ ] `npm run benchmark:foundations`

## Security and safety

- [ ] `npm run security:pipeline:example`
- [ ] `npm run northstar:check -- --min-runs 20 --min-blocked-runs 1 --min-prevented-errors 1 --min-prevented-error-rate 0.005`
- [ ] Confirm no secrets in changed files
- [ ] Confirm output guard behavior for new API/LLM surfaces

## API and contracts

- [ ] `npm run openapi:export`
- [ ] Validate `/api/openapi.json` and `/api/demo`
- [ ] Validate `/api/versioning/*` and `/api/observability/*`
- [ ] Confirm SDK methods still match API paths

## Repository hygiene

- [ ] Update `docs/planning/nexus-plan.md` if scope changed
- [ ] Update `README.md` / `README.es.md` if user-facing behavior changed
- [ ] Update docs index (`docs/README.md`) when adding/removing docs
- [ ] Ensure branch is synced with `origin/main` and PR checks are green
