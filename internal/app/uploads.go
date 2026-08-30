package app

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

type mediaInput struct {
	AudioUploadID string        `json:"audio_upload_id"`
	CoverUploadID string        `json:"cover_upload_id"`
	Kind          string        `json:"kind"`
	Title         string        `json:"title"`
	Subtitle      string        `json:"subtitle"`
	EventName     string        `json:"event_name"`
	EventURL      string        `json:"event_url"`
	LocationURL   string        `json:"location_url"`
	PlayedAt      string        `json:"played_at"`
	Country       string        `json:"country"`
	City          string        `json:"city"`
	Tags          string        `json:"tags"`
	TelegramURL   string        `json:"telegram_url"`
	CoverPosition *string       `json:"cover_position"`
	CoverZoom     *float64      `json:"cover_zoom"`
	TimedContent  *TimedContent `json:"timed_content"`
}

const (
	publishJournalPrefix          = "publishing:"
	coverReplacementJournalPrefix = "cover-replacement:"
	deleteJournalPrefix           = "delete:"
)

type publishJournal struct {
	MediaID  string      `json:"media_id"`
	Moves    [][2]string `json:"moves"`
	DraftIDs []string    `json:"draft_ids"`
}

type coverReplacementJournal struct {
	MediaID   string `json:"media_id"`
	DraftID   string `json:"draft_id"`
	DraftPath string `json:"draft_path"`
	OldPath   string `json:"old_path"`
	NewPath   string `json:"new_path"`
}

type deleteJournal struct {
	MediaID string   `json:"media_id"`
	Paths   []string `json:"paths"`
}

type preparedCoverReplacement struct {
	draft      UploadDraft
	oldPath    string
	journalKey string
}

func (a *App) recoverPublishing(ctx context.Context) ([]string, error) {
	settings, err := a.store.SettingsWithPrefix(ctx, publishJournalPrefix)
	if err != nil {
		return nil, err
	}
	protectedDrafts := make([]string, 0)
	for key, encoded := range settings {
		var journal publishJournal
		if decodeErr := json.Unmarshal([]byte(encoded), &journal); decodeErr != nil {
			return nil, fmt.Errorf("decode %s: %w", key, decodeErr)
		}
		if _, getErr := a.store.Get(ctx, journal.MediaID); getErr == nil {
			if !a.cleanupPublishedDrafts(ctx, journal.MediaID, journal.DraftIDs) {
				protectedDrafts = append(protectedDrafts, journal.DraftIDs...)
				continue
			}
			if deleteErr := a.store.DeleteSetting(ctx, key); deleteErr != nil {
				return nil, deleteErr
			}
			continue
		} else if !errors.Is(getErr, ErrNotFound) {
			return nil, getErr
		}
		if !a.rollbackMoves(journal.Moves) {
			slog.Warn("interrupted publish needs another recovery attempt", "media_id", journal.MediaID)
			protectedDrafts = append(protectedDrafts, journal.DraftIDs...)
			continue
		}
		if releaseErr := a.store.ReleasePublishingUploads(ctx, journal.DraftIDs...); releaseErr != nil {
			return nil, releaseErr
		}
		if deleteErr := a.store.DeleteSetting(ctx, key); deleteErr != nil {
			return nil, deleteErr
		}
	}
	return protectedDrafts, nil
}

func (a *App) cleanupPublishedDrafts(ctx context.Context, mediaID string, draftIDs []string) bool {
	complete := true
	for _, id := range draftIDs {
		if err := a.store.DeleteUploadDraft(ctx, id); err != nil {
			slog.Warn("remove published upload draft", "media_id", mediaID, "draft_id", id, "error", err)
			complete = false
		}
	}
	return complete
}

func (a *App) recoverCoverReplacements(ctx context.Context) ([]string, error) {
	settings, err := a.store.SettingsWithPrefix(ctx, coverReplacementJournalPrefix)
	if err != nil {
		return nil, err
	}
	protectedDrafts := make([]string, 0)
	for key, encoded := range settings {
		var journal coverReplacementJournal
		if decodeErr := json.Unmarshal([]byte(encoded), &journal); decodeErr != nil {
			return nil, fmt.Errorf("decode %s: %w", key, decodeErr)
		}
		protected, recoverErr := a.recoverCoverReplacement(ctx, key, journal)
		if recoverErr != nil {
			return nil, recoverErr
		}
		if protected {
			protectedDrafts = append(protectedDrafts, journal.DraftID)
		}
	}
	return protectedDrafts, nil
}

func (a *App) recoverDeletions(ctx context.Context) error {
	settings, err := a.store.SettingsWithPrefix(ctx, deleteJournalPrefix)
	if err != nil {
		return err
	}
	for key, encoded := range settings {
		var journal deleteJournal
		if decodeErr := json.Unmarshal([]byte(encoded), &journal); decodeErr != nil {
			return fmt.Errorf("decode %s: %w", key, decodeErr)
		}
		if _, getErr := a.store.Get(ctx, journal.MediaID); getErr == nil {
			if deleteErr := a.store.DeleteSetting(ctx, key); deleteErr != nil {
				return deleteErr
			}
			continue
		} else if !errors.Is(getErr, ErrNotFound) {
			return getErr
		}
		if cleanupErr := a.cleanupDeletedAssets(ctx, key, journal); cleanupErr != nil {
			return cleanupErr
		}
	}
	return nil
}

