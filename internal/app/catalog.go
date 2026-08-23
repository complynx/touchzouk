package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (a *App) sortCatalog(ctx context.Context, kind string, items []MediaItem) {
	if a.sortBySavedOrder(ctx, kind, items) {
		return
	}
	sort.SliceStable(items, func(left, right int) bool {
		return mediaDate(items[left]).After(mediaDate(items[right]))
	})
}

func (a *App) sortBySavedOrder(ctx context.Context, kind string, items []MediaItem) bool {
	order, err := a.mediaOrder(ctx, kind)
	if err != nil {
		slog.Warn("load saved media order", "kind", kind, "error", err)
		return false
	}
	if len(order) == 0 {
		return false
	}
	positions := make(map[string]int, len(order))
	for index, id := range order {
		positions[id] = index
	}
	sort.SliceStable(items, func(left, right int) bool {
		leftPosition, leftKnown := positions[items[left].ID]
		rightPosition, rightKnown := positions[items[right].ID]
		if leftKnown != rightKnown {
			return leftKnown
		}
		if leftKnown {
			return leftPosition < rightPosition
		}
		return mediaDate(items[left]).After(mediaDate(items[right]))
	})
	return true
}

func mediaOrderSettingKey(kind string) string {
	return kind + "_order"
}

func (a *App) mediaOrder(ctx context.Context, kind string) ([]string, error) {
	encoded, err := a.store.GetSetting(ctx, mediaOrderSettingKey(kind), "[]")
	if err != nil {
		return nil, fmt.Errorf("load %s order: %w", kind, err)
	}
	var order []string
	if err := json.Unmarshal([]byte(encoded), &order); err != nil {
		return nil, fmt.Errorf("decode %s order: %w", kind, err)
	}
	return order, nil
}

var (
	yearPattern    = regexp.MustCompile(`\b(18|19|20)\d{2}\b`)
	dayPattern     = regexp.MustCompile(`\b([0-3]?\d)\b`)
	isoDatePattern = regexp.MustCompile(`\b(?:18|19|20)\d{2}-\d{2}(?:-\d{2})?\b`)
	clockPattern   = regexp.MustCompile(`\b([01]?\d|2[0-3]):([0-5]\d)\b`)
)

func mediaDate(item MediaItem) time.Time {
	value := strings.ToLower(item.PlayedAt)
	if iso := isoDatePattern.FindString(value); iso != "" {
		layout := "2006-01"
		if len(iso) == len("2006-01-02") {
			layout = "2006-01-02"
		}
		parsed, err := time.Parse(layout, iso)
		if err != nil {
			return item.CreatedAt
		}
		if clock := clockPattern.FindStringSubmatch(value); len(clock) == 3 {
			hour, _ := strconv.Atoi(clock[1])
			minute, _ := strconv.Atoi(clock[2])
			parsed = parsed.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute)
		}
		return parsed
	}
	yearText := yearPattern.FindString(value)
	if yearText == "" {
		return item.CreatedAt
	}
	year, _ := strconv.Atoi(yearText)
	month := time.January
	months := []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
	for index, name := range months {
		if strings.Contains(value, name) {
			month = time.Month(index + 1)
			break
		}
	}
	switch {
	case strings.Contains(value, "spring"):
		month = time.March
	case strings.Contains(value, "summer"):
		month = time.June
	case strings.Contains(value, "autumn"), strings.Contains(value, "fall"):
		month = time.September
	case strings.Contains(value, "winter"):
		month = time.December
	}
	day := 1
	withoutYear := strings.Replace(value, yearText, "", 1)
	withoutYear = clockPattern.ReplaceAllString(withoutYear, "")
	if dayText := dayPattern.FindString(withoutYear); dayText != "" {
		if parsed, err := strconv.Atoi(dayText); err == nil && parsed >= 1 && parsed <= 31 {
			day = parsed
		}
	}
	hour, minute := 0, 0
	if clock := clockPattern.FindStringSubmatch(value); len(clock) == 3 {
		hour, _ = strconv.Atoi(clock[1])
		minute, _ = strconv.Atoi(clock[2])
	}
	return time.Date(year, month, day, hour, minute, 0, 0, time.UTC)
}

func (a *App) adminSettings(w http.ResponseWriter, r *http.Request) {
	pinned, err := a.store.GetSetting(r.Context(), "featured_set_id", "")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load settings"})
		return
	}
	settings := map[string]any{"featured_set_id": pinned}
	for _, kind := range []string{mediaKindSet, mediaKindSong} {
		order, orderErr := a.mediaOrder(r.Context(), kind)
		if orderErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load settings"})
			return
		}
		settings[mediaOrderSettingKey(kind)] = order
	}
	writeJSON(w, http.StatusOK, settings)
}

func (a *App) updateMediaOrder(w http.ResponseWriter, r *http.Request, kind string) {
	if !a.validOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid request origin"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var input struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid " + kind + " order"})
		return
	}
	if err := a.store.ReplaceMediaOrder(r.Context(), kind, input.IDs); errors.Is(err, ErrCatalogChanged) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": kind + " list changed; reload before reordering"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save " + kind + " order"})
		return
	}
	key := mediaOrderSettingKey(kind)
	writeJSON(w, http.StatusOK, map[string]any{key: input.IDs})
}

func (a *App) updateSetOrder(w http.ResponseWriter, r *http.Request) {
	a.updateMediaOrder(w, r, mediaKindSet)
}

func (a *App) updateSongOrder(w http.ResponseWriter, r *http.Request) {
	a.updateMediaOrder(w, r, mediaKindSong)
}

func (a *App) pinMedia(w http.ResponseWriter, r *http.Request) {
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
	if item.Kind != mediaKindSet {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only a published set can be pinned"})
		return
	}
	current, err := a.store.GetSetting(r.Context(), "featured_set_id", "")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load pinned set"})
		return
	}
	next := item.ID
	if current == item.ID {
		next = ""
	}
	if err := a.store.SetSetting(r.Context(), "featured_set_id", next); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not pin set"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"featured_set_id": next})
}
