import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildLearningReadme } from "../src/analysis/readme-generator.js";
import { runCli } from "../src/cli/app.js";
import { parseChunkFile } from "../src/contracts/context-contracts.js";
import { loadWorkspaceChunks } from "../src/io/workspace-chunks.js";
import { buildLearningPacket } from "../src/learning/mentor-loop.js";
import {
  buildCloseSummaryContent,
  createEngramClient,
  searchOutputToChunks
} from "../src/memory/engram-client.js";
import { buildTeachRecallQueries } from "../src/memory/recall-queries.js";
import { compressContent, selectContextWindow } from "../src/context/noise-canceler.js";

const tests = [];

function run(name, fn) {
  tests.push({ name, fn });
}

run("prioritizes relevant code and filters noisy logs", () => {
  const chunks = [
    {
      id: "code-auth",
      source: "src/auth.js",
      kind: "code",
      content: "Authentication middleware validates JWT tokens and rejects expired sessions.",
      certainty: 0.95,
      recency: 0.9,
      teachingValue: 0.8,
      priority: 0.9
    },
    {
      id: "log-noise",
      source: "runtime.log",
      kind: "log",
      content: "INFO boot INFO boot INFO boot debug trace trace trace repeated service heartbeat.",
      certainty: 0.3,
      recency: 0.4,
      teachingValue: 0.1,
      priority: 0.1
    },
    {
      id: "test-auth",
      source: "test/auth.test.js",
      kind: "test",
      content: "Tests cover invalid JWT handling and expired session behavior in middleware.",
      certainty: 0.9,
      recency: 0.85,
      teachingValue: 0.75,
      priority: 0.8
    }
  ];

  const result = selectContextWindow(chunks, {
    focus: "jwt middleware expired session validation",
    tokenBudget: 120
  });

  assert.equal(result.selected[0].id, "code-auth");
  assert.ok(result.selected.some((chunk) => chunk.id === "test-auth"));
  assert.ok(result.suppressed.some((chunk) => chunk.id === "log-noise"));
});

run("suppresses highly redundant chunks", () => {
  const chunks = [
    {
      id: "memory-a",
      source: "memory/a.md",
      kind: "memory",
      content: "Use optimistic updates in the cart service to keep the UI responsive.",
      certainty: 0.9,
      recency: 0.8,
      teachingValue: 0.7,
      priority: 0.8
    },
    {
      id: "memory-b",
      source: "memory/b.md",
      kind: "memory",
      content: "Use optimistic updates in the cart service to keep the UI responsive for users.",
      certainty: 0.9,
      recency: 0.75,
      teachingValue: 0.68,
      priority: 0.75
    }
  ];

  const result = selectContextWindow(chunks, {
    focus: "optimistic updates cart ui",
    tokenBudget: 120
  });

  assert.equal(result.selected.length, 1);
  assert.ok(result.suppressed.some((chunk) => chunk.id === "memory-b"));
});

run("keeps the most focus-heavy sentences during compression", () => {
  const content = [
    "The cache layer is experimental and unrelated.",
    "JWT verification happens inside the auth middleware before request routing.",
    "Old notes about CSS refactors are not important here.",
    "Expired sessions trigger a 401 response and short-circuit the pipeline."
  ].join(" ");

  const compressed = compressContent(content, "jwt auth middleware expired sessions", 2);

  assert.match(compressed, /JWT verification/);
  assert.match(compressed, /Expired sessions/);
  assert.doesNotMatch(compressed, /CSS refactors/);
});

run("builds a learning packet with teaching scaffolding", () => {
  const packet = buildLearningPacket({
    task: "Improve auth middleware",
    objective: "Teach why JWT validation order matters",
    changedFiles: ["src/auth.js"],
    chunks: [
      {
        id: "code-auth",
        source: "src/auth.js",
        kind: "code",
        content: "JWT validation now runs before route handlers to fail fast on invalid tokens.",
        certainty: 0.95,
        recency: 0.9,
        teachingValue: 0.9,
        priority: 0.95
      }
    ]
  });

  assert.equal(packet.selectedContext.length, 1);
  assert.equal(packet.changedFiles[0], "src/auth.js");
  assert.equal(packet.teachingChecklist.length, 4);
});

