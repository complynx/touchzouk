# Verification And CI

- Local final gates: JavaScript `--check`; `go vet ./...`; `go test ./...`; `go build ./...`; `go mod verify`; `go mod tidy -diff`; `git diff --check`.
- CI: lint; module checks; vet; race tests; `govulncheck`; `CGO_ENABLED=0` build.
- Local `CGO_ENABLED=0` breaks `go test -race ./...`; Linux CI supports race tests.
- Lint: `golangci-lint run`. Exact format: `golangci-lint fmt`. Codex sandbox may need escalation for Go toolchain/module cache reads.
- Frontend review loop = fresh diff reviewer + independent read-only browser/visual reviewer in parallel. Set visible player volume to `0` first.
