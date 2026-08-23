package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/complynx/touchzouk/internal/app"
)

func TestRefreshSeedItemConvergesMetadataAndAssets(t *testing.T) {
	dataDir := t.TempDir()
	for _, directory := range []string{"audio", "covers", "waveforms"} {
		require.NoError(t, os.MkdirAll(filepath.Join(dataDir, directory), 0o750))
	}
	store, err := app.OpenStore(t.Context(), app.DatabaseConfig{
		Driver: "sqlite",
		DSN:    filepath.Join(dataDir, "seed-test.db"),
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })

	createdAt := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	stored := app.MediaItem{
		ID: "seed-refresh", Kind: seedKindSet, Title: "Stale title", CoverZoom: 1,
		AudioPath: "audio/old.ogg", CoverPath: "covers/old.png",
		WaveformPath: "waveforms/old.json", CreatedAt: createdAt,
	}
	require.NoError(t, store.Create(t.Context(), stored))
	for _, relative := range []string{stored.AudioPath, stored.CoverPath, stored.WaveformPath} {
		require.NoError(t, os.WriteFile(filepath.Join(dataDir, filepath.FromSlash(relative)), []byte("old"), 0o600))
	}
	audioSource := filepath.Join(t.TempDir(), "fixture.ogg")
	coverSource := filepath.Join(t.TempDir(), "fixture.webp")
	require.NoError(t, os.WriteFile(audioSource, []byte("new audio"), 0o600))
	require.NoError(t, os.WriteFile(coverSource, []byte("new cover"), 0o600))
	declared := seedItem{
		AudioSource: audioSource, CoverSource: coverSource,
		ID:              stored.ID,
		Kind:            seedKindSong,
		Title:           "Declared title",
		Subtitle:        "Declared metadata",
		Tags:            []string{"fresh"},
		DurationSeconds: 42,
		CoverZoom:       1.2,
	}
	cfg := app.Config{DataDir: dataDir, Media: app.MediaConfig{WaveformPoints: 64}}
	require.NoError(t, refreshSeedItem(store, cfg, declared, stored))

	refreshed, err := store.Get(t.Context(), stored.ID)
	require.NoError(t, err)
	assert.Equal(t, "Declared title", refreshed.Title)
	assert.Equal(t, seedKindSong, refreshed.Kind)
	assert.Equal(t, []string{"fresh"}, refreshed.Tags)
	assert.Equal(t, createdAt, refreshed.CreatedAt)
	assert.FileExists(t, filepath.Join(dataDir, "audio", stored.ID+".ogg"))
	assert.FileExists(t, filepath.Join(dataDir, "covers", stored.ID+".webp"))
	assert.NoFileExists(t, filepath.Join(dataDir, filepath.FromSlash(stored.AudioPath)))
	assert.NoFileExists(t, filepath.Join(dataDir, filepath.FromSlash(stored.CoverPath)))
	assert.NoFileExists(t, filepath.Join(dataDir, filepath.FromSlash(stored.WaveformPath)))
}
