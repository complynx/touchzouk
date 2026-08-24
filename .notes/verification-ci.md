# Verification And CI

- Final gates: JavaScript `--check`; `go vet ./...`; `go test ./...`; `go build ./...`; `go mod tidy -diff`; `git diff --check`.
- Local `CGO_ENABLED=0` breaks `go test -race ./...`; Linux CI supports race tests.
