# LCS FastScan sidecar (Go)

FastScan is an **optional** filesystem discovery sidecar for workspace scans.

- Input: JSON request via `stdin`
- Output: JSON response via `stdout`
- Purpose: quickly list candidate files; JS layer still applies security/redaction filters.

## Build

```bash
cd tools/fastscan
go build -o lcs-fastscan .
```

On Windows, build `lcs-fastscan.exe` and point config to that path.

## Contract

Request:

```json
{
  "version": "1.0.0",
  "rootPath": "C:/repo",
  "ignoreDirs": [".git", "node_modules", ".engram"]
}
```

Response:

```json
{
  "version": "1.0.0",
  "files": ["src/cli.js", "package.json"],
  "stats": {
    "directoriesVisited": 10,
    "filesDiscovered": 42,
    "durationMs": 8
  }
}
```

## Runtime integration

`learning-context.config.json`:

```json
{
  "scan": {
    "fastScanner": {
      "enabled": true,
      "binaryPath": "tools/fastscan/lcs-fastscan",
      "arguments": [],
      "timeoutMs": 8000
    }
  }
}
```

If FastScan fails (missing binary, timeout, invalid output), LCS automatically falls back to native Node scanning.