func (a *App) probeMediaAfterWrite(id string) (MediaItem, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return a.store.Get(ctx, id)
}

func (a *App) cleanupDeletedAssets(ctx context.Context, key string, journal deleteJournal) error {
	complete := true
	for _, relative := range journal.Paths {
		if relative == "" {
			continue
		}
		path, ok := a.dataPath(relative)
		if !ok {
			slog.Warn("skip invalid deleted media path", "media_id", journal.MediaID, "path", relative)
			complete = false
			continue
		}
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			slog.Warn("remove deleted media asset", "media_id", journal.MediaID, "path", relative, "error", removeErr)
			complete = false
		}
	}
	if !complete {
		return nil
	}
	return a.store.DeleteSetting(ctx, key)
}

func (a *App) recoverCoverReplacement(
	ctx context.Context,
	key string,
	journal coverReplacementJournal,
) (bool, error) {
	item, err := a.store.Get(ctx, journal.MediaID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return false, err
	}
	if err == nil && item.CoverPath == journal.NewPath {
		return a.finishRecoveredCoverReplacement(ctx, key, journal)
	}
	if !a.rollbackMoves([][2]string{{journal.DraftPath, journal.NewPath}}) {
		return true, nil
	}
	if releaseErr := a.store.ReleasePublishingUploads(ctx, journal.DraftID); releaseErr != nil {
		return false, releaseErr
	}
	return false, a.store.DeleteSetting(ctx, key)
}

func (a *App) finishRecoveredCoverReplacement(
	ctx context.Context,
	key string,
	journal coverReplacementJournal,
) (bool, error) {
	newPath, ok := a.dataPath(journal.NewPath)
	if !ok {
		return true, nil
	}
	draft, draftErr := a.store.GetUploadDraft(ctx, journal.DraftID)
	draftPath := journal.DraftPath
	if draftErr == nil {
		draftPath = draft.Path
	}
	if ready := a.restoreReplacementCover(newPath, draftPath, journal.NewPath); !ready {
		return true, nil
	}
	if oldPath, valid := a.dataPath(journal.OldPath); valid {
		if removeErr := os.Remove(oldPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return true, nil
		}
	}
	if draftErr == nil {
		if deleteErr := a.store.DeleteUploadDraft(ctx, journal.DraftID); deleteErr != nil {
			return true, nil //nolint:nilerr // Preserve the draft so startup recovery can retry transient cleanup.
		}
	} else if !errors.Is(draftErr, ErrNotFound) {
		return false, draftErr
	}
	return false, a.store.DeleteSetting(ctx, key)
}

func (a *App) restoreReplacementCover(newPath, draftPath, newRelativePath string) bool {
	_, statErr := os.Stat(newPath)
	if statErr == nil {
		return true
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return false
	}
	return a.moveDataFile(draftPath, newRelativePath) == nil
}

func (a *App) rollbackMoves(moves [][2]string) bool {
	complete := true
	for _, move := range slices.Backward(moves) {
		source, sourceOK := a.dataPath(move[0])
		destination, destinationOK := a.dataPath(move[1])
		if !sourceOK || !destinationOK {
			complete = false
			continue
		}
		_, sourceErr := os.Stat(source)
		_, destinationErr := os.Stat(destination)
		switch {
		case sourceErr == nil && destinationErr == nil:
			if err := os.Remove(destination); err != nil {
				complete = false
			}
		case errors.Is(sourceErr, os.ErrNotExist) && destinationErr == nil:
			if err := os.MkdirAll(filepath.Dir(source), 0o750); err != nil {
				complete = false
				continue
			}
			if err := os.Rename(destination, source); err != nil {
				complete = false
			}
		case sourceErr != nil && !errors.Is(sourceErr, os.ErrNotExist):
			complete = false
		case destinationErr != nil && !errors.Is(destinationErr, os.ErrNotExist):
			complete = false
		}
	}
	return complete
}

func (a *App) cleanupExpiredUploads(ctx context.Context) {
	drafts, err := a.store.ExpiredUploadDrafts(ctx, time.Now().UTC())
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			slog.Warn("find expired uploads", "error", err)
		}
		return
	}
	for _, draft := range drafts {
		if !a.removeExpiredUploadFiles(draft) {
			continue
		}
		if deleteErr := a.store.DeleteUploadDraft(ctx, draft.ID); deleteErr != nil &&
			!errors.Is(deleteErr, context.Canceled) {
			slog.Warn("remove expired upload record", "id", draft.ID, "error", deleteErr)
		}
	}
}

