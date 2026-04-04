package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const responseVersion = "1.0.0"

type scanRequest struct {
	Version    string   `json:"version"`
	RootPath   string   `json:"rootPath"`
	IgnoreDirs []string `json:"ignoreDirs"`
}

type scanStats struct {
	DirectoriesVisited int   `json:"directoriesVisited"`
	FilesDiscovered    int   `json:"filesDiscovered"`
	DurationMs         int64 `json:"durationMs"`
}

type scanResponse struct {
	Version string    `json:"version"`
	Files   []string  `json:"files"`
	Stats   scanStats `json:"stats"`
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "--request-stdin" {
		fmt.Fprintln(os.Stderr, "usage: lcs-fastscan --request-stdin")
		os.Exit(2)
	}

	req, err := decodeRequest(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid request: %v\n", err)
		os.Exit(1)
	}

	res, err := executeScan(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "scan failed: %v\n", err)
		os.Exit(1)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(res); err != nil {
		fmt.Fprintf(os.Stderr, "encode failed: %v\n", err)
		os.Exit(1)
	}
}

func decodeRequest(file *os.File) (scanRequest, error) {
	var req scanRequest
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return scanRequest{}, err
	}

	if strings.TrimSpace(req.RootPath) == "" {
		return scanRequest{}, errors.New("rootPath is required")
	}

	return req, nil
}

func executeScan(req scanRequest) (scanResponse, error) {
	startedAt := time.Now()
	rootPath := filepath.Clean(strings.TrimSpace(req.RootPath))

	info, err := os.Stat(rootPath)
	if err != nil {
		return scanResponse{}, err
	}
	if !info.IsDir() {
		return scanResponse{}, fmt.Errorf("rootPath must be a directory: %s", rootPath)
	}

	ignoredDirs := make(map[string]struct{}, len(req.IgnoreDirs))
	for _, dir := range req.IgnoreDirs {
		name := strings.TrimSpace(dir)
		if name == "" {
			continue
		}
		ignoredDirs[name] = struct{}{}
	}

	files := make([]string, 0, 512)
	stats := scanStats{}

	err = filepath.WalkDir(rootPath, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if currentPath == rootPath {
			return nil
		}

		if entry.IsDir() {
			if _, ignored := ignoredDirs[entry.Name()]; ignored {
				return filepath.SkipDir
			}
			stats.DirectoriesVisited++
			return nil
		}

		if !entry.Type().IsRegular() {
			return nil
		}

		stats.FilesDiscovered++
		relativePath, err := filepath.Rel(rootPath, currentPath)
		if err != nil {
			return err
		}

		normalized := filepath.ToSlash(relativePath)
		if normalized == ".." || strings.HasPrefix(normalized, "../") {
			return nil
		}

		files = append(files, normalized)
		return nil
	})
	if err != nil {
		return scanResponse{}, err
	}

	sort.Strings(files)
	stats.DurationMs = time.Since(startedAt).Milliseconds()

	return scanResponse{
		Version: responseVersion,
		Files:   files,
		Stats:   stats,
	}, nil
}
