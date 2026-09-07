package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPublicationAccess(t *testing.T) {
	application := testApp(t)
	session := httptest.NewRecorder()
	require.NoError(t, application.auth.setSession(session, AdminIdentity{
		Subject: "admin", Expires: time.Now().Add(time.Hour).Unix(),
	}))
	cookie := session.Result().Cookies()[0]
	get := func(path string, admin bool) *httptest.ResponseRecorder {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
		if admin {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		application.Handler().ServeHTTP(w, r)
		return w
	}
	for _, kind := range []string{mediaKindSet, mediaKindSong} {
		t.Run(kind, func(t *testing.T) {
			item := MediaItem{
				ID: kind, Kind: kind, Title: "Publication test", CreatedAt: time.Now().UTC(),
				AudioPath: "audio/" + kind + ".ogg", CoverPath: "covers/" + kind + ".jpg",
				WaveformPath: "waveforms/" + kind + ".json",
			}
			for _, path := range []string{item.AudioPath, item.CoverPath, item.WaveformPath} {
				require.NoError(t, os.WriteFile(filepath.Join(application.cfg.DataDir, path), []byte("test"), 0o600))
			}
			require.NoError(t, application.store.CreatePublished(t.Context(), item))
			if kind == mediaKindSet {
				require.NoError(t, application.store.SetSetting(t.Context(), "featured_set_id", item.ID))
			}
			future, past := time.Now().UTC().Add(time.Hour), time.Now().UTC().Add(-time.Hour)
			for _, state := range []struct {
				name   string
				hidden bool
				at     *time.Time
				public bool
			}{
				{"public", false, nil, true},
				{"hidden", true, nil, false},
				{"scheduled", false, &future, false},
				{"due", false, &past, true},
				{"hidden overrides due", true, &past, false},
				{"reopened", false, nil, true},
			} {
				t.Run(state.name, func(t *testing.T) {
					item.Hidden, item.PublishAt = state.hidden, state.at
					require.NoError(t, application.store.Update(t.Context(), item))
					assertPublicationAccess(t, application, item, state.public, get)
				})
			}
		})
	}
}

func assertPublicationAccess(t *testing.T, application *App, item MediaItem, public bool,
	get func(string, bool) *httptest.ResponseRecorder,
) {
	t.Helper()
	stored, err := application.store.Get(t.Context(), item.ID)
	require.NoError(t, err)
	assert.Equal(t, item.Hidden, stored.Hidden)
	if item.PublishAt == nil {
		assert.Nil(t, stored.PublishAt)
	} else {
		require.NotNil(t, stored.PublishAt)
		assert.True(t, item.PublishAt.Equal(*stored.PublishAt))
	}
	catalog := get("/api/media?kind="+item.Kind, false)
	require.Equal(t, http.StatusOK, catalog.Code)
	assert.Equal(t, public, strings.Contains(catalog.Body.String(), `"id":"`+item.ID+`"`))
	admin := get("/api/admin/media?kind="+item.Kind, true)
	assert.Contains(t, admin.Body.String(), `"id":"`+item.ID+`"`)
	status := http.StatusNotFound
	if public {
		status = http.StatusOK
	}
	for _, path := range []string{
		"/media/" + item.Kind + "/audio", "/media/" + item.Kind + "/cover",
		"/media/" + item.Kind + "/waveform", "/api/media/" + item.Kind + "/timed-content",
	} {
		assert.Equal(t, status, get(path, false).Code, path)
		preview := get(path, true)
		assert.Equal(t, http.StatusOK, preview.Code, path)
		assert.Contains(t, preview.Header().Get("Cache-Control"), "no-store")
	}
	if item.Kind == mediaKindSet {
		assert.Equal(t, status, get("/api/featured", false).Code)
	}
}

func TestPublicationInput(t *testing.T) {
	future := time.Now().Add(time.Hour).In(time.FixedZone("local", 7200))
	item := MediaItem{Hidden: true}
	input := mediaInput{Kind: mediaKindSong, Title: "Test"}
	require.NoError(t, applyMediaInput(&item, input))
	assert.True(t, item.Hidden, "older clients must preserve visibility")
	input.Publication = &publicationInput{PublishAt: &future}
	require.NoError(t, applyMediaInput(&item, input))
	assert.False(t, item.Hidden)
	assert.True(t, future.Equal(*item.PublishAt))
	assert.Equal(t, time.UTC, item.PublishAt.Location())
	input.Publication = &publicationInput{Hidden: true, PublishAt: &future}
	require.Error(t, applyMediaInput(&item, input))
	past := time.Now().Add(-time.Hour)
	input.Publication = &publicationInput{PublishAt: &past}
	require.Error(t, applyMediaInput(&item, input))
	input.Publication = &publicationInput{Hidden: true}
	require.NoError(t, applyMediaInput(&item, input))
	assert.Nil(t, item.PublishAt, "hiding cancels the schedule")
	input.Publication = &publicationInput{}
	require.NoError(t, applyMediaInput(&item, input))
	assert.True(t, item.isPublic(time.Now()))
	item.PublishAt = &future
	assert.False(t, item.isPublic(future.Add(-time.Nanosecond)))
	assert.True(t, item.isPublic(future), "visible at the exact scheduled instant")
	var malformed mediaInput
	assert.Error(t, json.Unmarshal([]byte(`{"publication":{"publish_at":"invalid"}}`), &malformed))
}

func TestCatalogPreviewByID(t *testing.T) {
	application := testApp(t)
	session := httptest.NewRecorder()
	require.NoError(t, application.auth.setSession(session, AdminIdentity{
		Subject: "admin", Expires: time.Now().Add(time.Hour).Unix(),
	}))
	future := time.Now().UTC().Add(time.Hour)
	for _, kind := range []string{mediaKindSet, mediaKindSong} {
		for _, item := range []MediaItem{
			{ID: kind + "-public"},
			{ID: kind + "-hidden", Hidden: true},
			{ID: kind + "-scheduled", PublishAt: &future},
		} {
			item.Kind, item.Title, item.CreatedAt = kind, item.ID, time.Now().UTC()
			require.NoError(t, application.store.Create(t.Context(), item))
		}
		for _, preview := range []struct {
			id    string
			admin bool
			extra bool
		}{
			{"", true, false},
			{kind + "-public", true, false},
			{kind + "-hidden", true, true},
			{kind + "-scheduled", true, true},
			{kind + "-hidden", false, false},
			{kind + "-scheduled", false, false},
			{"missing", true, false},
		} {
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet,
				"/api/media?kind="+kind+"&track="+preview.id, nil)
			if preview.admin {
				request.AddCookie(session.Result().Cookies()[0])
			}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			require.Equal(t, http.StatusOK, response.Code)
			assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
			var catalog struct {
				Items []MediaItem `json:"items"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &catalog))
			ids := make([]string, 0, len(catalog.Items))
			for _, item := range catalog.Items {
				ids = append(ids, item.ID)
			}
			expected := []string{kind + "-public"}
			if preview.extra {
				expected = append(expected, preview.id)
			}
			assert.ElementsMatch(t, expected, ids, "preview=%s admin=%t", preview.id, preview.admin)
		}
		stored, err := application.store.Get(t.Context(), kind+"-hidden")
		require.NoError(t, err)
		assert.True(t, stored.Hidden, "preview must not publish the track")
	}
}