func (a *App) removeExpiredUploadFiles(draft UploadDraft) bool {
	removed := true
	for _, relative := range []string{draft.Path, draft.WaveformPath} {
		if relative == "" {
			continue
		}
		path, ok := a.dataPath(relative)
		if !ok {
			slog.Warn("skip invalid expired upload path", "id", draft.ID)
			continue
		}
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			slog.Warn("remove expired upload file", "id", draft.ID, "error", removeErr)
			removed = false
		}
	}
	return removed
}

func (a *App) uploadAudioDraft(w http.ResponseWriter, r *http.Request) {
	if !a.validOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid request origin"})
		return
	}
	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not allocate upload"})
		return
	}
	maximum := a.cfg.Media.MaxUploadMB * 1024 * 1024
	relative, original, err := a.saveDraftFile(
		w,
		r,
		uploadKindAudio,
		id,
		maximum,
		[]string{".opus", ".ogg", ".flac"},
	)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	draft := UploadDraft{
		ID: id, Kind: uploadKindAudio, Path: relative, OriginalName: original,
		State: "uploaded", CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
	}
	if err := a.store.CreateUploadDraft(r.Context(), draft); err != nil {
		path, _ := a.dataPath(relative)
		_ = os.Remove(path)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not register upload"})
		return
	}
	a.wakeAudioAnalysis()
	writeJSON(w, http.StatusAccepted, a.uploadResponse(draft))
}

func (a *App) wakeAudioAnalysis() {
	select {
	case a.audioWake <- struct{}{}:
	default:
	}
}

func (a *App) runAudioAnalysis(ctx context.Context) {
	retry := time.NewTicker(30 * time.Second)
	defer retry.Stop()
	for {
		select {
		case <-a.audioWake:
		case <-retry.C:
		case <-ctx.Done():
			return
		}
		if err := a.drainAudioAnalysis(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("drain staged audio analysis", "error", err)
		}
	}
}

func (a *App) drainAudioAnalysis(ctx context.Context) error {
	for {
		id, err := a.store.NextAudioUpload(ctx, time.Now().UTC())
		if err != nil || id == "" {
			return err
		}
		if err := a.processAudioDraft(id); err != nil {
			slog.Warn("retry staged audio analysis", "id", id, "error", err)
			if resetErr := a.retryAudioDraft(ctx, id); resetErr != nil {
				return errors.Join(err, resetErr)
			}
		}
	}
}

