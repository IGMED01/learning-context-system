# CLI and Operability Roadmap

## Goal

Make the project installable, diagnosable, and scriptable by someone who did not build it.

## Scope

- doctor
- init
- stable JSON output
- config loading
- runtime metadata

## Current state

- `doctor` exists
- `init` exists
- JSON output is versioned
- runtime metadata is present in JSON contracts

## Milestones

### Milestone 1 — Installation clarity

- document prerequisites clearly
- improve doctor fixes
- tighten init flow and defaults

### Milestone 2 — Better machine integration

- stable exit codes by failure class
- cleaner JSON schemas per command
- explicit command-level diagnostics

### Milestone 3 — Operator ergonomics

- `doctor --json` ready for automation
- stronger default config patterns
- future `check` / `validate-config` style flows if needed

## Done means

- a new user can install, diagnose, and run the first useful command without hand-holding
- another tool can safely consume CLI JSON output

## Non-goals

- building a GUI before the CLI is truly reliable
