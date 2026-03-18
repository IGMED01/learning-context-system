export type CliOptions = Record<string, string>;

interface ParsedOption {
  key: string;
  value: string;
  nextIndex: number;
}

export interface ParsedArgv {
  command: string;
  options: CliOptions;
}

function readValue(argv: string[], index: number, token: string): ParsedOption | null {
  if (token === "-h") {
    return {
      key: "help",
      value: "true",
      nextIndex: index
    };
  }

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

export function parseArgv(argv: string[]): ParsedArgv {
  const [command, ...rest] = argv;
  const options: CliOptions = {};

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

export function requireOption(options: CliOptions, key: string): string {
  const value = options[key];

  if (!value || value === "true") {
    throw new Error(`Missing required option --${key}.`);
  }

  return value;
}

export function numberOption(options: CliOptions, key: string, fallback: number): number {
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

export interface NumberRules {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function assertNumberRules(value: number, key: string, rules: NumberRules = {}): number {
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

export function listOption(options: CliOptions, key: string, fallback: string[] = []): string[] {
  const value = options[key];

  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
