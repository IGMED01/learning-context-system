# Repo Analysis

## Goal

Choose the best `Gentleman-Programming` repository to accelerate a system that:

- teaches as code is written
- uses skills by language
- improves context quality before sending information to an LLM

## Candidates

### 1. `engram`

Best fit for the core of the system.

Why it fits:

- It is centered on persistent memory for coding agents.
- It is designed around storing and retrieving durable knowledge instead of only raw conversation state.
- That directly supports context-window quality, because relevant memory can be selected instead of replaying large chat histories.

How we should use it:

- as the architectural base for memory ingestion and retrieval
- as the reference model for durable summaries, decisions, and facts
- as the future bridge between current task context and long-lived project memory

### 2. `gentleman-architecture-agents`

Best fit for agent structure, not for memory.

Why it helps:

- It formalizes `AGENTS.md`-style project contracts.
- It separates agent behavior by framework and scope.
- It encourages smaller, more disciplined windows of responsibility.

How we should use it:

- as the template for our `AGENTS.md`
- as the pattern for language-specific skills and scoped agents

### 3. `Gentle-Learning`

Best fit for the teaching layer.

Why it helps:

- It is explicitly educational.
- It appears to use AI-oriented learning flows and multi-agent ideas.
- It is useful for designing how explanations, lessons, and guided practice appear next to code changes.

How we should use it:

- as inspiration for the UX of explanations
- as a reference for lesson sequencing and feedback loops

### 4. `Gentleman-MCP`

Useful later, but not the best initial base.

Why it is not the first choice:

- It is more about AI-first integration and protocol/tool connectivity.
- That matters once the system needs broader tool orchestration.
- It does not solve the core learning-plus-memory problem as directly as `engram`.

How we should use it:

- later, when we want to connect editors, external tools, or multi-service workflows

## Decision

Use `engram` as the exact repo to drive the first architecture of this system.

Then borrow patterns from:

- `gentleman-architecture-agents` for project context and scoping
- `Gentle-Learning` for the teaching experience

## Recommended Build Order

1. Implement a local context selector and summarizer.
2. Add durable memory records inspired by `engram`.
3. Add language-specific skills.
4. Add the pedagogical layer that explains each code change.
5. Integrate external tools through MCP only after the local loop is stable.

## Source Links

- [engram](https://github.com/Gentleman-Programming/engram)
- [gentleman-architecture-agents](https://github.com/Gentleman-Programming/gentleman-architecture-agents)
- [Gentle-Learning](https://github.com/Gentleman-Programming/Gentle-Learning)
- [Gentleman-MCP](https://github.com/Gentleman-Programming/Gentleman-MCP)
