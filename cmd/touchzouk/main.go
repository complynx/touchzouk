package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/complynx/touchzouk/internal/app"
)

func main() {
	os.Exit(run())
}

func run() int {
	configPath := flag.String("config", "config.yaml", "path to YAML configuration")
	flag.Parse()

	cfg, err := app.LoadConfig(*configPath)
	if err != nil {
		slog.Error("load config", "error", err)
		return 1
	}

	initCtx, cancelInit := context.WithTimeout(context.Background(), 60*time.Second)
	service, err := app.New(initCtx, cfg)
	cancelInit()
	if err != nil {
		slog.Error("initialize service", "error", err)
		return 1
	}
	server := &http.Server{
		Addr:              cfg.Server.Address,
		Handler:           service.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       65 * time.Minute,
		IdleTimeout:       90 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveError := make(chan error, 1)
	go func() {
		serveError <- server.ListenAndServe()
	}()

	slog.Info(
		"touchzouk listening",
		"address", cfg.Server.Address,
		"auth_mode", cfg.Auth.Mode,
		"database", cfg.Database.Driver,
	)
	select {
	case serveErr := <-serveError:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			slog.Error("serve", "error", serveErr)
			_ = service.Close()
			return 1
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		shutdownErr := server.Shutdown(shutdownCtx)
		if shutdownErr != nil {
			slog.Warn("shutdown", "error", shutdownErr)
			if closeErr := server.Close(); closeErr != nil {
				slog.Warn("force close server", "error", closeErr)
			}
		}
		cancel()
		<-serveError
	}
	if closeErr := service.Close(); closeErr != nil {
		slog.Error("close service", "error", closeErr)
	}
	return 0
}
