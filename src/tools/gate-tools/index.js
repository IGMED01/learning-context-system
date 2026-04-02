// @ts-check

import { buildTool } from "./build.js";
import { lintTool } from "./lint.js";
import { testTool } from "./test.js";
import { typecheckTool } from "./typecheck.js";

/** @typedef {import("../../types/core-contracts.d.ts").CodeGateToolResult["tool"]} CodeGateToolName */

export { buildTool, lintTool, testTool, typecheckTool };

export const allGateTools = [typecheckTool, lintTool, buildTool, testTool];

const gateToolIndex = new Map(allGateTools.map((tool) => [tool.name, tool]));

/**
 * @param {CodeGateToolName[]} toolNames
 */
export function resolveGateTools(toolNames) {
  return toolNames.map((name) => gateToolIndex.get(name)).filter(Boolean);
}
