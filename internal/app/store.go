package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // Register the pgx database/sql driver.
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite" // Register the SQLite database/sql driver.
)

type MediaItem struct {
	ID              string    `json:"id"`
	Kind            string    `json:"kind"`
	Title           string    `json:"title"`
	Subtitle        string    `json:"subtitle,omitempty"`
	EventName       string    `json:"event_name,omitempty"`
	EventURL        string    `json:"event_url,omitempty"`
	PlayedAt        string    `json:"played_at,omitempty"`
	Country         string    `json:"country,omitempty"`
	City            string    `json:"city,omitempty"`
	Tags            []string  `json:"tags,omitempty"`
	TelegramURL     string    `json:"telegram_url,omitempty"`
	DurationSeconds float64   `json:"duration_seconds"`
	CoverURL        string    `json:"cover_url"`
	CoverPosition   string    `json:"cover_position"`
	CoverZoom       float64   `json:"cover_zoom"`
	AudioURL        string    `json:"audio_url"`
	WaveformURL     string    `json:"waveform_url"`
	CreatedAt       time.Time `json:"created_at"`
	AudioPath       string    `json:"-"`
	CoverPath       string    `json:"-"`
	WaveformPath    string    `json:"-"`
}

type mediaRecord struct {
	ID              string    `db:"id"`
	Kind            string    `db:"kind"`
	Title           string    `db:"title"`
	Subtitle        string    `db:"subtitle"`
	EventName       string    `db:"event_name"`
	EventURL        string    `db:"event_url"`
	PlayedAt        string    `db:"played_at"`
	Country         string    `db:"country"`
	City            string    `db:"city"`
	TagsJSON        string    `db:"tags_json"`
	TelegramURL     string    `db:"telegram_url"`
	DurationSeconds float64   `db:"duration_seconds"`
	AudioPath       string    `db:"audio_path"`
	CoverPath       string    `db:"cover_path"`
	CoverPosition   string    `db:"cover_position"`
	CoverZoom       float64   `db:"cover_zoom"`
	WaveformPath    string    `db:"waveform_path"`
	CreatedAt       time.Time `db:"created_at"`
}

func newMediaRecord(item MediaItem) (mediaRecord, error) {
	if item.CoverPosition == "" {
		item.CoverPosition = defaultCoverPosition
	}
	if item.CoverZoom < 1 {
		item.CoverZoom = 1
	}
	tags, err := json.Marshal(item.Tags)
	if err != nil {
		return mediaRecord{}, err
	}
	return mediaRecord{
		ID: item.ID, Kind: item.Kind, Title: item.Title, Subtitle: item.Subtitle,
		EventName: item.EventName, EventURL: item.EventURL, PlayedAt: item.PlayedAt,
		Country: item.Country, City: item.City, TagsJSON: string(tags), TelegramURL: item.TelegramURL,
		DurationSeconds: item.DurationSeconds, AudioPath: item.AudioPath, CoverPath: item.CoverPath,
		CoverPosition: item.CoverPosition, CoverZoom: item.CoverZoom,
		WaveformPath: item.WaveformPath, CreatedAt: item.CreatedAt,
	}, nil
}

func (record mediaRecord) mediaItem() (MediaItem, error) {
	item := MediaItem{
		ID: record.ID, Kind: record.Kind, Title: record.Title, Subtitle: record.Subtitle,
		EventName: record.EventName, EventURL: record.EventURL, PlayedAt: record.PlayedAt,
		Country: record.Country, City: record.City, TelegramURL: record.TelegramURL,
		DurationSeconds: record.DurationSeconds, AudioPath: record.AudioPath, CoverPath: record.CoverPath,
		CoverPosition: record.CoverPosition, CoverZoom: record.CoverZoom,
		WaveformPath: record.WaveformPath, CreatedAt: record.CreatedAt,
	}
	if err := json.Unmarshal([]byte(record.TagsJSON), &item.Tags); err != nil {
		return MediaItem{}, fmt.Errorf("decode tags for %s: %w", item.ID, err)
	}
	return item, nil
}

type Store struct {
	db       *sqlx.DB
	postgres bool
}

