import test from "node:test";
import assert from "node:assert/strict";

import { buildLearningPacket } from "../src/learning/mentor-loop.js";
import { compressContent, selectContextWindow } from "../src/context/noise-canceler.js";

test("selectContextWindow prioritizes relevant code and filters noisy logs", () => {
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

test("selectContextWindow suppresses highly redundant chunks", () => {
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

test("compressContent keeps the most focus-heavy sentences", () => {
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

test("buildLearningPacket returns teaching scaffolding with selected context", () => {
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
