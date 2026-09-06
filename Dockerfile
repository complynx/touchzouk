# syntax=docker/dockerfile:1
FROM golang:1.27.1-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY cmd/touchzouk ./cmd/touchzouk
RUN go test ./internal/... ./cmd/touchzouk \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/touchzouk ./cmd/touchzouk

FROM alpine:3.24

RUN apk add --no-cache ca-certificates ffmpeg \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null \
    && addgroup -S touchzouk \
    && adduser -S -D -H -G touchzouk touchzouk \
    && mkdir -p /app/site /data \
    && chown -R touchzouk:touchzouk /app /data

WORKDIR /app
COPY --from=build /out/touchzouk /usr/local/bin/touchzouk
COPY --chown=touchzouk:touchzouk site ./site
COPY --chown=touchzouk:touchzouk config.docker.yaml ./config.yaml

USER touchzouk
EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["touchzouk"]
CMD ["-config", "/app/config.yaml"]
