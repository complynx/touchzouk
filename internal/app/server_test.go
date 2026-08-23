package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeAnalyzer struct{}

func (fakeAnalyzer) Analyze(context.Context, string, int) (Analysis, error) {
	return Analysis{Title: "Embedded title", DurationSeconds: 123.5, Waveform: []float64{0.1, 1, 0.4}}, nil
}

type blockingAnalyzer struct {
	started chan struct{}
	release chan struct{}
}

func (analyzer blockingAnalyzer) Analyze(ctx context.Context, _ string, _ int) (Analysis, error) {
	close(analyzer.started)
	select {
	case <-analyzer.release:
		return Analysis{DurationSeconds: 60, Waveform: []float64{0.2, 0.8}}, nil
	case <-ctx.Done():
		return Analysis{}, ctx.Err()
	}
}

type stagedFakeAnalyzer struct {
	waveformStarted  chan struct{}
	continueWaveform chan struct{}
}

func (analyzer stagedFakeAnalyzer) Analyze(ctx context.Context, path string, points int) (Analysis, error) {
	metadata, err := analyzer.Probe(ctx, path)
	if err != nil {
		return Analysis{}, err
	}
	return analyzer.AnalyzeWaveform(ctx, path, points, metadata)
}

func (stagedFakeAnalyzer) Probe(context.Context, string) (Analysis, error) {
	return Analysis{Title: "Early title", DurationSeconds: 321}, nil
}

func (analyzer stagedFakeAnalyzer) AnalyzeWaveform(
	ctx context.Context,
	_ string,
	_ int,
	metadata Analysis,
) (Analysis, error) {
	close(analyzer.waveformStarted)
	select {
	case <-analyzer.continueWaveform:
		metadata.Waveform = []float64{.2, .8, .4}
		return metadata, nil
	case <-ctx.Done():
		return Analysis{}, ctx.Err()
	}
}

func testApp(t *testing.T) *App {
	t.Helper()
	directory := t.TempDir()
	site := filepath.Join(directory, "site")
	require.NoError(t, os.MkdirAll(site, 0o750))
	for _, name := range []string{"index.html", "listen.html", "admin.html"} {
		require.NoError(t, os.WriteFile(filepath.Join(site, name), []byte(name), 0o600))
	}
	cfg := Config{
		Server:  ServerConfig{Address: ":0", PublicURL: "http://example.test"},
		DataDir: filepath.Join(directory, "data"), SiteDir: site,
		Database: DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(directory, "data", "test.db")},
		Media:    MediaConfig{MaxUploadMB: 10, WaveformPoints: 512, FFmpegPath: "ffmpeg", FFprobePath: "ffprobe"},
		Auth:     AuthConfig{Mode: "stub", SessionSecret: strings.Repeat("s", 32), StubUser: "Test admin"},
	}
	application, err := New(context.Background(), cfg)
	require.NoError(t, err)
	application.analyzer = fakeAnalyzer{}
	t.Cleanup(func() {
		require.NoError(t, application.Close())
	})
	return application
}

func newClientRequest(t *testing.T, method, target string, body io.Reader) *http.Request {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, target, body)
	require.NoError(t, err)
	return request
}

func clientGet(t *testing.T, client *http.Client, target string) *http.Response {
	t.Helper()
	response, err := client.Do(newClientRequest(t, http.MethodGet, target, nil))
	require.NoError(t, err)
	return response
}