func (a *App) retryAudioDraft(ctx context.Context, id string) error {
	retry := time.NewTicker(2 * time.Second)
	defer retry.Stop()
	for {
		err := a.store.RetryUploadAnalysis(ctx, id)
		if err == nil {
			return nil
		}
		slog.Warn("restore staged audio analysis", "id", id, "error", err)
		select {
		case <-retry.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (a *App) processAudioDraft(id string) error {
	claimed, err := a.store.ClaimUploadAnalysis(a.workerContext, id)
	if err != nil {
		return fmt.Errorf("claim upload %s: %w", id, err)
	}
	if !claimed {
		return nil
	}
	draft, err := a.store.GetUploadDraft(a.workerContext, id)
	if err != nil {
		return fmt.Errorf("load claimed upload %s: %w", id, err)
	}
	audioPath, ok := a.dataPath(draft.Path)
	if !ok {
		return a.failAudioDraft(id, "invalid stored audio path", errors.New("invalid stored audio path"))
	}
	var analysis Analysis
	if staged, ok := a.analyzer.(stagedAnalyzer); ok {
		analysis, err = a.probeAudio(a.workerContext, staged, audioPath)
	} else {
		analysis, err = a.analyze(a.workerContext, audioPath)
	}
	if err != nil {
		slog.Warn("analyze staged upload", "id", id, "error", err)
		cause := fmt.Errorf("analyze upload %s: %w", id, err)
		return a.failAudioDraft(id, "audio analysis failed: "+err.Error(), cause)
	}
	title := cleanText(analysis.Title, 180)
	if title == "" {
		title = titleFromFilename(draft.OriginalName)
	}
	analysis.Title = title
	if metadataErr := a.store.CompleteUploadMetadata(
		a.workerContext,
		id,
		title,
		analysis.DurationSeconds,
	); metadataErr != nil {
		return fmt.Errorf("save staged upload metadata for %s: %w", id, metadataErr)
	}
	if staged, ok := a.analyzer.(stagedAnalyzer); ok {
		analysis, err = a.analyzeStagedWaveform(a.workerContext, staged, audioPath, analysis)
		if err != nil {
			slog.Warn("build staged waveform", "id", id, "error", err)
			cause := fmt.Errorf("build staged waveform for %s: %w", id, err)
			return a.failAudioDraft(id, "waveform analysis failed: "+err.Error(), cause)
		}
	}
	waveformRelative := filepath.ToSlash(filepath.Join("uploads", "waveforms", id+".json"))
	waveformPath, _ := a.dataPath(waveformRelative)
	if err := writeWaveform(waveformPath, analysis); err != nil {
		cause := fmt.Errorf("cache waveform for %s: %w", id, err)
		return a.failAudioDraft(id, "could not cache waveform", cause)
	}
	if err := a.store.CompleteUploadAnalysis(
		a.workerContext,
		id,
		title,
		waveformRelative,
		analysis.DurationSeconds,
	); err != nil {
		_ = os.Remove(waveformPath)
		return fmt.Errorf("complete staged upload %s: %w", id, err)
	}
	return nil
}

func (a *App) failAudioDraft(id, message string, cause error) error {
	if err := a.store.FailUploadAnalysis(a.workerContext, id, message); err != nil {
		return errors.Join(cause, err)
	}
	return nil
}

func (a *App) uploadCoverDraft(w http.ResponseWriter, r *http.Request) {
	if !a.validOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid request origin"})
		return
	}
	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not allocate upload"})
		return
	}
	relative, original, err := a.saveDraftFile(
		w,
		r,
		uploadKindCover,
		id,
		25*1024*1024,
		[]string{extensionJPG, extensionJPEG, extensionPNG, ".webp", ".avif"},
	)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	path, _ := a.dataPath(relative)
	select {
	case a.coverSlots <- struct{}{}:
		defer func() { <-a.coverSlots }()
	case <-r.Context().Done():
		_ = os.Remove(path)
		writeJSON(w, http.StatusRequestTimeout, map[string]string{"error": "cover validation canceled"})
		return
	}
	if err := validateCover(
		path,
		strings.ToLower(filepath.Ext(original)),
		a.cfg.Media.FFmpegPath,
		a.cfg.Media.FFprobePath,
	); err != nil {
		_ = os.Remove(path)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	draft := UploadDraft{
		ID: id, Kind: uploadKindCover, Path: relative, OriginalName: original, State: uploadStateReady,
		CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
	}
	if err := a.store.CreateUploadDraft(r.Context(), draft); err != nil {
		_ = os.Remove(path)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not register upload"})
		return
	}
	writeJSON(w, http.StatusCreated, a.uploadResponse(draft))
}

func (a *App) uploadResponse(draft UploadDraft) map[string]any {
	response := map[string]any{
		"id": draft.ID, "kind": draft.Kind, "state": draft.State,
		"filename": draft.OriginalName, "title": draft.Title,
		"duration_seconds": draft.DurationSeconds,
		"status_url":       "/api/admin/uploads/" + draft.ID,
	}
	if draft.Kind == uploadKindCover || draft.Kind == uploadKindAudio {
		response["asset_url"] = "/api/admin/uploads/" + draft.ID + "/asset"
	}
	if draft.Kind == uploadKindAudio {
		response["suggested_kind"] = suggestedKind(draft.DurationSeconds)
		if draft.WaveformPath != "" {
			response["waveform_url"] = "/api/admin/uploads/" + draft.ID + "/waveform"
		}
	}
	if draft.Error != "" {
		response["error"] = draft.Error
	}
	return response
}

func (a *App) serveUploadDraft(w http.ResponseWriter, r *http.Request) {
	draft, err := a.store.GetUploadDraft(r.Context(), r.PathValue("id"))
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "upload not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load upload"})
		return
	}
	path, ok := a.dataPath(draft.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}

func (a *App) serveUploadWaveform(w http.ResponseWriter, r *http.Request) {
	draft, err := a.store.GetUploadDraft(r.Context(), r.PathValue("id"))
	if err != nil || draft.Kind != uploadKindAudio || draft.WaveformPath == "" {
		http.NotFound(w, r)
		return
	}
	path, ok := a.dataPath(draft.WaveformPath)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, path)
}

func (a *App) uploadDraftStatus(w http.ResponseWriter, r *http.Request) {
	draft, err := a.store.GetUploadDraft(r.Context(), r.PathValue("id"))
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "upload not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load upload"})
		return
	}
	writeJSON(w, http.StatusOK, a.uploadResponse(draft))
}

func (a *App) saveDraftFile(
	w http.ResponseWriter,
	r *http.Request,
	field string,
	id string,
	maximum int64,
	allowed []string,
) (string, string, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maximum+1024*1024)
	reader, err := r.MultipartReader()
	if err != nil {
		return "", "", errors.New("invalid or oversized upload")
	}
	var relative, original string
	cleanup := func() {
		if path, ok := a.dataPath(relative); ok {
			_ = os.Remove(path)
		}
	}
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			cleanup()
			return "", "", errors.New("invalid or oversized upload")
		}
		if part.FileName() == "" {
			_ = part.Close()
			continue
		}
		if part.FormName() != field || relative != "" {
			_ = part.Close()
			cleanup()
			return "", "", fmt.Errorf("one %s file is required", field)
		}
		original = filepath.Base(part.FileName())
		extension := strings.ToLower(filepath.Ext(original))
		if !slices.Contains(allowed, extension) {
			_ = part.Close()
			cleanup()
			return "", "", fmt.Errorf("unsupported %s file type", field)
		}
		directory := field
		if field == uploadKindCover {
			directory = "covers"
		}
		relative = filepath.ToSlash(filepath.Join("uploads", directory, id+extension))
		path, _ := a.dataPath(relative)
		_, err = copyLimited(path, part, maximum)
		_ = part.Close()
		if err != nil {
			_ = os.Remove(path)
			return "", "", fmt.Errorf("could not save %s upload: %w", field, err)
		}
	}
	if relative == "" {
		return "", "", fmt.Errorf("one %s file is required", field)
	}
	return relative, original, nil
}

