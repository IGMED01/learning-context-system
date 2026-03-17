# Privacy and Security Roadmap

## Goal

Reduce the chance of leaking sensitive material while still preserving useful context for code learning.

## Scope

- ignored files
- inline secret redaction
- privacy docs
- safe scanning defaults

## Current state

- `.env`, private key, and certificate-like files are ignored
- inline secret-like values are redacted
- scan stats expose redaction counts

## Milestones

### Milestone 1 — Baseline protection

- keep the obvious sensitive patterns covered
- keep tests for ignored files and inline redaction

### Milestone 2 — Better policy control

- allowlist/denylist style configuration
- per-project scan rules
- clearer operator messaging around what never enters context

### Milestone 3 — Safer real-world adoption

- regression tests for secret handling
- better coverage of token formats and accidental credential patterns
- document limitations honestly

## Done means

- users know what the scanner ignores, what it redacts, and what still requires judgment

## Non-goals

- pretending this is a complete DLP system
