package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/complynx/touchzouk/internal/app"
)

func TestCatalogLyricsFixturesCoverBothTimingModesAndCollapsedSections(t *testing.T) {
	items := catalog("site", "assets")
	find := func(id string) app.TimedContent {
		for _, item := range items {
			if item.ID == id {
				return item.TimedContent
			}
		}
		t.Fatalf("missing seed item %s", id)
		return app.TimedContent{}
	}
	check := func(content app.TimedContent, karaoke bool, minimumCollapsed int) {
		runes := []rune(content.Text)
		collapsed := 0
		interiorCollapsed := 0
		for index, marker := range content.Markers {
			assert.LessOrEqual(t, marker.Offset, len(runes))
			if index > 0 {
				assert.GreaterOrEqual(t, marker.TimeMS, content.Markers[index-1].TimeMS)
				if marker.TimeMS == content.Markers[index-1].TimeMS && marker.Offset > content.Markers[index-1].Offset {
					collapsed++
					if content.Markers[index-1].Offset > 0 && marker.Offset < len(runes) {
						interiorCollapsed++
					}
				}
			}
		}
		assert.GreaterOrEqual(t, collapsed, minimumCollapsed)
		assert.GreaterOrEqual(t, interiorCollapsed, 1)
		start := 0
		for _, line := range strings.Split(content.Text, "\n") {
			end := start + len([]rune(line))
			if !strings.HasPrefix(line, "[") {
				markers := 0
				for _, marker := range content.Markers {
					if marker.Offset >= start && marker.Offset <= end && marker.Offset < len(runes) {
						markers++
					}
				}
				if karaoke {
					assert.Greater(t, markers, 1, line)
				} else {
					assert.Equal(t, 1, markers, line)
				}
			}
			start = end + 1
		}
	}

	pulse := find("seed-song-pulse")
	check(pulse, true, 2)
	pulseRunes := []rune(pulse.Text)
	hasInsideWordPause := false
	for _, offset := range pulse.Pauses {
		if offset > 0 && offset < len(pulseRunes) && !unicode.IsSpace(pulseRunes[offset-1]) && !unicode.IsSpace(pulseRunes[offset]) {
			hasInsideWordPause = true
		}
	}
	assert.True(t, hasInsideWordPause)
	check(find("seed-song-moon"), false, 3)
}

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