func (s *Store) PingContext(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

type UploadDraft struct {
	ID              string    `db:"id"`
	Kind            string    `db:"kind"`
	Path            string    `db:"path"`
	WaveformPath    string    `db:"waveform_path"`
	OriginalName    string    `db:"original_name"`
	Title           string    `db:"title"`
	DurationSeconds float64   `db:"duration_seconds"`
	State           string    `db:"state"`
	Error           string    `db:"error"`
	CreatedAt       time.Time `db:"created_at"`
	ExpiresAt       time.Time `db:"expires_at"`
}

func OpenStore(ctx context.Context, cfg DatabaseConfig) (*Store, error) {
	driver := databaseDriverSQLite
	if cfg.Driver == databaseDriverPostgres {
		driver = "pgx"
	}
	db, err := sqlx.Open(driver, cfg.DSN)
	if err != nil {
		return nil, err
	}
	if cfg.Driver == databaseDriverSQLite {
		db.SetMaxOpenConns(1)
	}
	store := &Store{db: db, postgres: cfg.Driver == databaseDriverPostgres}
	if err := db.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("connect %s: %w", cfg.Driver, err), db.Close())
	}
	if err := store.migrate(ctx); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    event_name TEXT NOT NULL DEFAULT '',
    event_url TEXT NOT NULL DEFAULT '',
    played_at TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    telegram_url TEXT NOT NULL DEFAULT '',
    duration_seconds DOUBLE PRECISION NOT NULL,
    audio_path TEXT NOT NULL,
    cover_path TEXT NOT NULL,
    cover_position TEXT NOT NULL DEFAULT '50% 50%',
    cover_zoom DOUBLE PRECISION NOT NULL DEFAULT 1,
    waveform_path TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS media_items_kind_created_idx ON media_items(kind, created_at DESC);`
	const supportSchema = `
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_drafts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    waveform_path TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'uploaded',
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL
);`
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, supportSchema); err != nil {
		return fmt.Errorf("migrate support tables: %w", err)
	}
	if err := s.ensureMediaCoverPosition(ctx); err != nil {
		return fmt.Errorf("migrate cover position: %w", err)
	}
	if err := s.ensureMediaCoverZoom(ctx); err != nil {
		return fmt.Errorf("migrate cover zoom: %w", err)
	}
	return nil
}

func (s *Store) ensureMediaCoverZoom(ctx context.Context) error {
	const postgresQuery = `ALTER TABLE media_items
ADD COLUMN IF NOT EXISTS cover_zoom DOUBLE PRECISION NOT NULL DEFAULT 1`
	const sqliteQuery = `ALTER TABLE media_items ADD COLUMN cover_zoom DOUBLE PRECISION NOT NULL DEFAULT 1`
	return s.ensureMediaColumn(ctx, "cover_zoom", postgresQuery, sqliteQuery)
}

func (s *Store) ensureMediaCoverPosition(ctx context.Context) error {
	const postgresQuery = `ALTER TABLE media_items
ADD COLUMN IF NOT EXISTS cover_position TEXT NOT NULL DEFAULT '50% 50%'`
	const sqliteQuery = `ALTER TABLE media_items ADD COLUMN cover_position TEXT NOT NULL DEFAULT '50% 50%'`
	return s.ensureMediaColumn(ctx, "cover_position", postgresQuery, sqliteQuery)
}

func (s *Store) ensureMediaColumn(ctx context.Context, name, postgresQuery, sqliteQuery string) error {
	if s.postgres {
		_, err := s.db.ExecContext(ctx, postgresQuery)
		return err
	}
	exists, err := s.sqliteMediaColumnExists(ctx, name)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	_, err = s.db.ExecContext(ctx, sqliteQuery)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return nil
	}
	return err
}

func (s *Store) sqliteMediaColumnExists(ctx context.Context, column string) (exists bool, returnErr error) {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(media_items)`)
	if err != nil {
		return false, err
	}
	defer func() {
		returnErr = errors.Join(returnErr, rows.Close())
	}()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if scanErr := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); scanErr != nil {
			return false, scanErr
		}
		if name == column {
			return true, nil
		}
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return false, rowsErr
	}
	return false, nil
}

func (s *Store) bind(query string) string {
	return s.db.Rebind(query)
}

const insertMediaQuery = `INSERT INTO media_items (
id, kind, title, subtitle, event_name, event_url, played_at, country, city,
tags_json, telegram_url, duration_seconds, audio_path, cover_path, cover_position, cover_zoom, waveform_path, created_at
) VALUES (
:id, :kind, :title, :subtitle, :event_name, :event_url, :played_at, :country, :city,
:tags_json, :telegram_url, :duration_seconds, :audio_path, :cover_path, :cover_position,
:cover_zoom, :waveform_path, :created_at
)`