func titleFromFilename(filename string) string {
	title := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	title = strings.NewReplacer("_", " ", "-", " ").Replace(title)
	return cleanText(title, 180)
}

func suggestedKind(duration float64) string {
	if duration >= 12*60 {
		return mediaKindSet
	}
	return mediaKindSong
}

func decodeMediaInput(w http.ResponseWriter, r *http.Request) (mediaInput, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input mediaInput
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid metadata"})
		return mediaInput{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid metadata"})
		return mediaInput{}, false
	}
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	if input.Kind != mediaKindSet && input.Kind != mediaKindSong {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be set or song"})
		return mediaInput{}, false
	}
	return input, true
}

func applyMediaInput(item *MediaItem, input mediaInput) error {
	item.Kind = input.Kind
	item.Title = cleanText(input.Title, 180)
	item.Subtitle = cleanText(input.Subtitle, 240)
	item.PlayedAt = cleanText(input.PlayedAt, 80)
	item.Tags = parseTags(input.Tags)
	item.TelegramURL = cleanTelegramURL(input.TelegramURL)
	if input.CoverPosition != nil {
		item.CoverPosition = cleanCoverPosition(*input.CoverPosition)
	}
	if input.CoverZoom != nil {
		item.CoverZoom = cleanCoverZoom(*input.CoverZoom)
	}
	if input.Kind == mediaKindSet {
		item.EventName = cleanText(input.EventName, 180)
		item.EventURL = cleanEventURL(input.EventURL)
		item.LocationURL = cleanLocationURL(input.LocationURL)
		item.Country = cleanText(input.Country, 100)
		item.City = cleanText(input.City, 100)
	} else {
		item.EventName, item.EventURL, item.LocationURL, item.Country, item.City = "", "", "", "", ""
	}
	if input.TimedContent != nil {
		timedContent, err := cleanTimedContent(input.Kind, *input.TimedContent)
		if err != nil {
			return err
		}
		item.TimedContent = timedContent
	}
	if item.Title == "" {
		return errors.New("title is required")
	}
	if input.EventURL != "" && item.EventURL == "" {
		return errors.New("event link must be an http or https URL")
	}
	if input.LocationURL != "" && item.LocationURL == "" {
		return errors.New("location must be a Google Maps link, coordinate pair, or Plus Code")
	}
	if input.TelegramURL != "" && item.TelegramURL == "" {
		return errors.New("telegram post must be a number or an http or https URL")
	}
	return nil
}

const (
	maxTimedEntries = 500
	maxLyricsRunes  = 100_000
	maxTimedMS      = int64(7 * 24 * time.Hour / time.Millisecond)
)

func cleanTimedContent(kind string, content TimedContent) (TimedContent, error) {
	if kind == mediaKindSet {
		return cleanSetTimedContent(content.Entries)
	}

	return cleanLyricsTimedContent(content)
}

func cleanSetTimedContent(entries []TimedEntry) (TimedContent, error) {
	if len(entries) > maxTimedEntries {
		return TimedContent{}, errors.New("song list is too long")
	}
	cleaned := TimedContent{Entries: make([]TimedEntry, 0, len(entries))}
	var previous int64 = -1
	for _, entry := range entries {
		entry.Text = cleanText(entry.Text, 180)
		if entry.Text == "" {
			continue
		}
		if entry.TimeMS < 0 || entry.TimeMS > maxTimedMS || entry.TimeMS <= previous {
			return TimedContent{}, errors.New("song start times must be ordered at least 1 millisecond apart")
		}
		previous = entry.TimeMS
		cleaned.Entries = append(cleaned.Entries, entry)
	}
	return cleaned, nil
}