func TestAdminStubLoginAndMediaEdit(t *testing.T) {
	application := testApp(t)
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar}

	response := clientGet(t, client, server.URL+"/admin")
	require.NoError(t, response.Body.Close())
	require.Equal(t, http.StatusOK, response.StatusCode)

	item := MediaItem{
		ID: "editable-set", Kind: "set", Title: "Embedded title", DurationSeconds: 123.5,
		Tags: []string{"deep", "melodic", "closing"}, TelegramURL: "https://t.me/touchzouk/314",
		CoverZoom: 1, CreatedAt: time.Now().UTC(),
	}
	require.NoError(t, application.store.Create(context.Background(), item))
	assert.Equal(t, "Embedded title", item.Title)
	assert.InDelta(t, 123.5, item.DurationSeconds, 0)
	assert.Len(t, item.Tags, 3)
	assert.Equal(t, "https://t.me/touchzouk/314", item.TelegramURL)
	updateBody := strings.NewReader(`{"kind":"set","title":"Edited title","telegram_url":"telegram.me/touchzouk/315"}`)
	request := newClientRequest(t, http.MethodPatch, server.URL+"/api/admin/media/"+item.ID, updateBody)
	request.Header.Set("Content-Type", "application/json")
	response, err = client.Do(request)
	require.NoError(t, err)
	contents, readErr := io.ReadAll(response.Body)
	require.NoError(t, response.Body.Close())
	require.NoError(t, readErr)
	require.Equal(t, http.StatusOK, response.StatusCode, string(contents))

	invalidBody := strings.NewReader(`{"kind":"set","title":"Edited title","telegram_url":"touchzouk"}`)
	request = newClientRequest(t, http.MethodPatch, server.URL+"/api/admin/media/"+item.ID, invalidBody)
	request.Header.Set("Content-Type", "application/json")
	response, err = client.Do(request)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	require.Equal(t, http.StatusBadRequest, response.StatusCode)

	response = clientGet(t, client, server.URL+"/api/media?kind=set")
	defer func() { require.NoError(t, response.Body.Close()) }()
	var catalog struct {
		Items []MediaItem `json:"items"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&catalog))
	require.Len(t, catalog.Items, 1)
	assert.NotEmpty(t, catalog.Items[0].AudioURL)
	assert.Equal(t, "Edited title", catalog.Items[0].Title)
	assert.Equal(t, "https://telegram.me/touchzouk/315", catalog.Items[0].TelegramURL)
}

func TestAdminAPIRequiresLogin(t *testing.T) {
	application := testApp(t)
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/admin/me", nil)
	recorder := httptest.NewRecorder()
	application.Handler().ServeHTTP(recorder, request)
	require.Equal(t, http.StatusUnauthorized, recorder.Code)
}

func TestExpiredUploadCleanupRemovesFilesAndRows(t *testing.T) {
	application := testApp(t)
	relative := filepath.ToSlash(filepath.Join("uploads", "audio", "expired.ogg"))
	path, ok := application.dataPath(relative)
	require.True(t, ok, "test upload path rejected")
	require.NoError(t, os.WriteFile(path, []byte("expired"), 0o600))
	draft := UploadDraft{
		ID: "expired", Kind: "audio", Path: relative, State: "ready",
		CreatedAt: time.Now().Add(-48 * time.Hour), ExpiresAt: time.Now().Add(-24 * time.Hour),
	}
	require.NoError(t, application.store.CreateUploadDraft(context.Background(), draft))
	application.cleanupExpiredUploads(context.Background())
	_, err := os.Stat(path)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, err = application.store.GetUploadDraft(context.Background(), draft.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestExpiredUploadCleanupSkipsPublishingDraft(t *testing.T) {
	application := testApp(t)
	relative := filepath.ToSlash(filepath.Join("uploads", "audio", "publishing.ogg"))
	path, ok := application.dataPath(relative)
	require.True(t, ok)
	require.NoError(t, os.WriteFile(path, []byte("publishing"), 0o600))
	draft := UploadDraft{
		ID: "publishing", Kind: "audio", Path: relative, State: "publishing",
		CreatedAt: time.Now().Add(-48 * time.Hour), ExpiresAt: time.Now().Add(-24 * time.Hour),
	}
	require.NoError(t, application.store.CreateUploadDraft(context.Background(), draft))
	application.cleanupExpiredUploads(context.Background())
	_, err := os.Stat(path)
	require.NoError(t, err)
	_, err = application.store.GetUploadDraft(context.Background(), draft.ID)
	require.NoError(t, err)
}

func TestExpiredUploadCleanupSkipsActiveAnalysis(t *testing.T) {
	application := testApp(t)
	now := time.Now().UTC()
	for _, state := range []string{"analyzing", "waveform"} {
		id := "active-" + state
		relative := filepath.ToSlash(filepath.Join("uploads", "audio", id+".ogg"))
		path, ok := application.dataPath(relative)
		require.True(t, ok)
		require.NoError(t, os.WriteFile(path, []byte(state), 0o600))
		draft := UploadDraft{
			ID: id, Kind: "audio", Path: relative, State: state,
			CreatedAt: now.Add(-48 * time.Hour), ExpiresAt: now.Add(-24 * time.Hour),
		}
		require.NoError(t, application.store.CreateUploadDraft(t.Context(), draft))
		application.cleanupExpiredUploads(t.Context())
		_, err := os.Stat(path)
		require.NoError(t, err)
		_, err = application.store.GetUploadDraft(t.Context(), id)
		require.NoError(t, err)
	}
}

func TestExpiredInterruptedAnalysisIsRecoveredThenCleaned(t *testing.T) {
	application := testApp(t)
	now := time.Now().UTC()
	relative := filepath.ToSlash(filepath.Join("uploads", "audio", "interrupted-expired.ogg"))
	path, ok := application.dataPath(relative)
	require.True(t, ok)
	require.NoError(t, os.WriteFile(path, []byte("interrupted"), 0o600))
	draft := UploadDraft{
		ID: "interrupted-expired", Kind: "audio", Path: relative, State: "analyzing",
		CreatedAt: now.Add(-48 * time.Hour), ExpiresAt: now.Add(-24 * time.Hour),
	}
	require.NoError(t, application.store.CreateUploadDraft(t.Context(), draft))
	ids, err := application.store.RecoverAudioUploads(t.Context(), now)
	require.NoError(t, err)
	assert.Empty(t, ids)
	application.cleanupExpiredUploads(t.Context())
	_, err = os.Stat(path)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, err = application.store.GetUploadDraft(t.Context(), draft.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestAudioAnalysisWakeIsCoalesced(t *testing.T) {
	application := &App{audioWake: make(chan struct{}, 1)}
	application.wakeAudioAnalysis()
	application.wakeAudioAnalysis()
	assert.Len(t, application.audioWake, 1)
}

func TestInterruptedPublishRecoveryRestoresDraftFile(t *testing.T) {
	application := testApp(t)
	source := filepath.ToSlash(filepath.Join("uploads", "audio", "recover.ogg"))
	destination := filepath.ToSlash(filepath.Join("audio", "recover.ogg"))
	destinationPath, ok := application.dataPath(destination)
	require.True(t, ok, "destination path rejected")
	require.NoError(t, os.WriteFile(destinationPath, []byte("recover"), 0o600))
	journal := publishJournal{MediaID: "recover", Moves: [][2]string{{source, destination}}}
	encoded, err := json.Marshal(journal)
	require.NoError(t, err)
	journalKey := publishJournalPrefix + journal.MediaID
	require.NoError(t, application.store.SetSetting(context.Background(), journalKey, string(encoded)))
	_, err = application.recoverPublishing(context.Background())
	require.NoError(t, err)
	sourcePath, ok := application.dataPath(source)
	require.True(t, ok)
	_, err = os.Stat(sourcePath)
	require.NoError(t, err)
}

func TestInterruptedPublishRecoveryPreservesUnfinishedClaims(t *testing.T) {
	application := testApp(t)
	now := time.Now().UTC()
	for _, id := range []string{"protected", "orphaned"} {
		err := application.store.CreateUploadDraft(context.Background(), UploadDraft{
			ID: id, Kind: "audio", Path: filepath.ToSlash(filepath.Join("uploads", "audio", id+".ogg")),
			State: "publishing", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
		})
		require.NoError(t, err)
	}
	journal := publishJournal{
		MediaID:  "blocked-recovery",
		Moves:    [][2]string{{"../outside-data", "audio/blocked.ogg"}},
		DraftIDs: []string{"protected"},
	}
	encoded, err := json.Marshal(journal)
	require.NoError(t, err)
	journalKey := publishJournalPrefix + journal.MediaID
	require.NoError(t, application.store.SetSetting(context.Background(), journalKey, string(encoded)))
	protected, err := application.recoverPublishing(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"protected"}, protected)
	require.NoError(t, application.store.ResetPublishingUploadsExcept(context.Background(), protected))
	protectedDraft, err := application.store.GetUploadDraft(context.Background(), "protected")
	require.NoError(t, err)
	assert.Equal(t, "publishing", protectedDraft.State)
	orphanedDraft, err := application.store.GetUploadDraft(context.Background(), "orphaned")
	require.NoError(t, err)
	assert.Equal(t, "ready", orphanedDraft.State)
}

func TestInterruptedCoverReplacementRollsBackBeforeDatabaseUpdate(t *testing.T) {
	application := testApp(t)
	now := time.Now().UTC()
	item := MediaItem{
		ID: "cover-rollback", Kind: "set", Title: "Rollback",
		CoverPath: "covers/old.png", CoverZoom: 1, CreatedAt: now,
	}
	require.NoError(t, application.store.Create(context.Background(), item))
	draftPath := "uploads/covers/rollback.png"
	newPath := "covers/cover-rollback-new.png"
	draft := UploadDraft{
		ID: "rollback-cover", Kind: "cover", Path: draftPath, State: "publishing",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}
	require.NoError(t, application.store.CreateUploadDraft(context.Background(), draft))
	newAbsolute, ok := application.dataPath(newPath)
	require.True(t, ok)
	require.NoError(t, os.WriteFile(newAbsolute, []byte("new cover"), 0o600))
	journal := coverReplacementJournal{
		MediaID: item.ID, DraftID: "rollback-cover", DraftPath: draftPath,
		OldPath: item.CoverPath, NewPath: newPath,
	}
	encoded, err := json.Marshal(journal)
	require.NoError(t, err)
	journalKey := coverReplacementJournalPrefix + item.ID + ":" + journal.DraftID
	require.NoError(t, application.store.SetSetting(context.Background(), journalKey, string(encoded)))
	_, err = application.recoverCoverReplacements(context.Background())
	require.NoError(t, err)
	draftAbsolute, ok := application.dataPath(draftPath)
	require.True(t, ok)
	_, err = os.Stat(draftAbsolute)
	require.NoError(t, err)
	draft, err = application.store.GetUploadDraft(context.Background(), journal.DraftID)
	require.NoError(t, err)
	assert.Equal(t, "ready", draft.State)
}

func TestInterruptedCoverReplacementFinishesAfterDatabaseUpdate(t *testing.T) {
	application := testApp(t)
	now := time.Now().UTC()
	oldPath := "covers/finalize-old.png"
	newPath := "covers/finalize-new.png"
	item := MediaItem{
		ID: "cover-finalize", Kind: "set", Title: "Finalize",
		CoverPath: newPath, CoverZoom: 1, CreatedAt: now,
	}
	require.NoError(t, application.store.Create(context.Background(), item))
	draft := UploadDraft{
		ID: "finalize-cover", Kind: "cover", Path: "uploads/covers/finalize.png",
		State: "publishing", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}
	require.NoError(t, application.store.CreateUploadDraft(context.Background(), draft))
	for _, relative := range []string{oldPath, newPath} {
		absolute, ok := application.dataPath(relative)
		require.True(t, ok)
		require.NoError(t, os.WriteFile(absolute, []byte(relative), 0o600))
	}
	journal := coverReplacementJournal{
		MediaID: item.ID, DraftID: draft.ID, DraftPath: draft.Path,
		OldPath: oldPath, NewPath: newPath,
	}
	encoded, err := json.Marshal(journal)
	require.NoError(t, err)
	journalKey := coverReplacementJournalPrefix + item.ID + ":" + draft.ID
	require.NoError(t, application.store.SetSetting(context.Background(), journalKey, string(encoded)))
	_, err = application.recoverCoverReplacements(context.Background())
	require.NoError(t, err)
	oldAbsolute, ok := application.dataPath(oldPath)
	require.True(t, ok)
	_, err = os.Stat(oldAbsolute)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, err = application.store.GetUploadDraft(context.Background(), draft.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestMediaDateParsesISOAndClock(t *testing.T) {
	item := MediaItem{PlayedAt: "2026-07-18 23:45"}
	want := time.Date(2026, time.July, 18, 23, 45, 0, 0, time.UTC)
	assert.Equal(t, want, mediaDate(item))
}

func TestMediaDateParsesNineteenthCenturyYear(t *testing.T) {
	item := MediaItem{PlayedAt: "1899"}
	want := time.Date(1899, time.January, 1, 0, 0, 0, 0, time.UTC)
	assert.Equal(t, want, mediaDate(item))
}

func TestMediaDateDoesNotReinterpretInvalidISODate(t *testing.T) {
	created := time.Date(2026, time.August, 22, 0, 0, 0, 0, time.UTC)
	for _, playedAt := range []string{"2026-13", "2026-02-30"} {
		assert.Equal(t, created, mediaDate(MediaItem{PlayedAt: playedAt, CreatedAt: created}))
	}
}

func TestUpdateMediaRejectsAmbiguousPartialPayload(t *testing.T) {
	application := testApp(t)
	item := MediaItem{ID: "partial", Kind: "song", Title: "Original", CoverZoom: 1, CreatedAt: time.Now()}
	require.NoError(t, application.store.Create(context.Background(), item))
	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPatch,
		"/api/admin/media/partial",
		strings.NewReader(`{"title":"Changed","subtitle":"Ignored"}`),
	)
	request.SetPathValue("id", item.ID)
	response := httptest.NewRecorder()
	application.updateMedia(response, request)
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	stored, err := application.store.Get(context.Background(), item.ID)
	require.NoError(t, err)
	assert.Equal(t, item.Title, stored.Title)
}

func TestUpdateMediaRejectsUnknownAndTrailingMetadata(t *testing.T) {
	application := testApp(t)
	item := MediaItem{ID: "strict-json", Kind: "song", Title: "Original", CoverZoom: 1, CreatedAt: time.Now()}
	require.NoError(t, application.store.Create(t.Context(), item))

	for name, body := range map[string]string{
		"unknown field":  `{"kind":"song","title":"Changed","unknown":true}`,
		"trailing value": `{"kind":"song","title":"Changed"} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(
				t.Context(), http.MethodPatch, "/api/admin/media/strict-json", strings.NewReader(body),
			)
			request.SetPathValue("id", item.ID)
			response := httptest.NewRecorder()
			application.updateMedia(response, request)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		})
	}

	stored, err := application.store.Get(t.Context(), item.ID)
	require.NoError(t, err)
	assert.Equal(t, item.Title, stored.Title)
}