func (s *Store) Create(ctx context.Context, item MediaItem) error {
	record, err := newMediaRecord(item)
	if err != nil {
		return err
	}
	_, err = s.db.NamedExecContext(ctx, insertMediaQuery, record)
	return err
}

func (s *Store) CreatePublished(ctx context.Context, item MediaItem) error {
	record, err := newMediaRecord(item)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	order, err := s.mediaOrderForUpdate(ctx, tx, item.Kind)
	if err != nil {
		return err
	}
	_, err = tx.NamedExecContext(ctx, insertMediaQuery, record)
	if err != nil {
		return err
	}
	order = slices.DeleteFunc(order, func(id string) bool { return id == item.ID })
	order = append([]string{item.ID}, order...)
	if err := s.setMediaOrder(ctx, tx, item.Kind, order); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ReplaceMediaOrder(ctx context.Context, kind string, ids []string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := s.mediaOrderForUpdate(ctx, tx, kind); err != nil {
		return err
	}
	var expectedIDs []string
	if err := tx.SelectContext(
		ctx, &expectedIDs, s.bind(`SELECT id FROM media_items WHERE kind = ?`), kind,
	); err != nil {
		return err
	}
	expected := make(map[string]bool, len(expectedIDs))
	for _, id := range expectedIDs {
		expected[id] = true
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !expected[id] || seen[id] {
			return ErrCatalogChanged
		}
		seen[id] = true
	}
	if len(seen) != len(expected) {
		return ErrCatalogChanged
	}
	if err := s.setMediaOrder(ctx, tx, kind, ids); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) mediaOrderForUpdate(ctx context.Context, tx *sqlx.Tx, kind string) ([]string, error) {
	key := mediaOrderSettingKey(kind)
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO app_settings (key, value) VALUES (?, '[]')
ON CONFLICT(key) DO NOTHING`), key); err != nil {
		return nil, err
	}
	query := s.bind(`SELECT value FROM app_settings WHERE key = ?`)
	if s.postgres {
		query += " FOR UPDATE"
	}
	var encoded string
	if err := tx.GetContext(ctx, &encoded, query, key); err != nil {
		return nil, err
	}
	var order []string
	if err := json.Unmarshal([]byte(encoded), &order); err != nil {
		return nil, fmt.Errorf("decode %s: %w", key, err)
	}
	return order, nil
}

func (s *Store) setMediaOrder(ctx context.Context, tx *sqlx.Tx, kind string, order []string) error {
	encoded, err := json.Marshal(order)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(
		ctx,
		s.bind(`UPDATE app_settings SET value = ? WHERE key = ?`),
		string(encoded),
		mediaOrderSettingKey(kind),
	)
	return err
}

func (s *Store) Update(ctx context.Context, item MediaItem) error {
	record, err := newMediaRecord(item)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var previousKind string
	query := s.bind(`SELECT kind FROM media_items WHERE id = ?`)
	if getErr := tx.GetContext(ctx, &previousKind, query, item.ID); getErr != nil {
		if errors.Is(getErr, sql.ErrNoRows) {
			return ErrNotFound
		}
		return getErr
	}
	result, err := tx.NamedExecContext(ctx, `UPDATE media_items SET
kind = :kind, title = :title, subtitle = :subtitle, event_name = :event_name,
event_url = :event_url, played_at = :played_at, country = :country, city = :city,
tags_json = :tags_json, telegram_url = :telegram_url, duration_seconds = :duration_seconds,
audio_path = :audio_path, cover_path = :cover_path, cover_position = :cover_position,
cover_zoom = :cover_zoom, waveform_path = :waveform_path WHERE id = :id`, record)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := s.reconcileMediaKind(ctx, tx, item.ID, previousKind, item.Kind); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) reconcileMediaKind(ctx context.Context, tx *sqlx.Tx, id, previousKind, currentKind string) error {
	if previousKind == currentKind {
		return nil
	}
	return s.removeKindSettings(ctx, tx, id, previousKind)
}

func (s *Store) removeKindSettings(ctx context.Context, tx *sqlx.Tx, id, kind string) error {
	if kind == mediaKindSet {
		if _, err := tx.ExecContext(ctx, s.bind(`UPDATE app_settings SET value = ''
WHERE key = 'featured_set_id' AND value = ?`), id); err != nil {
			return err
		}
	}
	order, err := s.mediaOrderForUpdate(ctx, tx, kind)
	if err != nil {
		return err
	}
	order = slices.DeleteFunc(order, func(orderedID string) bool { return orderedID == id })
	return s.setMediaOrder(ctx, tx, kind, order)
}

func (s *Store) Delete(ctx context.Context, id string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var kind string
	if getErr := tx.GetContext(ctx, &kind, s.bind(`SELECT kind FROM media_items WHERE id = ?`), id); getErr != nil {
		if errors.Is(getErr, sql.ErrNoRows) {
			return ErrNotFound
		}
		return getErr
	}
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM media_items WHERE id = ?`), id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if removeErr := s.removeKindSettings(ctx, tx, id, kind); removeErr != nil {
		return removeErr
	}
	return tx.Commit()
}

