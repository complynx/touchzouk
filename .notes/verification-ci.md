# Verification And CI

- Final gates: JavaScript `--check`; `go vet ./...`; `go test ./...`; `go build ./...`; `go mod tidy -diff`; `git diff --check`.
- `.github/workflows/build.yml` calls reusable `.github/workflows/ci.yml` before Docker build/push and repo dispatch. CI failure skips deployment.
- GolangCI-Lint `2.13.1`; `lll` limit `120`. Tabs use expanded width. Wrap long Go calls before push.
- Diagnose remote failure from actual GitHub Actions annotations.
- Local `CGO_ENABLED=0` breaks `go test -race ./...`; Linux CI supports race tests.
- Repo uses `* text=auto eol=lf` and local `core.autocrlf=false`. CRLF conversion can create whole-file `go mod tidy -diff` noise.