func TestUploadRejectsForeignOrigin(t *testing.T) {
	application := testApp(t)
	recorder := httptest.NewRecorder()
	application.auth.setSession(recorder, AdminIdentity{
		Subject: "admin", Name: "Admin", Expires: application.auth.now().Add(time.Minute).Unix(),
	})
	body, contentType := singleUploadBody(t, "audio", "set.ogg", []byte("OggS fake test audio"))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/admin/uploads/audio", body)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Origin", "https://evil.example")
	request.AddCookie(recorder.Result().Cookies()[0])
	result := httptest.NewRecorder()
	application.Handler().ServeHTTP(result, request)
	require.Equal(t, http.StatusForbidden, result.Code)
}

func TestStagedUploadPublishesSong(t *testing.T) {
	application := testApp(t)
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	client := authenticatedTestClient(t, server.URL)
	audioID, audioUpload := stageTestAudio(t, client, server.URL)
	assert.Equal(t, "Embedded title", audioUpload["title"])
	assert.Equal(t, "song", audioUpload["suggested_kind"])
	coverID := stageTestCover(t, client, server.URL)
	item := publishTestSong(t, client, server.URL, audioID, coverID)
	assert.Equal(t, "song", item.Kind)
	assert.Empty(t, item.AudioPath)
	assert.NotEmpty(t, item.AudioURL)
	assert.Equal(t, "https://t.me/touchzouk/2718", item.TelegramURL)
	stored, err := application.store.Get(context.Background(), item.ID)
	require.NoError(t, err)
	assert.Equal(t, ".ogg", filepath.Ext(stored.AudioPath))
}