func (s *Store) CreateUploadDraft(ctx context.Context, draft UploadDraft) error {
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO upload_drafts (
id, kind, path, waveform_path, original_name, title, duration_seconds, state, error, created_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), draft.ID, draft.Kind, draft.Path,
		draft.WaveformPath, draft.OriginalName, draft.Title, draft.DurationSeconds,
		draft.State, draft.Error, draft.CreatedAt, draft.ExpiresAt)
	return err
}

func (s *Store) GetUploadDraft(ctx context.Context, id string) (UploadDraft, error) {
	var draft UploadDraft
	query := s.bind(`SELECT id, kind, path, waveform_path, original_name, title,
duration_seconds, state, error, created_at, expires_at
FROM upload_drafts WHERE id = ?`)
	err := s.db.GetContext(ctx, &draft, query, id)
	if errors.Is(err, sql.ErrNoRows) {
		return UploadDraft{}, ErrNotFound
	}
	return draft, err
}

func (s *Store) ClaimUploadAnalysis(ctx context.Context, id string) (bool, error) {
	query := s.bind(`UPDATE upload_drafts
SET state = 'analyzing', error = '' WHERE id = ? AND state = 'uploaded'`)
	result, err := s.db.ExecContext(ctx, query, id)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

func (s *Store) ClaimUploadsForPublishing(ctx context.Context, audioID, coverID string, now time.Time) (bool, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	ids := []string{audioID, coverID}
	query, arguments, err := sqlx.In(`UPDATE upload_drafts SET state = 'publishing'
WHERE id IN (?) AND state = 'ready' AND expires_at >= ?`, ids, now)
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(query), arguments...)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	if err != nil || count != int64(len(ids)) {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ClaimUploadForPublishing(ctx context.Context, id string, now time.Time) (bool, error) {
	result, err := s.db.ExecContext(ctx, s.bind(`UPDATE upload_drafts SET state = 'publishing'
WHERE id = ? AND state = 'ready' AND expires_at >= ?`), id, now)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

func (s *Store) ReleasePublishingUploads(ctx context.Context, ids ...string) error {
	if len(ids) == 0 {
		return nil
	}
	query, arguments, err := sqlx.In(`UPDATE upload_drafts
SET state = 'ready' WHERE id IN (?) AND state = 'publishing'`, ids)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, s.bind(query), arguments...)
	return err
}

func (s *Store) ResetPublishingUploadsExcept(ctx context.Context, protectedIDs []string) error {
	query := `UPDATE upload_drafts SET state = 'ready' WHERE state = 'publishing'`
	var arguments []any
	if len(protectedIDs) > 0 {
		var err error
		query, arguments, err = sqlx.In(query+` AND id NOT IN (?)`, protectedIDs)
		if err != nil {
			return err
		}
	}
	_, err := s.db.ExecContext(ctx, s.bind(query), arguments...)
	return err
}

func (s *Store) RecoverAudioUploads(ctx context.Context, now time.Time) ([]string, error) {
	if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE upload_drafts SET state = 'uploaded', error = ''
WHERE kind = 'audio' AND state IN ('analyzing', 'waveform')`)); err != nil {
		return nil, err
	}
	var ids []string
	if err := s.db.SelectContext(ctx, &ids, s.bind(`SELECT id FROM upload_drafts
WHERE kind = 'audio' AND state = 'uploaded' AND expires_at >= ? ORDER BY created_at`), now); err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *Store) NextAudioUpload(ctx context.Context, now time.Time) (string, error) {
	var id string
	err := s.db.GetContext(ctx, &id, s.bind(`SELECT id FROM upload_drafts
WHERE kind = 'audio' AND state = 'uploaded' AND expires_at >= ? ORDER BY created_at LIMIT 1`), now)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func (s *Store) RetryUploadAnalysis(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE upload_drafts SET state = 'uploaded', error = ''
WHERE id = ? AND state IN ('analyzing', 'waveform')`), id)
	return err
}