run("validates chunk file input and rejects invalid kinds", () => {
  assert.throws(
    () =>
      parseChunkFile(
        JSON.stringify({
          chunks: [
            {
              id: "x",
              source: "src/x.ts",
              kind: "unknown",
              content: "bad"
            }
          ]
        }),
        "inline.json"
      ),
    /must be one of/
  );
});

run("cli select returns a readable context summary", async () => {
  const result = await runCli([
    "select",
    "--input",
    "examples/auth-context.json",
    "--focus",
    "jwt middleware expired session validation",
    "--format",
    "text"
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Selected chunks:/);
  assert.match(result.stdout, /auth-middleware/);
  assert.doesNotMatch(result.stdout, /legacy-chat from/);
});

run("cli teach returns a teaching packet summary", async () => {
  const result = await runCli([
    "teach",
    "--input",
    "examples/auth-context.json",
    "--task",
    "Improve auth middleware",
    "--objective",
    "Teach why validation runs before route handlers",
    "--changed-files",
    "src/auth/middleware.ts,test/auth/middleware.test.ts",
    "--format",
    "text"
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Memory recall:/);
  assert.match(result.stdout, /Teaching checklist:/);
  assert.match(result.stdout, /Changed files:/);
  assert.doesNotMatch(result.stdout, /legacy-chat from/);
});

run("workspace scanning collects repository chunks", async () => {
  const result = await loadWorkspaceChunks(".");

  assert.ok(result.payload.chunks.length > 5);
  assert.ok(result.payload.chunks.some((chunk) => chunk.source === "src/cli.js"));
  assert.ok(result.payload.chunks.some((chunk) => chunk.source === "package.json"));
});

run("readme generator infers concepts and reading order", async () => {
  const workspace = await loadWorkspaceChunks(".");
  const result = await buildLearningReadme({
    title: "README.LEARN",
    projectRoot: ".",
    focus: "learning context cli noise cancellation",
    chunks: workspace.payload.chunks
  });

  assert.match(result.markdown, /# README\.LEARN/);
  assert.match(result.markdown, /## Dependencies/);
  assert.match(result.markdown, /## Core Concepts To Learn First/);
  assert.match(result.markdown, /Node\.js/);
  assert.match(result.markdown, /src\/cli\.js/);
});

run("cli readme writes markdown output", async () => {
  const outputPath = "test-output/README.LEARN.md";
  const result = await runCli([
    "readme",
    "--workspace",
    ".",
    "--focus",
    "learning context cli noise cancellation",
    "--output",
    outputPath,
    "--format",
    "text"
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /README generated at/);

  const written = await readFile(outputPath, "utf8");
  assert.match(written, /## How The Code Flows/);
  assert.match(written, /## Dependencies/);
});

run("numeric CLI options reject invalid ranges", async () => {
  const failure = await runCli([
    "select",
    "--input",
    "examples/auth-context.json",
    "--focus",
    "jwt middleware expired session validation",
    "--min-score",
    "1.5"
  ]).catch((error) => error);

  assert.match(String(failure.message ?? failure), /--min-score must be <= 1/);
});

run("engram client builds search and save commands with workspace-backed env", async () => {
  /** @type {Array<{ file: string, args: string[], options: import("node:child_process").ExecFileOptions }>} */
  const calls = [];
  const client = createEngramClient({
    cwd: "C:/repo",
    binaryPath: "C:/repo/tools/engram/engram.exe",
    dataDir: "C:/repo/.engram",
    exec: async (file, args, options) => {
      calls.push({
        file,
        args: [...args],
        options
      });

      return {
        stdout: "ok",
        stderr: ""
      };
    }
  });

  await client.searchMemories("jwt middleware", {
    project: "learning-context-system",
    scope: "project",
    type: "learning",
    limit: 3
  });
  await client.saveMemory({
    title: "Auth order",
    content: "Validation happens before handlers.",
    project: "learning-context-system",
    scope: "project",
    type: "decision",
    topic: "architecture/auth-order"
  });
  const closed = await client.closeSession({
    summary: "Integrated memory into the teaching flow.",
    project: "learning-context-system"
  });

  assert.match(calls[0].file, /C:[\\/]+repo[\\/]+tools[\\/]+engram[\\/]+engram\.exe/);
  assert.deepEqual(calls[0].args, [
    "search",
    "jwt middleware",
    "--type",
    "learning",
    "--project",
    "learning-context-system",
    "--scope",
    "project",
    "--limit",
    "3"
  ]);
  assert.match(String(calls[0].options.env?.ENGRAM_DATA_DIR), /C:[\\/]+repo[\\/]+\.engram/);
  assert.deepEqual(calls[1].args, [
    "save",
    "Auth order",
    "Validation happens before handlers.",
    "--type",
    "decision",
    "--project",
    "learning-context-system",
    "--scope",
    "project",
    "--topic",
    "architecture/auth-order"
  ]);
  assert.equal(closed.action, "close");
  assert.equal(calls[2].args[0], "save");
});

run("close summary builder captures summary, learning, and next step", () => {
  const content = buildCloseSummaryContent({
    summary: "Integrated Engram into the CLI",
    learned: "Recent context and durable memory are different layers.",
    next: "Wire recall output into the teaching flow.",
    workspace: "C:/repo",
    closedAt: "2026-03-17T18:00:00.000Z"
  });

  assert.match(content, /Session Close Summary/);
  assert.match(content, /Integrated Engram into the CLI/);
  assert.match(content, /durable memory are different layers/);
  assert.match(content, /Wire recall output into the teaching flow/);
});

run("engram search output is converted into memory chunks", () => {
  const chunks = searchOutputToChunks(
    [
      "Found 1 memories:",
      "",
      "[1] #2 (architecture) — CLI Engram integration",
      "    Added recall, remember, and close commands to wrap the local Engram binary from the project CLI.",
      "    2026-03-17 17:33:39 | project: learning-context-system | scope: project"
    ].join("\n"),
    {
      query: "CLI Engram integration",
      project: "learning-context-system"
    }
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, "memory");
  assert.match(chunks[0].source, /engram:\/\/learning-context-system\/2/);
  assert.match(chunks[0].content, /Recall query: CLI Engram integration/);
  assert.equal(chunks[0].priority > 0.85, true);
});

run("teach recall query builder derives shorter concept queries", () => {
  const queries = buildTeachRecallQueries({
    task: "Integrate Engram CLI",
    objective: "Teach how durable memory feeds the packet",
    focus: "CLI Engram integration durable memory recall remember close",
    changedFiles: ["src/cli/app.js", "src/memory/engram-client.js"]
  });

  assert.ok(queries.length >= 3);
  assert.ok(queries.some((query) => /engram/u.test(query) && /cli/u.test(query)));
  assert.ok(queries.some((query) => /integration/u.test(query)));
  assert.equal(queries.some((query) => query.split(/\s+/u).length <= 4), true);
});

run("cli recall delegates to Engram search when a query is provided", async () => {
  /** @type {Array<{ kind: string, payload: unknown }>} */
  const calls = [];
  const fakeClient = {
    async recallContext(project) {
      calls.push({ kind: "context", payload: project });
      return {
        mode: "context",
        project: project ?? "",
        query: "",
        stdout: "No previous session memories found.",
        dataDir: ".engram"
      };
    },
    async searchMemories(query, options) {
      calls.push({ kind: "search", payload: { query, options } });
      return {
        mode: "search",
        project: options?.project ?? "",
        query,
        type: options?.type ?? "",
        scope: options?.scope ?? "",
        limit: options?.limit ?? null,
        stdout: "1. Auth order decision",
        dataDir: ".engram"
      };
    },
    async saveMemory() {
      throw new Error("not used");
    },
    async closeSession() {
      throw new Error("not used");
    }
  };

  const result = await runCli(
    [
      "recall",
      "--query",
      "auth middleware",
      "--project",
      "learning-context-system",
      "--type",
      "decision",
      "--scope",
      "project",
      "--limit",
      "2",
      "--format",
      "text"
    ],
    {
      engramClient: fakeClient
    }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "search");
  assert.match(result.stdout, /Recall mode: search/);
  assert.match(result.stdout, /auth middleware/);
  assert.match(result.stdout, /Auth order decision/);
});

run("cli remember saves a durable memory through Engram", async () => {
  /** @type {Array<unknown>} */
  const calls = [];
  const fakeClient = {
    async recallContext() {
      throw new Error("not used");
    },
    async searchMemories() {
      throw new Error("not used");
    },
    async saveMemory(input) {
      calls.push(input);
      return {
        title: input.title,
        project: input.project ?? "",
        type: input.type ?? "",
        scope: input.scope ?? "",
        topic: input.topic ?? "",
        stdout: "Saved observation #2",
        dataDir: ".engram"
      };
    },
    async closeSession() {
      throw new Error("not used");
    }
  };

  const result = await runCli(
    [
      "remember",
      "--title",
      "JWT order",
      "--content",
      "Validation now runs before route handlers.",
      "--project",
      "learning-context-system",
      "--type",
      "decision",
      "--topic",
      "architecture/auth-order",
      "--format",
      "text"
    ],
    {
      engramClient: fakeClient
    }
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[0], {
    title: "JWT order",
    content: "Validation now runs before route handlers.",
    type: "decision",
    project: "learning-context-system",
    scope: "project",
    topic: "architecture/auth-order"
  });
  assert.match(result.stdout, /Memory saved/);
  assert.match(result.stdout, /architecture\/auth-order/);
});

run("cli close stores a structured session-close memory", async () => {
  /** @type {Array<unknown>} */
  const calls = [];
  const fakeClient = {
    async recallContext() {
      throw new Error("not used");
    },
    async searchMemories() {
      throw new Error("not used");
    },
    async saveMemory() {
      throw new Error("not used");
    },
    async closeSession(input) {
      calls.push(input);
      return {
        title: input.title ?? "Session close - 2026-03-17",
        project: input.project ?? "",
        type: input.type ?? "",
        scope: input.scope ?? "",
        topic: "",
        stdout: "Saved observation #3",
        dataDir: ".engram"
      };
    }
  };

  const result = await runCli(
    [
      "close",
      "--summary",
      "Integrated recall and remember commands.",
      "--learned",
      "Context retrieval and durable memory must stay separate.",
      "--next",
      "Connect recall output to the teaching packet.",
      "--project",
      "learning-context-system",
      "--format",
      "text"
    ],
    {
      engramClient: fakeClient
    }
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[0], {
    summary: "Integrated recall and remember commands.",
    learned: "Context retrieval and durable memory must stay separate.",
    next: "Connect recall output to the teaching packet.",
    title: undefined,
    project: "learning-context-system",
    scope: "project",
    type: "learning"
  });
  assert.match(result.stdout, /Session close note saved/);
});

run("cli teach consumes recalled Engram memory automatically", async () => {
  const seenQueries = [];
  const fakeClient = {
    async recallContext() {
      throw new Error("not used");
    },
    async searchMemories(query, options) {
      seenQueries.push(query);
      assert.equal(options?.project, "learning-context-system");

      if (!/auth/u.test(query) || !/(middleware|validation)/u.test(query)) {
        return {
          mode: "search",
          project: options?.project ?? "",
          query,
          stdout: "No memories found for that query.",
          dataDir: ".engram"
        };
      }

      return {
        mode: "search",
        project: options?.project ?? "",
        query,
        stdout: [
          "Found 1 memories:",
          "",
          "[1] #7 (decision) — Auth validation order",
          "    Reject invalid tokens before route handlers so the failure stays at the boundary.",
          "    2026-03-17 18:05:00 | project: learning-context-system | scope: project"
        ].join("\n"),
        dataDir: ".engram"
      };
    },
    async saveMemory() {
      throw new Error("not used");
    },
    async closeSession() {
      throw new Error("not used");
    }
  };

  const result = await runCli(
    [
      "teach",
      "--input",
      "examples/auth-context.json",
      "--task",
      "Improve auth middleware",
      "--objective",
      "Teach why validation runs before route handlers",
      "--changed-files",
      "src/auth/middleware.ts,test/auth/middleware.test.ts",
      "--project",
      "learning-context-system",
      "--format",
      "json"
    ],
    {
      engramClient: fakeClient
    }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(parsed.memoryRecall.status, "recalled");
  assert.equal(parsed.memoryRecall.recoveredChunks, 1);
  assert.equal(parsed.memoryRecall.selectedChunks >= 1, true);
  assert.equal(parsed.memoryRecall.queriesTried.length >= 1, true);
  assert.equal(seenQueries.length >= 1, true);
  assert.equal(parsed.selectedContext.some((chunk) => chunk.source.startsWith("engram://")), true);
});

run("cli teach retries recall with fallback queries until a memory matches", async () => {
  const seenQueries = [];
  const fakeClient = {
    async recallContext() {
      throw new Error("not used");
    },
    async searchMemories(query, options) {
      seenQueries.push(query);

      if (!/integration/u.test(query)) {
        return {
          mode: "search",
          project: options?.project ?? "",
          query,
          stdout: "No memories found for that query.",
          dataDir: ".engram"
        };
      }

      return {
        mode: "search",
        project: options?.project ?? "",
        query,
        stdout: [
          "Found 1 memories:",
          "",
          "[1] #8 (architecture) â€” CLI Engram integration",
          "    Durable memory now enters the teach packet automatically.",
          "    2026-03-17 18:15:00 | project: learning-context-system | scope: project"
        ].join("\n"),
        dataDir: ".engram"
      };
    },
    async saveMemory() {
      throw new Error("not used");
    },
    async closeSession() {
      throw new Error("not used");
    }
  };

  const result = await runCli(
    [
      "teach",
      "--workspace",
      ".",
      "--task",
      "Integrate Engram CLI",
      "--objective",
      "Teach how durable memory feeds the packet",
      "--changed-files",
      "src/cli/app.js,src/memory/engram-client.js",
      "--project",
      "learning-context-system",
      "--format",
      "json"
    ],
    {
      engramClient: fakeClient
    }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.memoryRecall.status, "recalled");
  assert.equal(parsed.memoryRecall.matchedQueries.some((query) => /integration/u.test(query)), true);
  assert.equal(seenQueries.length >= 2, true);
  assert.equal(parsed.selectedContext.some((chunk) => chunk.source.startsWith("engram://")), true);
});

run("cli teach can disable automatic recall", async () => {
  let called = false;
  const fakeClient = {
    async recallContext() {
      throw new Error("not used");
    },
    async searchMemories() {
      called = true;
      throw new Error("not used");
    },
    async saveMemory() {
      throw new Error("not used");
    },
    async closeSession() {
      throw new Error("not used");
    }
  };

  const result = await runCli(
    [
      "teach",
      "--input",
      "examples/auth-context.json",
      "--task",
      "Improve auth middleware",
      "--objective",
      "Teach why validation runs before route handlers",
      "--no-recall",
      "--format",
      "json"
    ],
    {
      engramClient: fakeClient
    }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(called, false);
  assert.equal(parsed.memoryRecall.status, "disabled");
  assert.equal(parsed.memoryRecall.enabled, false);
});

async function main() {
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`PASS ${test.name}`);
    } catch (error) {
      console.error(`FAIL ${test.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }

  if (!process.exitCode) {
    console.log("All portable checks passed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