func cleanLyricsTimedContent(content TimedContent) (TimedContent, error) {
	text := strings.ReplaceAll(content.Text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	hadBOM := strings.HasPrefix(text, "\ufeff")
	text = strings.TrimPrefix(text, "\ufeff")
	runes := []rune(text)
	if len(runes) > maxLyricsRunes {
		return TimedContent{}, errors.New("lyrics are too long")
	}
	if len(content.Markers) > maxTimedEntries || len(content.Pauses) > maxTimedEntries {
		return TimedContent{}, errors.New("lyrics have too many timing marks")
	}

	markers, err := cleanLyricsMarkers(content.Markers, hadBOM, len(runes))
	if err != nil {
		return TimedContent{}, err
	}
	pauses, err := cleanLyricsPauses(content.Pauses, hadBOM, len(runes))
	if err != nil {
		return TimedContent{}, err
	}
	if text == "" {
		markers = nil
		pauses = nil
	}
	return TimedContent{Text: text, Markers: markers, Pauses: pauses}, nil
}

func cleanLyricsMarkers(source []TextMarker, hadBOM bool, lyricLength int) ([]TextMarker, error) {
	markers := slices.Clone(source)
	if hadBOM {
		for index := range markers {
			if markers[index].Offset > 0 {
				markers[index].Offset--
			}
		}
	}
	slices.SortFunc(markers, func(left, right TextMarker) int {
		if order := cmp.Compare(left.Offset, right.Offset); order != 0 {
			return order
		}
		return cmp.Compare(left.TimeMS, right.TimeMS)
	})
	var previous *TextMarker
	for index := range markers {
		marker := markers[index]
		if marker.Offset < 0 || marker.Offset > lyricLength || marker.TimeMS < 0 ||
			marker.TimeMS > maxTimedMS || previous != nil && (marker.TimeMS < previous.TimeMS ||
			marker.TimeMS == previous.TimeMS && marker.Offset == previous.Offset) {
			return nil, errors.New(
				"lyrics markers must follow the text; equal times may only collapse a section",
			)
		}
		previous = &markers[index]
	}
	return markers, nil
}

func cleanLyricsPauses(source []int, hadBOM bool, lyricLength int) ([]int, error) {
	pauses := slices.Clone(source)
	if hadBOM {
		for index := range pauses {
			if pauses[index] > 0 {
				pauses[index]--
			}
		}
	}
	slices.Sort(pauses)
	pauses = slices.Compact(pauses)
	for _, offset := range pauses {
		if offset < 0 || offset > lyricLength {
			return nil, errors.New("lyrics pause is outside the text")
		}
	}
	return pauses, nil
}

func cleanCoverPosition(value string) string {
	parts := strings.Fields(value)
	if len(parts) != 2 {
		return defaultCoverPosition
	}
	coordinates := make([]int, 2)
	for index, part := range parts {
		if !strings.HasSuffix(part, "%") {
			return defaultCoverPosition
		}
		coordinate, err := strconv.Atoi(strings.TrimSuffix(part, "%"))
		if err != nil || coordinate < 0 || coordinate > 100 {
			return defaultCoverPosition
		}
		coordinates[index] = coordinate
	}
	return fmt.Sprintf("%d%% %d%%", coordinates[0], coordinates[1])
}

func cleanCoverZoom(value float64) float64 {
	if value < 1 {
		return 1
	}
	if value > 3 {
		return 3
	}
	return math.Round(value*100) / 100
}

func (a *App) publishMedia(w http.ResponseWriter, r *http.Request) {
	if !a.validOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid request origin"})
		return
	}
	input, ok := decodeMediaInput(w, r)
	if !ok {
		return
	}
	audioDraft, ready := a.readyUploadDraft(r.Context(), input.AudioUploadID, uploadKindAudio)
	if !ready {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "audio upload is not ready"})
		return
	}
	coverDraft, ready := a.readyUploadDraft(r.Context(), input.CoverUploadID, uploadKindCover)
	if !ready {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "cover upload is not ready"})
		return
	}
	if strings.TrimSpace(input.Title) == "" {
		input.Title = audioDraft.Title
	}
	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not allocate media item"})
		return
	}
	item := MediaItem{
		ID: id, DurationSeconds: audioDraft.DurationSeconds,
		CoverPosition: defaultCoverPosition, CoverZoom: 1, CreatedAt: time.Now().UTC(),
	}
	if inputErr := applyMediaInput(&item, input); inputErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": inputErr.Error()})
		return
	}
	item.AudioPath = filepath.ToSlash(filepath.Join(uploadKindAudio, id+filepath.Ext(audioDraft.Path)))
	item.CoverPath = filepath.ToSlash(filepath.Join("covers", id+filepath.Ext(coverDraft.Path)))
	item.WaveformPath = filepath.ToSlash(filepath.Join("waveforms", id+".json"))
	moves := [][2]string{
		{audioDraft.Path, item.AudioPath},
		{coverDraft.Path, item.CoverPath},
		{audioDraft.WaveformPath, item.WaveformPath},
	}
	journal := publishJournal{MediaID: id, Moves: moves, DraftIDs: []string{audioDraft.ID, coverDraft.ID}}
	operationContext, cancelOperation := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancelOperation()
	claimed, err := a.store.ClaimUploadsForPublishing(
		operationContext,
		audioDraft.ID,
		coverDraft.ID,
		time.Now().UTC(),
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not claim media uploads"})
		return
	}
	if !claimed {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "media uploads expired or are already publishing"})
		return
	}
	if err := a.finalizeMediaPublish(operationContext, item, journal); err != nil {
		slog.Error("publish media", "media_id", item.ID, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not publish media"})
		return
	}
	a.addMediaURLs(&item)
	writeJSON(w, http.StatusCreated, item)
}

func (a *App) readyUploadDraft(ctx context.Context, id, kind string) (UploadDraft, bool) {
	draft, err := a.store.GetUploadDraft(ctx, id)
	ready := err == nil && draft.Kind == kind && draft.State == uploadStateReady && !time.Now().After(draft.ExpiresAt)
	return draft, ready
}

