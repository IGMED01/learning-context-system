export type ChunkKind = "code" | "test" | "spec" | "memory" | "doc" | "chat" | "log";

export interface Chunk {
  id: string;
  source: string;
  kind: ChunkKind;
  content: string;
  certainty?: number;
  recency?: number;
  teachingValue?: number;
  priority?: number;
}

export interface ChunkFile {
  chunks: Chunk[];
}

export interface ScanStats {
  rootPath: string;
  discoveredFiles: number;
  includedFiles: number;
  ignoredFiles: number;
  truncatedFiles: number;
  redactedFiles: number;
  redactionCount: number;
  kinds: Record<ChunkKind, number>;
}

export interface RuntimeMeta {
  generatedAt: string;
  cwd: string;
  durationMs: number;
  debug: boolean;
  scanStats: ScanStats | null;
}

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorSummary {
  pass: number;
  warn: number;
  fail: number;
}

export interface DoctorResult {
  cwd: string;
  summary: DoctorSummary;
  checks: DoctorCheck[];
}

export interface CliContractMeta {
  schemaVersion?: string;
  status?: "ok" | "error";
  degraded?: boolean;
  warnings?: string[];
  configPath?: string;
  configFound?: boolean;
  generatedAt?: string;
  cwd?: string;
  durationMs?: number;
  debug?: boolean;
  scanStats?: ScanStats | null;
}
