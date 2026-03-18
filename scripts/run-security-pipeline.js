import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../src/cli/app.js";

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

const argv = process.argv.slice(2);
const input = option(argv, "input", "examples/prowler-findings.sample.json");
const outputDir = option(argv, "output-dir", "test-output/security-pipeline");
const statusFilter = option(argv, "status-filter", "non-pass");
const maxFindings = option(argv, "max-findings", "200");
const task = option(argv, "task", "Prioritize cloud security findings");
const objective = option(
  argv,
  "objective",
  "Teach severity-first remediation sequencing from imported findings"
);

const resolvedOutputDir = path.resolve(outputDir);
const chunksPath = path.join(resolvedOutputDir, "security-chunks.json");
const teachPath = path.join(resolvedOutputDir, "security-teach.json");

await mkdir(resolvedOutputDir, { recursive: true });

const ingestResult = await runCli([
  "ingest-security",
  "--input",
  input,
  "--status-filter",
  statusFilter,
  "--max-findings",
  maxFindings,
  "--output",
  chunksPath,
  "--format",
  "json"
]);

if (ingestResult.exitCode !== 0) {
  console.error(ingestResult.stderr || ingestResult.stdout);
  process.exitCode = ingestResult.exitCode;
} else {
  const ingest = JSON.parse(ingestResult.stdout);
  const teachResult = await runCli([
    "teach",
    "--input",
    chunksPath,
    "--task",
    task,
    "--objective",
    objective,
    "--no-recall",
    "--format",
    "json"
  ]);

  if (teachResult.exitCode !== 0) {
    console.error(teachResult.stderr || teachResult.stdout);
    process.exitCode = teachResult.exitCode;
  } else {
    await writeFile(teachPath, `${teachResult.stdout}\n`, "utf8");
    const teach = JSON.parse(teachResult.stdout);

    console.log("Pipeline completed.");
    console.log(`- findings input: ${path.resolve(input)}`);
    console.log(`- chunks output: ${chunksPath}`);
    console.log(`- teach output: ${teachPath}`);
    console.log(`- included findings: ${ingest.includedFindings}`);
    console.log(`- skipped findings: ${ingest.skippedFindings}`);
    console.log(`- selected teach chunks: ${teach.selectedContext?.length ?? 0}`);
  }
}