func (a *App) finalizeMediaPublish(ctx context.Context, item MediaItem, journal publishJournal) error {
	journalKey := publishJournalPrefix + item.ID
	encoded, err := json.Marshal(journal)
	if err != nil {
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelCleanup()
		releaseErr := a.store.ReleasePublishingUploads(cleanupContext, journal.DraftIDs...)
		return errors.Join(fmt.Errorf("encode publish journal: %w", err), releaseErr)
	}
	if err := a.store.SetSetting(ctx, journalKey, string(encoded)); err != nil {
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelCleanup()
		releaseErr := a.store.ReleasePublishingUploads(cleanupContext, journal.DraftIDs...)
		return errors.Join(fmt.Errorf("save publish journal: %w", err), releaseErr)
	}
	completed := make([][2]string, 0, len(journal.Moves))
	for _, move := range journal.Moves {
		if moveErr := a.moveDataFile(move[0], move[1]); moveErr != nil {
			if a.rollbackMoves(completed) {
				cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
				moveErr = errors.Join(
					moveErr,
					a.store.DeleteSetting(cleanupContext, journalKey),
					a.store.ReleasePublishingUploads(cleanupContext, journal.DraftIDs...),
				)
				cancelCleanup()
			}
			return fmt.Errorf("move published asset %q to %q: %w", move[0], move[1], moveErr)
		}
		completed = append(completed, move)
	}
	if createErr := a.store.CreatePublished(ctx, item); createErr != nil {
		_, confirmErr := a.probeMediaAfterWrite(item.ID)
		switch {
		case confirmErr == nil:
			slog.Warn("publish database write returned an error after commit", "media_id", item.ID, "error", createErr)
		case !errors.Is(confirmErr, ErrNotFound):
			return errors.Join(
				fmt.Errorf("save published media metadata: %w", createErr),
				fmt.Errorf("confirm published media metadata: %w", confirmErr),
			)
		default:
			if a.rollbackMoves(completed) {
				cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
				createErr = errors.Join(
					createErr,
					a.store.DeleteSetting(cleanupContext, journalKey),
					a.store.ReleasePublishingUploads(cleanupContext, journal.DraftIDs...),
				)
				cancelCleanup()
			}
			return fmt.Errorf("save published media metadata: %w", createErr)
		}
	}
	if a.cleanupPublishedDrafts(ctx, item.ID, journal.DraftIDs) {
		if err := a.store.DeleteSetting(ctx, journalKey); err != nil {
			slog.Warn("remove completed publish journal", "media_id", item.ID, "error", err)
		}
	}
	return nil
}

func (a *App) editMedia(w http.ResponseWriter, r *http.Request, input mediaInput) {
	a.mediaEditMu.Lock()
	defer a.mediaEditMu.Unlock()
	operationContext, cancelOperation := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancelOperation()
	item, err := a.store.Get(operationContext, r.PathValue("id"))
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media item not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load media item"})
		return
	}
	if inputErr := applyMediaInput(&item, input); inputErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": inputErr.Error()})
		return
	}
	replacement, status, message := a.prepareCoverReplacement(operationContext, &item, input.CoverUploadID)
	if status != 0 {
		writeJSON(w, status, map[string]string{"error": message})
		return
	}
	updateErr := a.store.Update(operationContext, item)
	if updateErr != nil && replacement.active() {
		confirmed, confirmErr := a.probeMediaAfterWrite(item.ID)
		switch {
		case confirmErr == nil && confirmed.CoverPath == item.CoverPath:
			slog.Warn("cover database write returned an error after commit", "media_id", item.ID, "error", updateErr)
			item = confirmed
			updateErr = nil
		case confirmErr == nil || errors.Is(confirmErr, ErrNotFound):
			cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
			a.rollbackPreparedCoverReplacement(cleanupContext, replacement, item.CoverPath)
			cancelCleanup()
		default:
			slog.Warn(
				"leave ambiguous cover replacement for recovery",
				"media_id", item.ID,
				"write_error", updateErr,
				"confirm_error", confirmErr,
			)
		}
	}
	if updateErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not update metadata"})
		return
	}
	if replacement.active() {
		a.completePreparedCoverReplacement(operationContext, replacement)
	}
	a.addMediaURLs(&item)
	writeJSON(w, http.StatusOK, item)
}

