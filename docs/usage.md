# Usage

## What the tool does

The project now exposes a local CLI that reads a JSON file of context chunks and produces one of two outputs:

- a filtered context window
- a teaching-oriented packet built on top of that filtered window
- a generated learning README for humans
- a memory recall flow backed by Engram
- a durable memory write flow backed by Engram

## Why a CLI matters

Before this, the project was only a library. That is not enough for a serious repo because another person cannot evaluate the system quickly.

With the CLI, the workflow becomes:

1. collect chunks
2. save them in JSON
3. run the selector
4. inspect the chosen context
5. run the teaching packet builder
6. generate a README that tells a teammate what to learn first
7. recall recent or historical memory from Engram
8. save durable learnings back into Engram

You can now skip manual JSON for many tasks by using `--workspace .`, which scans the repository and builds chunks from local files automatically.

## Command 1: Select useful context

```bash
node src/cli.js select --input examples/auth-context.json --focus "jwt middleware expired session validation" --min-score 0.25 --format text
```

What happens internally:

1. the CLI parses command-line options
2. it loads and validates the JSON input
3. it calls the context selector
4. it returns selected chunks and suppressed chunks

## Command 2: Build a learning packet

```bash
node src/cli.js teach --input examples/auth-context.json --task "Improve auth middleware" --objective "Teach why validation runs before route handlers" --changed-files "src/auth/middleware.ts,test/auth/middleware.test.ts" --project learning-context-system --min-score 0.25 --format text
```

What happens internally:

1. the CLI parses command-line options
2. it loads the same chunk file
3. it builds several recall queries from the task, objective, focus, and changed files
4. it searches Engram progressively until it finds useful memory or exhausts those queries
5. it converts the recovered memories into `memory` chunks
6. it merges those chunks with the local code/test/spec context
7. it calls the mentor loop
8. the mentor loop first calls the context selector
9. it then adds teaching scaffolding on top of the selected context

## Command 3: Generate a learning README

```bash
node src/cli.js readme --workspace . --focus "learning context cli noise cancellation" --output README.LEARN.md --format text
```

What happens internally:

1. the CLI scans the workspace into chunks
2. it selects the most relevant context for the requested focus
3. it inspects project metadata and imports
4. it infers which concepts are required to understand the code
5. it writes a markdown guide that lists dependencies, concepts, reading order, and data flow

## Command 4: Recall memory from Engram

```bash
node src/cli.js recall --project learning-context-system --query "auth middleware" --type decision --scope project --limit 5 --format text
```

What happens internally:

1. the CLI decides whether you want recent context or a historical search
2. it creates an Engram client pointed at the local binary and data directory
3. it runs `engram search` when you provide `--query`
4. it runs `engram context` when you omit `--query`
5. it returns the raw Engram memory wrapped in a clearer CLI summary

## Command 5: Save a durable memory into Engram

```bash
node src/cli.js remember --title "JWT order" --content "Validation runs before route handlers." --project learning-context-system --type decision --topic architecture/auth-order --format text
```

What happens internally:

1. the CLI validates that you provided a title and content
2. it creates an Engram client
3. it runs `engram save`
4. Engram persists the observation in SQLite
5. the CLI prints what was saved and where the database lives

## Command 6: Close the work session with a structured note

```bash
node src/cli.js close --summary "Integrated recall and remember commands." --learned "Context retrieval and durable memory are different layers." --next "Connect recall to the teaching flow." --project learning-context-system --format text
```

What happens internally:

1. the CLI builds a structured summary note
2. it includes the summary, what you learned, what comes next, and the workspace path
3. it saves that note through Engram
4. this is a practical session-close note, not the full MCP session lifecycle yet

## Automatic memory recall during teach

By default, `teach` now does a best-effort recall from Engram.

It no longer depends on one raw sentence only. The CLI first derives shorter concept-heavy queries such as:

- architecture terms from changed files
- noun-like variants such as `validation` from `validate` or `integration` from `integrate`
- compressed keyword groups instead of the whole task sentence

Useful options:

- `--project`: narrows recall to one Engram project
- `--recall-query`: overrides the query used for memory search
- `--memory-limit`: caps how many memories are imported as chunks
- `--memory-type`: filters recall by Engram memory type
- `--memory-scope`: defaults to `project`
- `--no-recall`: disables the feature
- `--strict-recall`: fails the command if Engram recall fails instead of continuing without memory

## Input contract

The JSON file must look like this:

```json
{
  "chunks": [
    {
      "id": "auth-middleware",
      "source": "src/auth/middleware.ts",
      "kind": "code",
      "content": "The authentication middleware validates the bearer token first."
    }
  ]
}
```

Optional numeric fields:

- `certainty`
- `recency`
- `teachingValue`
- `priority`

All optional numeric fields must be between `0` and `1`.

Useful CLI thresholds:

- `--min-score`: drops weak matches before they consume prompt budget
- `--max-chunks`: caps how many chunks survive
- `--sentence-budget`: compresses long chunks more aggressively

Input source options:

- `--input`: load chunks from a prepared JSON file
- `--workspace`: scan the repository directly and build chunks automatically

Advanced Engram options:

- `--engram-bin`: override the local path to `engram.exe`
- `--engram-data-dir`: override the Engram data directory