func (s *Store) CompleteUploadMetadata(ctx context.Context, id, title string, duration float64) error {
	query := s.bind(`UPDATE upload_drafts
SET state = 'waveform', title = ?, duration_seconds = ?, error = '' WHERE id = ?`)
	result, err := s.db.ExecContext(ctx, query, title, duration, id)
	return requireAffected(result, err)
}

func (s *Store) CompleteUploadAnalysis(ctx context.Context, id, title, waveformPath string, duration float64) error {
	query := s.bind(`UPDATE upload_drafts
SET state = 'ready', title = ?, waveform_path = ?, duration_seconds = ?, error = ''
WHERE id = ?`)
	result, err := s.db.ExecContext(ctx, query, title, waveformPath, duration, id)
	return requireAffected(result, err)
}

func requireAffected(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) FailUploadAnalysis(ctx context.Context, id, message string) error {
	query := s.bind(`UPDATE upload_drafts SET state = 'failed', error = ? WHERE id = ?`)
	_, err := s.db.ExecContext(ctx, query, message, id)
	return err
}

func (s *Store) DeleteUploadDraft(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM upload_drafts WHERE id = ?`), id)
	return err
}

func (s *Store) ExpiredUploadDrafts(ctx context.Context, before time.Time) ([]UploadDraft, error) {
	var drafts []UploadDraft
	if err := s.db.SelectContext(ctx, &drafts, s.bind(`SELECT id, kind, path, waveform_path,
original_name, title, duration_seconds, state, error, created_at, expires_at
FROM upload_drafts WHERE expires_at < ? AND state IN ('uploaded', 'ready', 'failed')`), before); err != nil {
		return nil, err
	}
	return drafts, nil
}

func (s *Store) GetSetting(ctx context.Context, key, fallback string) (string, error) {
	var value string
	err := s.db.GetContext(ctx, &value, s.bind(`SELECT value FROM app_settings WHERE key = ?`), key)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil
	}
	return value, err
}

func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO app_settings (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`), key, value)
	return err
}

func (s *Store) DeleteSetting(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM app_settings WHERE key = ?`), key)
	return err
}

func (s *Store) SettingsWithPrefix(ctx context.Context, prefix string) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT key, value FROM app_settings WHERE key LIKE ?`), prefix+"%")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	settings := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		settings[key] = value
	}
	return settings, rows.Err()
}

const selectMediaColumns = `id, kind, title, subtitle, event_name, event_url, played_at,
country, city, tags_json, telegram_url, duration_seconds, audio_path, cover_path,
cover_position, cover_zoom, waveform_path, created_at`

func (s *Store) List(ctx context.Context, kind string) ([]MediaItem, error) {
	query := s.bind(`SELECT ` + selectMediaColumns + `
FROM media_items WHERE kind = ? ORDER BY created_at DESC`)
	rows, err := s.db.QueryxContext(ctx, query, kind)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := make([]MediaItem, 0)
	for rows.Next() {
		var record mediaRecord
		if err := rows.StructScan(&record); err != nil {
			return nil, err
		}
		item, err := record.mediaItem()
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) Get(ctx context.Context, id string) (MediaItem, error) {
	var record mediaRecord
	err := s.db.GetContext(ctx, &record, s.bind(`SELECT `+selectMediaColumns+` FROM media_items WHERE id = ?`), id)
	if errors.Is(err, sql.ErrNoRows) {
		return MediaItem{}, ErrNotFound
	}
	if err != nil {
		return MediaItem{}, err
	}
	return record.mediaItem()
}

func (s *Store) UpdateAnalysis(ctx context.Context, id string, duration float64, waveformPath string) error {
	query := s.bind(`UPDATE media_items SET duration_seconds = ?, waveform_path = ? WHERE id = ?`)
	result, err := s.db.ExecContext(ctx, query, duration, waveformPath, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	return err
}

var (
	ErrNotFound       = errors.New("not found")
	ErrCatalogChanged = errors.New("catalog changed")
)
