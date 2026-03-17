# Contributing

## What this project values

This repository is not a generic chatbot demo.

Every meaningful change should improve at least one of these layers:

1. context selection
2. teaching quality
3. durable memory
4. reproducible evaluation

## Before you change code

Read:

- `AGENTS.md`
- `README.md`
- `docs/usage.md`
- `docs/benchmark.md`

If the change touches the TypeScript backend demo, also read:

- `docs/typescript-backend-vertical.md`

## Local checks

Run:

```bash
node test/run-tests.js
npm run benchmark
npm run benchmark:recall
npm run benchmark:vertical
```

On Windows PowerShell, use `npm.cmd` if `npm.ps1` is blocked.

## Change rules

- Prefer small commits with one idea each.
- Do not degrade benchmark pass rates silently.
- If you change scoring or recall behavior, update or add a benchmark case.
- If you add a new workflow, document it in `docs/usage.md`.
- If you add a new durable pattern, save it to Engram when working locally.

## Pull request checklist

- [ ] tests pass
- [ ] selector benchmark passes
- [ ] recall benchmark passes
- [ ] vertical benchmark passes
- [ ] docs updated if CLI or workflow changed
- [ ] change explains what it teaches, not only what it does
