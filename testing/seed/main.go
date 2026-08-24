package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"time"

	"github.com/complynx/touchzouk/internal/app"
)

type seedItem struct {
	app.MediaItem
	CoverSource string
	AudioSource string
}

const (
	seedKindSet     = "set"
	seedKindSong    = "song"
	seedTelegramURL = "https://t.me/touchzouk"
)

func main() {
	if err := run(); err != nil {
		fatal(err)
	}
}

func run() (returnErr error) {
	configPath := flag.String("config", "config.yaml", "path to YAML configuration")
	assetsPath := flag.String("assets", "testing/audio", "path to test audio fixtures")
	flag.Parse()
	cfg, err := app.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	for _, directory := range []string{"audio", "covers", "waveforms"} {
		if mkdirErr := os.MkdirAll(filepath.Join(cfg.DataDir, directory), 0o750); mkdirErr != nil {
			return mkdirErr
		}
	}
	store, err := app.OpenStore(context.Background(), cfg.Database)
	if err != nil {
		return err
	}
	defer func() {
		returnErr = errors.Join(returnErr, store.Close())
	}()

	for _, item := range catalog(cfg.SiteDir, *assetsPath) {
		if seedErr := seedCatalogItem(store, cfg, item); seedErr != nil {
			return seedErr
		}
	}
	return nil
}

func seedCatalogItem(store *app.Store, cfg app.Config, item seedItem) error {
	stored, err := store.Get(context.Background(), item.ID)
	if err == nil {
		return refreshSeedItem(store, cfg, item, stored)
	}
	if !errors.Is(err, app.ErrNotFound) {
		return err
	}
	return createSeedItem(store, cfg, item)
}

func refreshSeedItem(store *app.Store, cfg app.Config, item seedItem, stored app.MediaItem) error {
	audioRelative := filepath.ToSlash(filepath.Join("audio", item.ID+".ogg"))
	audioPath := filepath.Join(cfg.DataDir, filepath.FromSlash(audioRelative))
	if err := copyFile(item.AudioSource, audioPath); err != nil {
		return err
	}
	coverRelative := filepath.ToSlash(filepath.Join("covers", item.ID+filepath.Ext(item.CoverSource)))
	coverPath := filepath.Join(cfg.DataDir, filepath.FromSlash(coverRelative))
	if err := copyFile(item.CoverSource, coverPath); err != nil {
		return err
	}
	waveformRelative := filepath.ToSlash(filepath.Join("waveforms", item.ID+".json"))
	waveformPath := filepath.Join(cfg.DataDir, filepath.FromSlash(waveformRelative))
	if err := seedWaveform(waveformPath, item.DurationSeconds, cfg.Media.WaveformPoints, len(item.ID)); err != nil {
		return err
	}
	item.AudioPath = audioRelative
	item.CoverPath = coverRelative
	item.WaveformPath = waveformRelative
	item.CreatedAt = stored.CreatedAt
	if err := store.Update(context.Background(), item.MediaItem); err != nil {
		return err
	}
	for _, paths := range [][2]string{
		{stored.AudioPath, audioRelative},
		{stored.CoverPath, coverRelative},
		{stored.WaveformPath, waveformRelative},
	} {
		previous, current := paths[0], paths[1]
		if previous != "" && previous != current {
			_ = os.Remove(filepath.Join(cfg.DataDir, filepath.FromSlash(previous)))
		}
	}
	fmt.Printf("refreshed %s\n", item.Title)
	return nil
}

func createSeedItem(store *app.Store, cfg app.Config, item seedItem) error {
	audioRelative := filepath.ToSlash(filepath.Join("audio", item.ID+".ogg"))
	coverRelative := filepath.ToSlash(filepath.Join("covers", item.ID+filepath.Ext(item.CoverSource)))
	waveformRelative := filepath.ToSlash(filepath.Join("waveforms", item.ID+".json"))
	if err := copyFile(item.AudioSource, filepath.Join(cfg.DataDir, filepath.FromSlash(audioRelative))); err != nil {
		return err
	}
	if err := copyFile(item.CoverSource, filepath.Join(cfg.DataDir, filepath.FromSlash(coverRelative))); err != nil {
		return err
	}
	waveformPath := filepath.Join(cfg.DataDir, filepath.FromSlash(waveformRelative))
	if err := seedWaveform(waveformPath, item.DurationSeconds, cfg.Media.WaveformPoints, len(item.ID)); err != nil {
		return err
	}
	item.AudioPath, item.CoverPath, item.WaveformPath = audioRelative, coverRelative, waveformRelative
	if err := store.Create(context.Background(), item.MediaItem); err != nil {
		return err
	}
	fmt.Printf("created %s\n", item.Title)
	return nil
}

