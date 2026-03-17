// @ts-check

/**
 * @typedef {Record<string, string>} CliOptions
 */

/**
 * @typedef {{
 *   key: string,
 *   value: string,
 *   nextIndex: number
 * }} ParsedOption
 */

/**
 * @typedef {{
 *   command: string,
 *   options: CliOptions
 * }} ParsedArgv
 */

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} token
 * @returns {ParsedOption | null}
 */
function readValue(argv, index, token) {
  const inline = token.match(/^--([^=]+)=(.*)$/);

  if (inline) {
    return {
      key: inline[1],
      value: inline[2],
      nextIndex: index
    };
  }

  if (!token.startsWith("--")) {
    return null;
  }

  const key = token.slice(2);
  const maybeValue = argv[index + 1];

  if (!maybeValue || maybeValue.startsWith("--")) {
    return {
      key,
      value: "true",
      nextIndex: index
    };
  }

  return {
    key,
    value: maybeValue,
    nextIndex: index + 1
  };
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgv}
 */
export function parseArgv(argv) {
  const [command, ...rest] = argv;
  /** @type {Record<string, string>} */
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const parsed = readValue(rest, index, token);

    if (!parsed) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    options[parsed.key] = parsed.value;
    index = parsed.nextIndex;
  }

  return {
    command: command ?? "",
    options
  };
}

/**
 * @param {CliOptions} options
 * @param {string} key
 */
export function requireOption(options, key) {
  const value = options[key];

  if (!value || value === "true") {
    throw new Error(`Missing required option --${key}.`);
  }

  return value;
}

/**
 * @param {CliOptions} options
 * @param {string} key
 * @param {number} fallback
 */
export function numberOption(options, key, fallback) {
  const value = options[key];

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`Option --${key} must be a number.`);
  }

  return parsed;
}

/**
 * @param {number} value
 * @param {string} key
 * @param {{ min?: number, max?: number, integer?: boolean }} rules
 */
export function assertNumberRules(value, key, rules = {}) {
  if (rules.integer && !Number.isInteger(value)) {
    throw new Error(`Option --${key} must be an integer.`);
  }

  if (rules.min !== undefined && value < rules.min) {
    throw new Error(`Option --${key} must be >= ${rules.min}.`);
  }

  if (rules.max !== undefined && value > rules.max) {
    throw new Error(`Option --${key} must be <= ${rules.max}.`);
  }

  return value;
}

/**
 * @param {CliOptions} options
 * @param {string} key
 * @param {string[]} fallback
 */
export function listOption(options, key, fallback = []) {
  const value = options[key];

  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