func (a *App) prepareCoverReplacement(
	ctx context.Context,
	item *MediaItem,
	uploadID string,
) (preparedCoverReplacement, int, string) {
	if uploadID == "" {
		return preparedCoverReplacement{}, 0, ""
	}
	draft, ready := a.readyUploadDraft(ctx, uploadID, uploadKindCover)
	if !ready {
		return preparedCoverReplacement{}, http.StatusConflict, "cover upload is not ready"
	}
	claimed, err := a.store.ClaimUploadForPublishing(ctx, draft.ID, time.Now().UTC())
	if err != nil || !claimed {
		return preparedCoverReplacement{}, http.StatusConflict, "cover upload is already being published"
	}
	replacement := preparedCoverReplacement{
		draft:      draft,
		oldPath:    item.CoverPath,
		journalKey: coverReplacementJournalPrefix + item.ID + ":" + draft.ID,
	}
	coverName := item.ID + "-" + draft.ID + filepath.Ext(draft.Path)
	item.CoverPath = filepath.ToSlash(filepath.Join("covers", coverName))
	journal := coverReplacementJournal{
		MediaID: item.ID, DraftID: draft.ID, DraftPath: draft.Path,
		OldPath: replacement.oldPath, NewPath: item.CoverPath,
	}
	encoded, encodeErr := json.Marshal(journal)
	if encodeErr != nil || a.store.SetSetting(ctx, replacement.journalKey, string(encoded)) != nil {
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		_ = a.store.ReleasePublishingUploads(cleanupContext, draft.ID)
		cancelCleanup()
		return preparedCoverReplacement{}, http.StatusInternalServerError, "could not prepare cover replacement"
	}
	if moveErr := a.moveDataFile(draft.Path, item.CoverPath); moveErr != nil {
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		_ = a.store.DeleteSetting(cleanupContext, replacement.journalKey)
		_ = a.store.ReleasePublishingUploads(cleanupContext, draft.ID)
		cancelCleanup()
		return preparedCoverReplacement{}, http.StatusInternalServerError, "could not replace cover"
	}
	return replacement, 0, ""
}

func (replacement preparedCoverReplacement) active() bool {
	return replacement.draft.ID != ""
}

func (a *App) rollbackPreparedCoverReplacement(
	ctx context.Context,
	replacement preparedCoverReplacement,
	newPath string,
) {
	if a.rollbackMoves([][2]string{{replacement.draft.Path, newPath}}) {
		_ = a.store.DeleteSetting(ctx, replacement.journalKey)
		_ = a.store.ReleasePublishingUploads(ctx, replacement.draft.ID)
	}
}

func (a *App) completePreparedCoverReplacement(ctx context.Context, replacement preparedCoverReplacement) {
	complete := true
	oldPath, ok := a.dataPath(replacement.oldPath)
	if !ok {
		complete = false
	} else if removeErr := os.Remove(oldPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		complete = false
	}
	if deleteErr := a.store.DeleteUploadDraft(ctx, replacement.draft.ID); deleteErr != nil {
		complete = false
	}
	if complete {
		_ = a.store.DeleteSetting(ctx, replacement.journalKey)
	}
}

func (a *App) deleteMedia(w http.ResponseWriter, r *http.Request) {
	a.mediaEditMu.Lock()
	defer a.mediaEditMu.Unlock()
	if !a.validOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid request origin"})
		return
	}
	item, err := a.store.Get(r.Context(), r.PathValue("id"))
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media item not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load media item"})
		return
	}
	journal := deleteJournal{MediaID: item.ID}
	for _, relative := range []string{item.AudioPath, item.CoverPath, item.WaveformPath} {
		if relative != "" {
			journal.Paths = append(journal.Paths, relative)
		}
	}
	encoded, err := json.Marshal(journal)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not prepare media deletion"})
		return
	}
	operationContext, cancelOperation := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancelOperation()
	journalKey := deleteJournalPrefix + item.ID
	if err := a.store.SetSetting(operationContext, journalKey, string(encoded)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not prepare media deletion"})
		return
	}
	if deleteErr := a.store.Delete(operationContext, item.ID); deleteErr != nil &&
		!a.confirmDeletedAfterWriteError(item.ID, journalKey, deleteErr) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete media item"})
		return
	}
	cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
	if err := a.cleanupDeletedAssets(cleanupContext, journalKey, journal); err != nil {
		slog.Warn("finish media deletion", "media_id", item.ID, "error", err)
	}
	cancelCleanup()
	writeJSON(w, http.StatusOK, map[string]string{"deleted_id": item.ID})
}

func (a *App) confirmDeletedAfterWriteError(id, journalKey string, writeErr error) bool {
	_, confirmErr := a.probeMediaAfterWrite(id)
	switch {
	case errors.Is(confirmErr, ErrNotFound):
		slog.Warn("delete database write returned an error after commit", "media_id", id, "error", writeErr)
		return true
	case confirmErr == nil:
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelCleanup()
		if cleanupErr := a.store.DeleteSetting(cleanupContext, journalKey); cleanupErr != nil {
			slog.Warn("remove uncommitted deletion journal", "media_id", id, "error", cleanupErr)
		}
	default:
		slog.Warn(
			"leave ambiguous media deletion for recovery",
			"media_id", id,
			"write_error", writeErr,
			"confirm_error", confirmErr,
		)
	}
	return false
}

func (a *App) moveDataFile(sourceRelative, destinationRelative string) error {
	if sourceRelative == "" || destinationRelative == "" {
		return errors.New("missing stored file path")
	}
	source, ok := a.dataPath(sourceRelative)
	if !ok {
		return errors.New("invalid source path")
	}
	destination, ok := a.dataPath(destinationRelative)
	if !ok {
		return errors.New("invalid destination path")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return err
	}
	return os.Rename(source, destination)
}