func authenticatedTestClient(t *testing.T, serverURL string) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar}
	response := clientGet(t, client, serverURL+"/admin")
	require.NoError(t, response.Body.Close())
	return client
}

func stageTestAudio(t *testing.T, client *http.Client, serverURL string) (string, map[string]any) {
	t.Helper()
	audioBody, audioType := singleUploadBody(t, "audio", "melody.ogg", []byte("OggS fake test audio"))
	request := newClientRequest(t, http.MethodPost, serverURL+"/api/admin/uploads/audio", audioBody)
	request.Header.Set("Content-Type", audioType)
	response, err := client.Do(request)
	require.NoError(t, err)
	if response.StatusCode != http.StatusAccepted {
		contents, readErr := io.ReadAll(response.Body)
		require.NoError(t, response.Body.Close())
		require.NoError(t, readErr)
		require.Equal(t, http.StatusAccepted, response.StatusCode, string(contents))
	}
	var audioUpload map[string]any
	decodeErr := json.NewDecoder(response.Body).Decode(&audioUpload)
	require.NoError(t, response.Body.Close())
	require.NoError(t, decodeErr)
	audioID, ok := audioUpload["id"].(string)
	require.True(t, ok)
	deadline := time.Now().Add(2 * time.Second)
	for {
		response = clientGet(t, client, serverURL+"/api/admin/uploads/"+audioID)
		decodeErr = json.NewDecoder(response.Body).Decode(&audioUpload)
		require.NoError(t, response.Body.Close())
		require.NoError(t, decodeErr)
		if audioUpload["state"] == "ready" {
			break
		}
		if time.Now().After(deadline) {
			require.FailNow(t, "audio did not become ready", "%#v", audioUpload)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return audioID, audioUpload
}

func stageTestCover(t *testing.T, client *http.Client, serverURL string) string {
	t.Helper()
	coverBytes := testPNG(t)
	coverBody, coverType := singleUploadBody(t, "cover", "cover.png", coverBytes)
	request := newClientRequest(t, http.MethodPost, serverURL+"/api/admin/uploads/cover", coverBody)
	request.Header.Set("Content-Type", coverType)
	response, err := client.Do(request)
	require.NoError(t, err)
	var coverUpload map[string]any
	decodeErr := json.NewDecoder(response.Body).Decode(&coverUpload)
	require.NoError(t, response.Body.Close())
	require.NoError(t, decodeErr)
	require.Equal(t, http.StatusCreated, response.StatusCode, "%#v", coverUpload)
	coverID, ok := coverUpload["id"].(string)
	require.True(t, ok)
	return coverID
}

func publishTestSong(t *testing.T, client *http.Client, serverURL, audioID, coverID string) MediaItem {
	t.Helper()
	payload := fmt.Sprintf(
		`{"audio_upload_id":%q,"cover_upload_id":%q,"kind":"song",`+
			`"title":"Embedded title","subtitle":"Demo","tags":"cc0, demo","telegram_url":"2718"}`,
		audioID,
		coverID,
	)
	request := newClientRequest(t, http.MethodPost, serverURL+"/api/admin/media", strings.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	require.NoError(t, err)
	defer func() { require.NoError(t, response.Body.Close()) }()
	if response.StatusCode != http.StatusCreated {
		contents, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		require.Equal(t, http.StatusCreated, response.StatusCode, string(contents))
	}
	var item MediaItem
	require.NoError(t, json.NewDecoder(response.Body).Decode(&item))
	return item
}

func TestSuggestedKindBoundary(t *testing.T) {
	assert.Equal(t, "song", suggestedKind(12*60-0.01))
	assert.Equal(t, "set", suggestedKind(12*60))
}

func TestStagedAnalysisPublishesMetadataBeforeWaveform(t *testing.T) {
	application := testApp(t)
	analyzer := stagedFakeAnalyzer{waveformStarted: make(chan struct{}), continueWaveform: make(chan struct{})}
	application.analyzer = analyzer
	relative := filepath.ToSlash(filepath.Join("uploads", "audio", "staged.ogg"))
	path, ok := application.dataPath(relative)
	require.True(t, ok)
	require.NoError(t, os.WriteFile(path, []byte("audio"), 0o600))
	draft := UploadDraft{
		ID: "staged", Kind: "audio", Path: relative, OriginalName: "staged.ogg", State: "uploaded",
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}
	require.NoError(t, application.store.CreateUploadDraft(context.Background(), draft))
	application.wakeAudioAnalysis()
	select {
	case <-analyzer.waveformStarted:
	case <-time.After(time.Second):
		require.FailNow(t, "waveform stage did not start")
	}
	metadata, err := application.store.GetUploadDraft(context.Background(), draft.ID)
	require.NoError(t, err)
	assert.Equal(t, "waveform", metadata.State)
	assert.Equal(t, "Early title", metadata.Title)
	assert.InDelta(t, 321, metadata.DurationSeconds, 0)
	close(analyzer.continueWaveform)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		completed, err := application.store.GetUploadDraft(context.Background(), draft.ID)
		require.NoError(t, err)
		if completed.State == "ready" && completed.WaveformPath != "" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	require.FailNow(t, "waveform stage did not complete")
}

func TestCleanCoverPosition(t *testing.T) {
	assert.Equal(t, "18% 82%", cleanCoverPosition("18% 82%"))
	assert.Equal(t, "50% 50%", cleanCoverPosition("outside"))
}

func TestApplyMediaInputPreservesOmittedCoverPosition(t *testing.T) {
	item := MediaItem{CoverPosition: "18% 82%", CoverZoom: 1.75}
	input := mediaInput{Kind: "set", Title: "Existing set"}
	require.NoError(t, applyMediaInput(&item, input))
	assert.Equal(t, "18% 82%", item.CoverPosition)
	assert.InDelta(t, 1.75, item.CoverZoom, 0)

	position := "70% 25%"
	zoom := 4.2
	input.CoverPosition = &position
	input.CoverZoom = &zoom
	require.NoError(t, applyMediaInput(&item, input))
	assert.Equal(t, position, item.CoverPosition)
	assert.InDelta(t, 3, item.CoverZoom, 0)
}

func TestSongOrderPersistsExactCatalogOrder(t *testing.T) {
	application := testApp(t)
	for _, item := range []MediaItem{
		{ID: "first", Kind: "song", Title: "First", CoverZoom: 1, CreatedAt: time.Now().Add(-time.Hour)},
		{ID: "second", Kind: "song", Title: "Second", CoverZoom: 1, CreatedAt: time.Now()},
	} {
		require.NoError(t, application.store.Create(context.Background(), item))
	}
	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPut,
		"/api/admin/settings/song-order",
		strings.NewReader(`{"ids":["first","second"]}`),
	)
	response := httptest.NewRecorder()
	application.updateSongOrder(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	items, err := application.store.List(context.Background(), "song")
	require.NoError(t, err)
	application.sortCatalog(context.Background(), "song", items)
	require.Len(t, items, 2)
	assert.Equal(t, "first", items[0].ID)
	assert.Equal(t, "second", items[1].ID)

	request = httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPut,
		"/api/admin/settings/song-order",
		strings.NewReader(`{"ids":["first"]}`),
	)
	response = httptest.NewRecorder()
	application.updateSongOrder(response, request)
	require.Equal(t, http.StatusConflict, response.Code)
}

func TestAdminSettingsReportsInvalidSongOrder(t *testing.T) {
	application := testApp(t)
	require.NoError(t, application.store.SetSetting(t.Context(), "song_order", "not-json"))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/admin/settings", nil)
	response := httptest.NewRecorder()
	application.adminSettings(response, request)
	require.Equal(t, http.StatusInternalServerError, response.Code)
}

func TestPinMissingMediaReturnsNotFound(t *testing.T) {
	application := testApp(t)
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/admin/media/missing/pin", nil)
	request.SetPathValue("id", "missing")
	response := httptest.NewRecorder()
	application.pinMedia(response, request)
	require.Equal(t, http.StatusNotFound, response.Code)
}

func TestDeleteMediaRemovesAssetsAndSettings(t *testing.T) {
	application := testApp(t)
	item := MediaItem{
		ID: "delete-me", Kind: "song", Title: "Delete me", CoverZoom: 1,
		AudioPath: "audio/delete-me.ogg", CoverPath: "covers/delete-me.png",
		WaveformPath: "waveforms/delete-me.json", CreatedAt: time.Now(),
	}
	for _, relative := range []string{item.AudioPath, item.CoverPath, item.WaveformPath} {
		path, ok := application.dataPath(relative)
		require.True(t, ok, "invalid test path %q", relative)
		require.NoError(t, os.WriteFile(path, []byte("fixture"), 0o600))
	}
	require.NoError(t, application.store.Create(context.Background(), item))
	require.NoError(t, application.store.SetSetting(context.Background(), "song_order", `["delete-me"]`))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodDelete, "/api/admin/media/delete-me", nil)
	request.SetPathValue("id", item.ID)
	response := httptest.NewRecorder()
	application.deleteMedia(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	_, err := application.store.Get(context.Background(), item.ID)
	require.ErrorIs(t, err, ErrNotFound)
	order, err := application.songOrder(context.Background())
	require.NoError(t, err)
	assert.Empty(t, order)
	for _, relative := range []string{item.AudioPath, item.CoverPath, item.WaveformPath} {
		path, ok := application.dataPath(relative)
		require.True(t, ok)
		_, err = os.Stat(path)
		assert.ErrorIs(t, err, os.ErrNotExist, relative)
	}
}

func TestInterruptedDeletionFinishesFromJournal(t *testing.T) {
	application := testApp(t)
	item := MediaItem{
		ID: "recover-delete", Kind: mediaKindSet, Title: "Recover delete", CoverZoom: 1,
		AudioPath: "audio/recover-delete.ogg", CoverPath: "covers/recover-delete.png",
		CreatedAt: time.Now(),
	}
	for _, relative := range []string{item.AudioPath, item.CoverPath} {
		path, ok := application.dataPath(relative)
		require.True(t, ok)
		require.NoError(t, os.WriteFile(path, []byte("fixture"), 0o600))
	}
	require.NoError(t, application.store.Create(t.Context(), item))
	require.NoError(t, application.store.SetSetting(t.Context(), "featured_set_id", item.ID))
	journal := deleteJournal{MediaID: item.ID, Paths: []string{item.AudioPath, item.CoverPath}}
	encoded, err := json.Marshal(journal)
	require.NoError(t, err)
	journalKey := deleteJournalPrefix + item.ID
	require.NoError(t, application.store.SetSetting(t.Context(), journalKey, string(encoded)))
	require.NoError(t, application.store.Delete(t.Context(), item.ID))

	require.NoError(t, application.recoverDeletions(t.Context()))
	_, err = application.store.Get(t.Context(), item.ID)
	require.ErrorIs(t, err, ErrNotFound)
	featured, err := application.store.GetSetting(t.Context(), "featured_set_id", "missing")
	require.NoError(t, err)
	assert.Empty(t, featured)
	journals, err := application.store.SettingsWithPrefix(t.Context(), deleteJournalPrefix)
	require.NoError(t, err)
	assert.NotContains(t, journals, journalKey)
	for _, relative := range journal.Paths {
		path, ok := application.dataPath(relative)
		require.True(t, ok)
		_, err = os.Stat(path)
		assert.ErrorIs(t, err, os.ErrNotExist)
	}
}

func TestInterruptedDeletionBeforeDatabaseWritePreservesMedia(t *testing.T) {
	application := testApp(t)
	item := MediaItem{
		ID: "preserve-delete", Kind: mediaKindSet, Title: "Preserve delete", CoverZoom: 1,
		AudioPath: "audio/preserve-delete.ogg", CreatedAt: time.Now(),
	}
	path, ok := application.dataPath(item.AudioPath)
	require.True(t, ok)
	require.NoError(t, os.WriteFile(path, []byte("fixture"), 0o600))
	require.NoError(t, application.store.Create(t.Context(), item))
	journal := deleteJournal{MediaID: item.ID, Paths: []string{item.AudioPath}}
	encoded, err := json.Marshal(journal)
	require.NoError(t, err)
	journalKey := deleteJournalPrefix + item.ID
	require.NoError(t, application.store.SetSetting(t.Context(), journalKey, string(encoded)))

	require.NoError(t, application.recoverDeletions(t.Context()))
	_, err = application.store.Get(t.Context(), item.ID)
	require.NoError(t, err)
	assert.FileExists(t, path)
	journals, err := application.store.SettingsWithPrefix(t.Context(), deleteJournalPrefix)
	require.NoError(t, err)
	assert.NotContains(t, journals, journalKey)
}

func TestWaveformRegenerationDoesNotRestoreDeletedAsset(t *testing.T) {
	application := testApp(t)
	analyzer := blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	releaseAnalyzer := func() {
		select {
		case <-analyzer.release:
		default:
			close(analyzer.release)
		}
	}
	t.Cleanup(releaseAnalyzer)
	application.analyzer = analyzer
	item := MediaItem{
		ID: "delete-during-analysis", Kind: "song", Title: "Delete during analysis", CoverZoom: 1,
		AudioPath: "audio/delete-during-analysis.ogg", WaveformPath: "waveforms/delete-during-analysis.json",
		CreatedAt: time.Now(),
	}
	for _, relative := range []string{item.AudioPath, item.WaveformPath} {
		path, ok := application.dataPath(relative)
		require.True(t, ok)
		require.NoError(t, os.WriteFile(path, []byte("fixture"), 0o600))
	}
	require.NoError(t, application.store.Create(context.Background(), item))

	regenerateRequest := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		"/api/admin/media/"+item.ID+"/waveform",
		nil,
	)
	regenerateRequest.SetPathValue("id", item.ID)
	regenerateResponse := httptest.NewRecorder()
	regenerationDone := make(chan struct{})
	go func() {
		application.regenerateWaveform(regenerateResponse, regenerateRequest)
		close(regenerationDone)
	}()
	select {
	case <-analyzer.started:
	case <-time.After(time.Second):
		require.FailNow(t, "waveform regeneration did not start")
	}

	deleteRequest := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodDelete,
		"/api/admin/media/"+item.ID,
		nil,
	)
	deleteRequest.SetPathValue("id", item.ID)
	deleteResponse := httptest.NewRecorder()
	application.deleteMedia(deleteResponse, deleteRequest)
	require.Equal(t, http.StatusOK, deleteResponse.Code, deleteResponse.Body.String())
	releaseAnalyzer()
	select {
	case <-regenerationDone:
	case <-time.After(time.Second):
		require.FailNow(t, "waveform regeneration did not finish")
	}
	require.Equal(t, http.StatusNotFound, regenerateResponse.Code, regenerateResponse.Body.String())
	waveformPath, ok := application.dataPath(item.WaveformPath)
	require.True(t, ok)
	_, err := os.Stat(waveformPath)
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestCleanTelegramURL(t *testing.T) {
	tests := map[string]struct {
		input string
		want  string
	}{
		"bare post number":        {input: " 123 ", want: "https://t.me/touchzouk/123"},
		"tme without scheme":      {input: "t.me/touchzouk/456", want: "https://t.me/touchzouk/456"},
		"telegram without scheme": {input: "telegram.me/touchzouk/458", want: "https://telegram.me/touchzouk/458"},
		"leading slash":           {input: "/t.me/touchzouk/457", want: "https://t.me/touchzouk/457"},
		"channel shorthand":       {input: "touchzouk/789", want: "https://t.me/touchzouk/789"},
		"at shorthand":            {input: "@touchzouk/99", want: "https://t.me/touchzouk/99"},
		"full URL":                {input: "https://t.me/touchzouk/42", want: "https://t.me/touchzouk/42"},
		"invalid scheme":          {input: "javascript:alert(1)", want: ""},
		"hostless shorthand":      {input: "touchzouk", want: ""},
		"overlong number":         {input: strings.Repeat("1", 2049), want: ""},
		"empty":                   {input: "  ", want: ""},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, test.want, cleanTelegramURL(test.input))
		})
	}
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 1, 1))
	picture.Set(0, 0, color.RGBA{R: 20, G: 40, B: 60, A: 255})
	var output bytes.Buffer
	require.NoError(t, png.Encode(&output, picture))
	return output.Bytes()
}

func singleUploadBody(t *testing.T, field, filename string, contents []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile(field, filename)
	require.NoError(t, err)
	_, err = part.Write(contents)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return &body, writer.FormDataContentType()
}
