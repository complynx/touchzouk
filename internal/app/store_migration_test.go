package app

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCoverPositionMigrationPreservesExistingMedia(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	database, err := sql.Open("sqlite", path)
	require.NoError(t, err)
	_, err = database.ExecContext(t.Context(), `CREATE TABLE media_items (
id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
event_name TEXT NOT NULL DEFAULT '', event_url TEXT NOT NULL DEFAULT '', played_at TEXT NOT NULL DEFAULT '',
country TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
telegram_url TEXT NOT NULL DEFAULT '', duration_seconds DOUBLE PRECISION NOT NULL, audio_path TEXT NOT NULL,
cover_path TEXT NOT NULL, waveform_path TEXT NOT NULL, created_at TIMESTAMP NOT NULL);
INSERT INTO media_items (id, kind, title, duration_seconds, audio_path, cover_path, waveform_path, created_at)
VALUES (
'legacy', 'set', 'Legacy set', 90, 'audio/legacy.ogg',
'covers/legacy.jpg', 'waveforms/legacy.json', ?
);`, time.Now().UTC())
	require.NoError(t, database.Close())
	require.NoError(t, err)

	store, err := OpenStore(context.Background(), DatabaseConfig{Driver: "sqlite", DSN: path})
	require.NoError(t, err)
	defer func() {
		require.NoError(t, store.Close())
	}()
	item, err := store.Get(context.Background(), "legacy")
	require.NoError(t, err)
	assert.Equal(t, "Legacy set", item.Title)
	assert.Equal(t, "50% 50%", item.CoverPosition)
	assert.InDelta(t, 1, item.CoverZoom, 0)
}

func TestPostgresStoreRoundTrip(t *testing.T) {
	dsn := os.Getenv("TOUCHZOUK_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("TOUCHZOUK_TEST_POSTGRES_DSN is not configured")
	}
	store, err := OpenStore(t.Context(), DatabaseConfig{Driver: databaseDriverPostgres, DSN: dsn})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	var existingRows int
	require.NoError(t, store.db.GetContext(t.Context(), &existingRows, `SELECT
(SELECT COUNT(*) FROM media_items) + (SELECT COUNT(*) FROM upload_drafts) + (SELECT COUNT(*) FROM app_settings)`))
	require.Zero(t, existingRows, "Postgres integration tests require an empty dedicated database")

	now := time.Now().UTC()
	id := "postgres-" + now.Format("20060102150405.000000000")
	otherID := id + "-other"
	t.Cleanup(func() {
		_, cleanupErr := store.db.ExecContext(
			context.Background(), store.bind(`DELETE FROM upload_drafts WHERE id IN (?, ?)`),
			id, otherID)
		require.NoError(t, cleanupErr)
		_, cleanupErr = store.db.ExecContext(
			context.Background(), store.bind(`DELETE FROM media_items WHERE id = ?`), id)
		require.NoError(t, cleanupErr)
	})
	item := MediaItem{
		ID: id, Kind: mediaKindSong, Title: "Postgres round trip", Tags: []string{"integration"},
		DurationSeconds: 42, AudioPath: "audio/test.ogg", CoverPath: "covers/test.webp",
		WaveformPath: "waveforms/test.json", CreatedAt: now,
	}
	require.NoError(t, store.Create(t.Context(), item))
	stored, err := store.Get(t.Context(), id)
	require.NoError(t, err)
	assert.Equal(t, item.Title, stored.Title)
	assert.Equal(t, item.Tags, stored.Tags)

	draft := UploadDraft{
		ID: id, Kind: "audio", Path: "uploads/test.ogg", Title: "Draft", State: "publishing",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}
	require.NoError(t, store.CreateUploadDraft(t.Context(), draft))
	draft.ID = otherID
	require.NoError(t, store.CreateUploadDraft(t.Context(), draft))
	require.NoError(t, store.ResetPublishingUploadsExcept(t.Context(), []string{id}))
	storedDraft, err := store.GetUploadDraft(t.Context(), id)
	require.NoError(t, err)
	assert.Equal(t, "publishing", storedDraft.State)
	storedDraft, err = store.GetUploadDraft(t.Context(), otherID)
	require.NoError(t, err)
	assert.Equal(t, "ready", storedDraft.State)
}
