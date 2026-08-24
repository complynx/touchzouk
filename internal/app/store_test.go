package app

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMediaRecordRoundTrip(t *testing.T) {
	store := testApp(t).store
	now := time.Now().UTC().Truncate(time.Second)
	item := MediaItem{
		ID: "media-record", Kind: mediaKindSet, Title: "Record", Subtitle: "All fields",
		EventName: "Event", EventURL: "https://example.com/event",
		LocationURL: "https://maps.google.com/place", PlayedAt: "2026-08-22 22:00",
		Country: "Netherlands", City: "Amsterdam", Tags: []string{"one", "two"},
		TelegramURL: "https://t.me/touchzouk/1", DurationSeconds: 123.5,
		AudioPath: "audio/record.ogg", CoverPath: "covers/record.webp", CoverPosition: "40% 60%",
		CoverZoom: 1.4, WaveformPath: "waveforms/record.json", CreatedAt: now,
	}
	require.NoError(t, store.Create(t.Context(), item))
	stored, err := store.Get(t.Context(), item.ID)
	require.NoError(t, err)
	assert.Equal(t, item, stored)

	item.Title = "Updated record"
	item.Tags = []string{"updated"}
	require.NoError(t, store.Update(t.Context(), item))
	items, err := store.List(t.Context(), mediaKindSet)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, item, items[0])
}

func TestPublishingClaimRollsBackUnlessEveryDraftIsReady(t *testing.T) {
	store := testApp(t).store
	now := time.Now().UTC()
	createUploadDraft(t, store, "ready", "ready", now)

	claimed, err := store.ClaimUploadsForPublishing(t.Context(), "ready", "missing", now)
	require.NoError(t, err)
	assert.False(t, claimed)
	assert.Equal(t, "ready", uploadDraftState(t, store, "ready"))
}

func TestPublishingClaimAndReleaseAreBatched(t *testing.T) {
	store := testApp(t).store
	now := time.Now().UTC()
	for _, id := range []string{"audio", "cover"} {
		createUploadDraft(t, store, id, "ready", now)
	}

	claimed, err := store.ClaimUploadsForPublishing(t.Context(), "audio", "cover", now)
	require.NoError(t, err)
	require.True(t, claimed)
	assert.Equal(t, "publishing", uploadDraftState(t, store, "audio"))
	assert.Equal(t, "publishing", uploadDraftState(t, store, "cover"))

	require.NoError(t, store.ReleasePublishingUploads(t.Context(), "audio", "cover"))
	assert.Equal(t, "ready", uploadDraftState(t, store, "audio"))
	assert.Equal(t, "ready", uploadDraftState(t, store, "cover"))
	require.NoError(t, store.ReleasePublishingUploads(t.Context()))
}

func TestCreatePublishedPrependsMediaOrder(t *testing.T) {
	for _, kind := range []string{mediaKindSet, mediaKindSong} {
		t.Run(kind, func(t *testing.T) {
			application := testApp(t)
			old := MediaItem{
				ID: "old", Kind: kind, Title: "Old", PlayedAt: "2026-08-22",
				CoverZoom: 1, CreatedAt: time.Now().Add(-time.Hour),
			}
			recentUpload := MediaItem{
				ID: "recent-upload", Kind: kind, Title: "Recent upload", PlayedAt: "2020-01-01",
				CoverZoom: 1, CreatedAt: time.Now(),
			}
			require.NoError(t, application.store.Create(t.Context(), old))
			require.NoError(t, application.store.SetSetting(t.Context(), mediaOrderSettingKey(kind), `["old"]`))
			require.NoError(t, application.store.CreatePublished(t.Context(), recentUpload))
			require.ErrorIs(
				t, application.store.ReplaceMediaOrder(t.Context(), kind, []string{"old"}), ErrCatalogChanged,
			)

			order, err := application.store.GetSetting(t.Context(), mediaOrderSettingKey(kind), "missing")
			require.NoError(t, err)
			assert.JSONEq(t, `["recent-upload","old"]`, order)
			items, err := application.store.List(t.Context(), kind)
			require.NoError(t, err)
			application.sortCatalog(t.Context(), kind, items)
			require.Len(t, items, 2)
			assert.Equal(t, recentUpload.ID, items[0].ID)
		})
	}
}

func TestMediaKindTransitionReconcilesOwnedSettings(t *testing.T) {
	store := testApp(t).store
	now := time.Now().UTC()
	set := MediaItem{ID: "featured", Kind: mediaKindSet, Title: "Featured", CoverZoom: 1, CreatedAt: now}
	require.NoError(t, store.Create(t.Context(), set))
	require.NoError(t, store.SetSetting(t.Context(), "featured_set_id", set.ID))
	require.NoError(t, store.SetSetting(t.Context(), "set_order", `["other","featured"]`))
	set.Kind = mediaKindSong
	require.NoError(t, store.Update(t.Context(), set))
	featured, err := store.GetSetting(t.Context(), "featured_set_id", "missing")
	require.NoError(t, err)
	assert.Empty(t, featured)
	setOrder, err := store.GetSetting(t.Context(), "set_order", "missing")
	require.NoError(t, err)
	assert.JSONEq(t, `["other"]`, setOrder)

	song := MediaItem{ID: "ordered", Kind: mediaKindSong, Title: "Ordered", CoverZoom: 1, CreatedAt: now}
	require.NoError(t, store.Create(t.Context(), song))
	require.NoError(t, store.SetSetting(t.Context(), "song_order", `["other","ordered"]`))
	song.Kind = mediaKindSet
	require.NoError(t, store.Update(t.Context(), song))
	order, err := store.GetSetting(t.Context(), "song_order", "missing")
	require.NoError(t, err)
	assert.JSONEq(t, `["other"]`, order)
}

func createUploadDraft(t *testing.T, store *Store, id, state string, now time.Time) {
	t.Helper()
	require.NoError(t, store.CreateUploadDraft(t.Context(), UploadDraft{
		ID: id, Kind: "audio", Path: "uploads/" + id + ".ogg", State: state,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
}

func uploadDraftState(t *testing.T, store *Store, id string) string {
	t.Helper()
	draft, err := store.GetUploadDraft(t.Context(), id)
	require.NoError(t, err)
	return draft.State
}
