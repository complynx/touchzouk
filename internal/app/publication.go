package app

import (
	"errors"
	"net/http"
	"slices"
	"time"
)

type publicationInput struct {
	Hidden    bool       `json:"hidden"`
	PublishAt *time.Time `json:"publish_at"`
}

func applyPublication(item *MediaItem, input *publicationInput) error {
	if input == nil {
		return nil
	}
	if input.Hidden && input.PublishAt != nil {
		return errors.New("hidden media cannot have a publication time")
	}
	if input.PublishAt != nil && !input.PublishAt.After(time.Now()) {
		return errors.New("publication time must be in the future")
	}
	item.Hidden, item.PublishAt = input.Hidden, nil
	if input.PublishAt != nil {
		utc := input.PublishAt.UTC()
		item.PublishAt = &utc
	}
	return nil
}

// Publication is evaluated on each request, so schedules survive server restarts.
func (item MediaItem) isPublic(now time.Time) bool {
	return !item.Hidden && (item.PublishAt == nil || !item.PublishAt.After(now))
}

func publicMedia(items []MediaItem, previewID string) []MediaItem {
	now := time.Now()
	return slices.DeleteFunc(items, func(item MediaItem) bool {
		return !item.isPublic(now) && (previewID == "" || item.ID != previewID)
	})
}

func (a *App) canReadMedia(r *http.Request, item MediaItem) bool {
	if item.isPublic(time.Now()) {
		return true
	}
	_, admin := a.auth.Identity(r)
	return admin
}
