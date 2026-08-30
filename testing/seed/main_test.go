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
	pulse := seedTimedContent(t, items, "seed-song-pulse")
	assertLyricsFixture(t, pulse, true, 2)
	assertPauseInsideWord(t, pulse)
	assertLyricsFixture(t, seedTimedContent(t, items, "seed-song-moon"), false, 3)
}

func seedTimedContent(t *testing.T, items []seedItem, id string) app.TimedContent {
	t.Helper()
	for _, item := range items {
		if item.ID == id {
			return item.TimedContent
		}
	}
	t.Fatalf("missing seed item %s", id)
	return app.TimedContent{}
}

func assertLyricsFixture(t *testing.T, content app.TimedContent, karaoke bool, minimumCollapsed int) {
	t.Helper()
	runes := []rune(content.Text)
	assertLyricsMarkerOrder(t, content.Markers, len(runes), minimumCollapsed)
	assertLyricsTimingMode(t, content, runes, karaoke)
}

func assertLyricsMarkerOrder(t *testing.T, markers []app.TextMarker, lyricLength, minimumCollapsed int) {
	t.Helper()
	collapsed := 0
	interiorCollapsed := 0
	for index, marker := range markers {
		assert.LessOrEqual(t, marker.Offset, lyricLength)
		if index == 0 {
			continue
		}
		previous := markers[index-1]
		assert.GreaterOrEqual(t, marker.TimeMS, previous.TimeMS)
		if marker.TimeMS != previous.TimeMS || marker.Offset <= previous.Offset {
			continue
		}
		collapsed++
		if previous.Offset > 0 && marker.Offset < lyricLength {
			interiorCollapsed++
		}
	}
	assert.GreaterOrEqual(t, collapsed, minimumCollapsed)
	assert.GreaterOrEqual(t, interiorCollapsed, 1)
}

func assertLyricsTimingMode(t *testing.T, content app.TimedContent, runes []rune, karaoke bool) {
	t.Helper()
	start := 0
	for line := range strings.SplitSeq(content.Text, "\n") {
		end := start + len([]rune(line))
		if !strings.HasPrefix(line, "[") {
			markerCount := countLyricsMarkers(content.Markers, start, end, len(runes))
			if karaoke {
				assert.Greater(t, markerCount, 1, line)
			} else {
				assert.Equal(t, 1, markerCount, line)
			}
		}
		start = end + 1
	}
}

func countLyricsMarkers(markers []app.TextMarker, start, end, lyricLength int) int {
	count := 0
	for _, marker := range markers {
		if marker.Offset >= start && marker.Offset <= end && marker.Offset < lyricLength {
			count++
		}
	}
	return count
}

func assertPauseInsideWord(t *testing.T, content app.TimedContent) {
	t.Helper()
	runes := []rune(content.Text)
	for _, offset := range content.Pauses {
		insideText := offset > 0 && offset < len(runes)
		if insideText && !unicode.IsSpace(runes[offset-1]) && !unicode.IsSpace(runes[offset]) {
			return
		}
	}
	assert.Fail(t, "expected an inside-word pause")
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