//nolint:funlen // The declarative seed catalog is clearer as one ordered fixture.
func catalog(siteDir, assetsDir string) []seedItem {
	cover := func(name string) string { return filepath.Join(siteDir, "static", name) }
	audio := func(name string) string { return filepath.Join(assetsDir, name) }
	base := time.Date(2026, 8, 20, 20, 0, 0, 0, time.UTC)
	chill := audio("cc0-chill-beat.ogg")
	duration := 96.180612
	return []seedItem{
		{
			MediaItem: app.MediaItem{
				ID: "seed-set-crystal", Kind: seedKindSet, Title: "Crystal Fortress",
				Subtitle: "A celestial closing journey", EventName: "Castle of Miracles",
				EventURL: "https://example.com/castle-of-miracles", PlayedAt: "18 Jul 2026 · 02:30",
				LocationURL: "https://www.google.com/maps/search/?api=1&query=50.0647%2C19.9450",
				Country:     "Poland", City: "Kraków", Tags: []string{"melodic", "cosmic", "closing"},
				TelegramURL: seedTelegramURL, DurationSeconds: duration, CreatedAt: base,
			},
			CoverSource: cover("celestial-dancefloor-baked.webp"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-set-tidal", Kind: seedKindSet, Title: "Tidal Memory",
				Subtitle: "Deep currents and unhurried connection", EventName: "Zouk Sea",
				EventURL: "https://example.com/zouk-sea", PlayedAt: "Jun 2026",
				LocationURL: "https://www.google.com/maps/search/?api=1&query=45.0812%2C13.6387",
				Country:     "Croatia", City: "Rovinj", Tags: []string{"deep", "organic", "sunrise"},
				TelegramURL: seedTelegramURL, DurationSeconds: duration,
				CreatedAt: base.Add(-24 * time.Hour),
			},
			CoverSource: cover("event-destinations-baked.webp"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-set-velvet", Kind: seedKindSet, Title: "Velvet Orbit",
				Subtitle: "Late-night NeoZouk transmissions", PlayedAt: "Spring 2026 · after midnight",
				Country: "Netherlands", City: "Amsterdam", Tags: []string{"neozouk", "late night"},
				DurationSeconds: duration, CreatedAt: base.Add(-48 * time.Hour),
			},
			CoverSource: cover("daniel-live-recolored-baked.png"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-set-golden", Kind: seedKindSet, Title: "The Golden Hour",
				EventName: "Local Zouk Sessions", PlayedAt: "2025", Country: "Netherlands",
				Tags: []string{"warm", "flow", "classics"}, TelegramURL: seedTelegramURL,
				DurationSeconds: duration, CreatedAt: base.Add(-72 * time.Hour),
			},
			CoverSource: cover("daniel-celestial-baked.jpg"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-song-moon", Kind: seedKindSong, Title: "Moonlit Conversations",
				Subtitle: "Touchzouk edit", PlayedAt: "2026", Tags: []string{"downtempo", "edit"},
				TelegramURL: seedTelegramURL, DurationSeconds: duration,
				CreatedAt: base.Add(-2 * time.Hour),
			},
			CoverSource: cover("celestial-hero-baked.webp"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-song-pulse", Kind: seedKindSong, Title: "Pulse Between Stars",
				Subtitle: "An after-hours favorite", PlayedAt: "18 Jul 2026 · 03:44",
				Tags: []string{"melodic", "vocal", "zouk"}, DurationSeconds: duration,
				CreatedAt: base.Add(-26 * time.Hour),
			},
			CoverSource: cover("celestial-dancefloor-baked.webp"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-song-signal", Kind: seedKindSong, Title: "Signal Bloom",
				Tags: []string{"organic", "instrumental"}, TelegramURL: seedTelegramURL,
				DurationSeconds: duration, CreatedAt: base.Add(-50 * time.Hour),
			},
			CoverSource: cover("event-destinations-baked.webp"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-song-home", Kind: seedKindSong, Title: "A Way Home", Subtitle: "Closing song",
				PlayedAt: "Summer 2025", Tags: []string{"closing", "emotional"},
				DurationSeconds: duration, CreatedAt: base.Add(-74 * time.Hour),
			},
			CoverSource: cover("daniel-celestial-baked.jpg"), AudioSource: chill,
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-song-elise", Kind: seedKindSong, Title: "Für Elise",
				Subtitle: "CC0 piano test fixture", PlayedAt: "18 Jul 2006",
				Tags: []string{"classical", "piano"}, DurationSeconds: 176.586757,
				CreatedAt: base.Add(-98 * time.Hour),
			},
			CoverSource: cover("celestial-hero-baked.webp"),
			AudioSource: audio("cc0-fur-elise.ogg"),
		},
		{
			MediaItem: app.MediaItem{
				ID: "seed-song-rags", Kind: seedKindSong, Title: "Original Rags",
				Subtitle: "Public-domain ragtime fixture", PlayedAt: "1899",
				Tags: []string{"ragtime", "piano"}, DurationSeconds: 237.244082,
				CreatedAt: base.Add(-122 * time.Hour),
			},
			CoverSource: cover("event-destinations-baked.webp"),
			AudioSource: audio("public-domain-original-rags.ogg"),
		},
	}
}

func copyFile(source, destination string) (returnErr error) {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() {
		returnErr = errors.Join(returnErr, input.Close())
	}()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func seedWaveform(path string, duration float64, count, phase int) error {
	points := make([]float64, count)
	for index := range points {
		wave := math.Abs(math.Sin(float64(index+phase)*0.19) * math.Cos(float64(index+phase)*0.047))
		points[index] = math.Round((.12+wave*.88)*1000) / 1000
	}
	contents, err := json.Marshal(struct {
		DurationSeconds float64   `json:"duration_seconds"`
		Points          []float64 `json:"points"`
	}{duration, points})
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(contents, '\n'), 0o600)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
