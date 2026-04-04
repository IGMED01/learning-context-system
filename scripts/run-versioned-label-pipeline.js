#!/usr/bin/env node
// @ts-check

import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

/**
 * @param {string[]} argv
 * @param {string} key
 * @param {string} fallback
 */
function option(argv, key, fallback) {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) {
    return fallback;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    return fallback;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * @param {string} text
 */
function normalizeTag(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param {string} version
 */
function bumpPatch(version) {
  const [major, minor, patch] = version.split(".").map((entry) => Number.parseInt(entry, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return "1.0.0";
  }

  return `${major}.${minor}.${patch + 1}`;
}

/**
 * @param {string} sourceDir
 */
async function detectNextVersion(sourceDir) {
  try {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    const versions = entries
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        left.localeCompare(right, undefined, {
          numeric: true,
          sensitivity: "base"
        })
      );

    if (!versions.length) {
      return "1.0.0";
    }

    return bumpPatch(versions[versions.length - 1]);
  } catch {
    return "1.0.0";
  }
}

const argv = process.argv.slice(2);
const inputPath = path.resolve(option(argv, "input", "benchmark/ft-readiness-dataset.json"));
const datasetName = normalizeTag(option(argv, "name", "lcs-ft"));
const outputRoot = path.resolve(option(argv, "output-dir", "benchmark/labels"));
const explicitVersion = option(argv, "version", "");
const generatedAt = new Date().toISOString();

if (!datasetName) {
  throw new Error("Option --name must include at least one alphanumeric character.");
}

const raw = await readFile(inputPath, "utf8");
const payload = JSON.parse(raw.replace(/^\uFEFF/u, ""));
assertObject(payload, "label pipeline payload");
const record = /** @type {Record<string, unknown>} */ (payload);
const samples = Array.isArray(record.samples)
  ? record.samples.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
  : [];

if (!samples.length) {
  throw new Error("Input dataset must include a non-empty samples array.");
}

const dataSha = createHash("sha256").update(raw).digest("hex");
const datasetDir = path.join(outputRoot, datasetName);
const version = explicitVersion && /^\d+\.\d+\.\d+$/u.test(explicitVersion)
  ? explicitVersion
  : await detectNextVersion(datasetDir);
const versionDir = path.join(datasetDir, version);
await mkdir(versionDir, { recursive: true });

const labels = samples.map((sample, index) => {
  const entry = /** @type {Record<string, unknown>} */ (sample);
  const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `sample-${index + 1}`;
  const intent = normalizeTag(typeof entry.intent === "string" ? entry.intent : "unknown");
  const risk = normalizeTag(typeof entry.risk === "string" ? entry.risk : "unknown");
  const input = assertString(entry.input, `samples[${index}].input`);
  const output = assertString(entry.output, `samples[${index}].output`);
  return {
    id,
    input,
    output,
    labels: {
      intent: intent || "unknown",
      risk: risk || "unknown"
    },
    metadata: {
      source: path.relative(process.cwd(), inputPath).replaceAll("\\", "/"),
      generatedAt
    }
  };
});

const labelsJsonl = `${labels.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const labelsPath = path.join(versionDir, "labels.jsonl");
await writeFile(labelsPath, labelsJsonl, "utf8");

const manifest = {
  schemaVersion: "1.0",
  dataset: datasetName,
  version,
  generatedAt,
  source: path.relative(process.cwd(), inputPath).replaceAll("\\", "/"),
  sourceSha256: dataSha,
  sampleCount: labels.length,
  files: {
    labels: "labels.jsonl"
  }
};
const manifestPath = path.join(versionDir, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const report = {
  status: "ok",
  dataset: datasetName,
  version,
  source: manifest.source,
  sourceSha256: dataSha,
  output: {
    labels: path.relative(process.cwd(), labelsPath).replaceAll("\\", "/"),
    manifest: path.relative(process.cwd(), manifestPath).replaceAll("\\", "/")
  },
  sampleCount: labels.length
};

console.log(JSON.stringify(report, null, 2));
