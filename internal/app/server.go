package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // Register JPEG cover decoding.
	_ "image/png"  // Register PNG cover decoding.
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type App struct {
	cfg           Config
	store         *Store
	auth          *Authenticator
	analyzer      Analyzer
	analysisSlots chan struct{}
	coverSlots    chan struct{}
	audioWake     chan struct{}
	workerContext context.Context
	stopWorkers   context.CancelFunc
	workerWG      sync.WaitGroup
	mediaEditMu   sync.Mutex
	handler       http.Handler
}

func New(ctx context.Context, cfg Config) (*App, error) {
	for _, directory := range []string{
		cfg.DataDir,
		filepath.Join(cfg.DataDir, uploadKindAudio),
		filepath.Join(cfg.DataDir, "covers"),
		filepath.Join(cfg.DataDir, "waveforms"),
		filepath.Join(cfg.DataDir, "uploads", uploadKindAudio),
		filepath.Join(cfg.DataDir, "uploads", "covers"),
		filepath.Join(cfg.DataDir, "uploads", "waveforms"),
	} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return nil, fmt.Errorf("create data directory: %w", err)
		}
	}
	if _, err := os.Stat(cfg.SiteDir); err != nil {
		return nil, fmt.Errorf("site directory: %w", err)
	}
	store, err := OpenStore(ctx, cfg.Database)
	if err != nil {
		return nil, err
	}
	auth, err := NewAuthenticator(ctx, cfg.Auth)
	if err != nil {
		return nil, errors.Join(err, store.Close())
	}
	workerContext, stopWorkers := context.WithCancel(context.Background())
	application := &App{
		cfg: cfg, store: store, auth: auth,
		analyzer:      FFmpegAnalyzer{FFmpegPath: cfg.Media.FFmpegPath, FFprobePath: cfg.Media.FFprobePath},
		analysisSlots: make(chan struct{}, 1),
		coverSlots:    make(chan struct{}, 1),
		audioWake:     make(chan struct{}, 1),
		workerContext: workerContext,
		stopWorkers:   stopWorkers,
	}
	application.handler = application.routes()
	protectedDrafts, err := application.recoverPublishing(ctx)
	if err != nil {
		stopWorkers()
		return nil, errors.Join(fmt.Errorf("recover interrupted publish: %w", err), store.Close())
	}
	coverDrafts, err := application.recoverCoverReplacements(ctx)
	if err != nil {
		stopWorkers()
		return nil, errors.Join(fmt.Errorf("recover interrupted cover replacement: %w", err), store.Close())
	}
	if deleteErr := application.recoverDeletions(ctx); deleteErr != nil {
		stopWorkers()
		return nil, errors.Join(fmt.Errorf("recover interrupted deletion: %w", deleteErr), store.Close())
	}
	protectedDrafts = append(protectedDrafts, coverDrafts...)
	if resetErr := application.store.ResetPublishingUploadsExcept(ctx, protectedDrafts); resetErr != nil {
		stopWorkers()
		return nil, errors.Join(fmt.Errorf("release interrupted publish claims: %w", resetErr), store.Close())
	}
	ids, err := application.store.RecoverAudioUploads(ctx, time.Now().UTC())
	if err != nil {
		stopWorkers()
		return nil, errors.Join(fmt.Errorf("recover staged audio analysis: %w", err), store.Close())
	}
	application.cleanupExpiredUploads(ctx)
	application.workerWG.Go(func() {
		application.runAudioAnalysis(workerContext)
	})
	if len(ids) > 0 {
		application.wakeAudioAnalysis()
	}
	application.workerWG.Go(func() {
		application.runUploadCleanup(workerContext)
	})
	return application, nil
}

func (a *App) runUploadCleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			a.cleanupExpiredUploads(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (a *App) Close() error {
	a.stopWorkers()
	a.workerWG.Wait()
	return a.store.Close()
}
func (a *App) Handler() http.Handler { return a.handler }

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := a.store.PingContext(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /auth/login", a.auth.Login)
	mux.HandleFunc("GET /auth/callback", a.auth.Callback)
	mux.HandleFunc("POST /auth/logout", a.logout)
	mux.Handle("GET /admin", a.auth.RequireAdmin(http.HandlerFunc(a.serveAdmin)))
	mux.HandleFunc("GET /admin.html", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /listen", a.serveListen)
	mux.HandleFunc("GET /listen/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/listen", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /api/media", a.listMedia)
	mux.HandleFunc("GET /api/featured", a.featuredMedia)
	mux.HandleFunc("GET /media/{id}/{asset}", a.serveMedia)
	mux.Handle("GET /api/admin/me", a.auth.RequireAdmin(http.HandlerFunc(a.adminMe)))
	mux.Handle("GET /api/admin/settings", a.auth.RequireAdmin(http.HandlerFunc(a.adminSettings)))
	mux.Handle("PUT /api/admin/settings/set-order", a.auth.RequireAdmin(http.HandlerFunc(a.updateSetOrder)))
	mux.Handle("PUT /api/admin/settings/song-order", a.auth.RequireAdmin(http.HandlerFunc(a.updateSongOrder)))
	mux.Handle("POST /api/admin/uploads/audio", a.auth.RequireAdmin(http.HandlerFunc(a.uploadAudioDraft)))
	mux.Handle("POST /api/admin/uploads/cover", a.auth.RequireAdmin(http.HandlerFunc(a.uploadCoverDraft)))
	mux.Handle("GET /api/admin/uploads/{id}", a.auth.RequireAdmin(http.HandlerFunc(a.uploadDraftStatus)))
	mux.Handle("GET /api/admin/uploads/{id}/asset", a.auth.RequireAdmin(http.HandlerFunc(a.serveUploadDraft)))
	mux.Handle("GET /api/admin/uploads/{id}/waveform", a.auth.RequireAdmin(http.HandlerFunc(a.serveUploadWaveform)))
	mux.Handle("POST /api/admin/media", a.auth.RequireAdmin(http.HandlerFunc(a.publishMedia)))
	mux.Handle("POST /api/admin/media/{id}/pin", a.auth.RequireAdmin(http.HandlerFunc(a.pinMedia)))
	mux.Handle("POST /api/admin/media/{id}/waveform", a.auth.RequireAdmin(http.HandlerFunc(a.regenerateWaveform)))
	mux.Handle("PATCH /api/admin/media/{id}", a.auth.RequireAdmin(http.HandlerFunc(a.updateMedia)))
	mux.Handle("DELETE /api/admin/media/{id}", a.auth.RequireAdmin(http.HandlerFunc(a.deleteMedia)))
	mux.Handle("/", http.FileServer(http.Dir(a.cfg.SiteDir)))
	return securityHeaders(requestLogger(mux))
}

func (a *App) serveAdmin(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, filepath.Join(a.cfg.SiteDir, "admin.html"))
}

func (a *App) serveListen(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, filepath.Join(a.cfg.SiteDir, "listen.html"))
}

func (a *App) adminMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, identityFromContext(r.Context()))
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	if !a.validOrigin(r) {
		http.Error(w, "invalid request origin", http.StatusForbidden)
		return
	}
	a.auth.Logout(w, r)
}

func (a *App) listMedia(w http.ResponseWriter, r *http.Request) {
	kind := strings.ToLower(r.URL.Query().Get("kind"))
	if kind == "" {
		kind = mediaKindSet
	}
	if kind != mediaKindSet && kind != mediaKindSong {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be set or song"})
		return
	}
	items, err := a.store.List(r.Context(), kind)
	if err != nil {
		slog.Error("list media", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load the sound atlas"})
		return
	}
	a.sortCatalog(r.Context(), kind, items)
	for index := range items {
		a.addMediaURLs(&items[index])
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) featuredMedia(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.List(r.Context(), mediaKindSet)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load featured set"})
		return
	}
	if len(items) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no sets published"})
		return
	}
	a.sortCatalog(r.Context(), mediaKindSet, items)
	pinnedID, err := a.store.GetSetting(r.Context(), "featured_set_id", "")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load featured set"})
		return
	}
	featured := items[0]
	for _, item := range items {
		if item.ID == pinnedID {
			featured = item
			break
		}
	}
	a.addMediaURLs(&featured)
	writeJSON(w, http.StatusOK, featured)
}

func (a *App) regenerateWaveform(w http.ResponseWriter, r *http.Request) {
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
	audioPath, ok := a.dataPath(item.AudioPath)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "invalid stored media path"})
		return
	}
	analysisContext, cancelAnalysis := context.WithCancel(r.Context())
	stopWorkerCancel := context.AfterFunc(a.workerContext, cancelAnalysis)
	defer func() {
		stopWorkerCancel()
		cancelAnalysis()
	}()
	analysis, err := a.analyze(analysisContext, audioPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "audio analysis failed: " + err.Error()})
		return
	}
	a.mediaEditMu.Lock()
	defer a.mediaEditMu.Unlock()
	if _, err := a.store.Get(r.Context(), item.ID); errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media item not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load media item"})
		return
	}
	waveformRelative := filepath.ToSlash(filepath.Join("waveforms", item.ID+".json"))
	waveformPath, _ := a.dataPath(waveformRelative)
	if err := writeWaveform(waveformPath, analysis); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not write waveform cache"})
		return
	}
	if err := a.store.UpdateAnalysis(analysisContext, item.ID, analysis.DurationSeconds, waveformRelative); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not update analysis metadata"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":               item.ID,
		"duration_seconds": analysis.DurationSeconds,
		"waveform_url":     "/media/" + item.ID + "/waveform",
	})
}

func (a *App) updateMedia(w http.ResponseWriter, r *http.Request) {
	if !a.validOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid request origin"})
		return
	}
	input, ok := decodeMediaInput(w, r)
	if !ok {
		return
	}
	a.editMedia(w, r, input)
}

func (a *App) serveMedia(w http.ResponseWriter, r *http.Request) {
	item, err := a.store.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var relative string
	switch r.PathValue("asset") {
	case uploadKindAudio:
		relative = item.AudioPath
		w.Header().Set("Cache-Control", "public, max-age=3600")
	case uploadKindCover:
		relative = item.CoverPath
		w.Header().Set("Cache-Control", "no-cache")
	case "waveform":
		relative = item.WaveformPath
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
	default:
		http.NotFound(w, r)
		return
	}
	path, ok := a.dataPath(relative)
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
}

func (a *App) addMediaURLs(item *MediaItem) {
	item.AudioURL = "/media/" + item.ID + "/audio"
	item.CoverURL = "/media/" + item.ID + "/cover"
	item.WaveformURL = "/media/" + item.ID + "/waveform"
}

func (a *App) analyze(ctx context.Context, audioPath string) (Analysis, error) {
	return a.withAnalysisSlot(ctx, func(analysisCtx context.Context) (Analysis, error) {
		return a.analyzer.Analyze(analysisCtx, audioPath, a.cfg.Media.WaveformPoints)
	})
}

func (a *App) probeAudio(ctx context.Context, analyzer stagedAnalyzer, audioPath string) (Analysis, error) {
	return a.withAnalysisSlot(ctx, func(analysisCtx context.Context) (Analysis, error) {
		return analyzer.Probe(analysisCtx, audioPath)
	})
}

func (a *App) analyzeStagedWaveform(
	ctx context.Context,
	analyzer stagedAnalyzer,
	audioPath string,
	metadata Analysis,
) (Analysis, error) {
	return a.withAnalysisSlot(ctx, func(analysisCtx context.Context) (Analysis, error) {
		return analyzer.AnalyzeWaveform(analysisCtx, audioPath, a.cfg.Media.WaveformPoints, metadata)
	})
}

func (a *App) withAnalysisSlot(ctx context.Context, run func(context.Context) (Analysis, error)) (Analysis, error) {
	analysisCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	select {
	case a.analysisSlots <- struct{}{}:
		defer func() { <-a.analysisSlots }()
	case <-analysisCtx.Done():
		return Analysis{}, analysisCtx.Err()
	}
	return run(analysisCtx)
}

func (a *App) dataPath(relative string) (string, bool) {
	if relative == "" || filepath.IsAbs(relative) {
		return "", false
	}
	base, err := filepath.Abs(a.cfg.DataDir)
	if err != nil {
		return "", false
	}
	target, err := filepath.Abs(filepath.Join(base, filepath.FromSlash(relative)))
	if err != nil || (target != base && !strings.HasPrefix(target, base+string(filepath.Separator))) {
		return "", false
	}
	return target, true
}

func (a *App) validOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return a.cfg.Auth.Mode == authModeStub
	}
	want, err := url.Parse(a.cfg.Server.PublicURL)
	if err != nil {
		return false
	}
	got, err := url.Parse(origin)
	return err == nil && strings.EqualFold(got.Scheme, want.Scheme) && strings.EqualFold(got.Host, want.Host)
}

const maximumCoverPixels = 16_000_000

func validateCover(path, extension, ffmpegPath, ffprobePath string) error {
	contents, err := sniffFile(path)
	if err != nil {
		return err
	}
	if !coverContentsMatchExtension(contents, extension) {
		return errors.New("cover contents do not match its file extension")
	}
	if extension == extensionJPG || extension == extensionJPEG || extension == extensionPNG {
		return validateStandardCover(path)
	}
	return validateFFmpegCover(path, ffmpegPath, ffprobePath)
}

func coverContentsMatchExtension(contents []byte, extension string) bool {
	switch extension {
	case extensionJPG, extensionJPEG:
		return len(contents) >= 3 && contents[0] == 0xff && contents[1] == 0xd8 && contents[2] == 0xff
	case extensionPNG:
		return len(contents) >= 8 && string(contents[:8]) == "\x89PNG\r\n\x1a\n"
	case ".webp":
		return len(contents) >= 12 && string(contents[:4]) == "RIFF" && string(contents[8:12]) == "WEBP"
	case ".avif":
		return len(contents) >= 12 && string(contents[4:8]) == "ftyp" &&
			(strings.Contains(string(contents[8:]), "avif") || strings.Contains(string(contents[8:]), "avis"))
	}
	return false
}

func validateStandardCover(path string) error {
	file, openErr := os.Open(path)
	if openErr != nil {
		return openErr
	}
	config, _, decodeConfigErr := image.DecodeConfig(file)
	tooLarge := int64(config.Width)*int64(config.Height) > maximumCoverPixels
	if decodeConfigErr != nil || config.Width < 1 || config.Height < 1 || tooLarge {
		_ = file.Close()
		return errors.New("cover is truncated or not a decodable image")
	}
	if _, seekErr := file.Seek(0, io.SeekStart); seekErr != nil {
		_ = file.Close()
		return seekErr
	}
	if _, _, decodeErr := image.Decode(file); decodeErr != nil {
		_ = file.Close()
		return errors.New("cover is truncated or not a decodable image")
	}
	return file.Close()
}

func validateFFmpegCover(path, ffmpegPath, ffprobePath string) error {
	probeContext, cancelProbe := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelProbe()
	output, err := exec.CommandContext(
		probeContext,
		ffprobePath,
		"-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
	).Output()
	if err != nil {
		return errors.New("cover is truncated or not a decodable image")
	}
	dimensions := strings.Split(strings.TrimSpace(string(output)), "x")
	if len(dimensions) != 2 {
		return errors.New("cover is truncated or not a decodable image")
	}
	width, widthErr := strconv.ParseInt(dimensions[0], 10, 64)
	height, heightErr := strconv.ParseInt(dimensions[1], 10, 64)
	if widthErr != nil || heightErr != nil || width < 1 || height < 1 || width > maximumCoverPixels/height {
		return errors.New("cover is truncated or not a decodable image")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(
		ctx,
		ffmpegPath,
		"-v", "error", "-i", path, "-frames:v", "1", "-f", "null", "-",
	)
	if err := command.Run(); err != nil {
		return errors.New("cover is truncated or not a decodable image")
	}
	return nil
}

func cleanText(value string, maximum int) string {
	value = strings.TrimSpace(strings.Join(strings.Fields(value), " "))
	runes := []rune(value)
	if len(runes) > maximum {
		value = string(runes[:maximum])
	}
	return value
}

func cleanURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 2048 {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return ""
	}
	return parsed.String()
}

func cleanEventURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return cleanURL(defaultHTTPS(value))
}

func defaultHTTPS(value string) string {
	lower := strings.ToLower(value)
	switch {
	case strings.HasPrefix(value, "//"):
		return "https:" + value
	case strings.HasPrefix(lower, "http://"):
		return "http://" + value[len("http://"):]
	case strings.HasPrefix(lower, "https://"):
		return "https://" + value[len("https://"):]
	default:
		return "https://" + value
	}
}

var coordinatePairPattern = regexp.MustCompile(`^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:,\s*|\s+)([+-]?(?:\d+(?:\.\d+)?|\.\d+))$`)

const plusCodeAlphabet = "23456789CFGHJMPQRVWX"

func isValidPlusCode(code string) bool {
	code = strings.ToUpper(code)
	separator := strings.IndexByte(code, '+')
	if len(code) < 2 || separator < 0 || separator != strings.LastIndexByte(code, '+') || separator > 8 || separator%2 != 0 {
		return false
	}
	suffixLength := len(code) - separator - 1
	if suffixLength == 1 || separator+suffixLength > 15 {
		return false
	}
	paddingStart := strings.IndexByte(code, '0')
	paddingEnd := paddingStart
	if paddingStart >= 0 {
		for paddingEnd < separator && code[paddingEnd] == '0' {
			paddingEnd++
		}
		paddingLength := paddingEnd - paddingStart
		if separator != 8 || paddingStart == 0 || paddingEnd != separator || paddingLength%2 != 0 || suffixLength != 0 {
			return false
		}
	}
	for index := range len(code) {
		character := code[index]
		if character == '+' || (paddingStart >= 0 && index >= paddingStart && index < paddingEnd) {
			continue
		}
		if !strings.ContainsRune(plusCodeAlphabet, rune(character)) {
			return false
		}
	}
	return true
}

func cleanLocationURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 2048 {
		return ""
	}
	if match := coordinatePairPattern.FindStringSubmatch(value); match != nil {
		latitude, latitudeErr := strconv.ParseFloat(match[1], 64)
		longitude, longitudeErr := strconv.ParseFloat(match[2], 64)
		if latitudeErr != nil || longitudeErr != nil || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 {
			return ""
		}
		coordinates := strconv.FormatFloat(latitude, 'f', -1, 64) + "," + strconv.FormatFloat(longitude, 'f', -1, 64)
		return googleMapsSearchURL(coordinates)
	}
	fields := strings.Fields(value)
	if len(fields) > 0 && isValidPlusCode(fields[0]) {
		fields[0] = strings.ToUpper(fields[0])
		return googleMapsSearchURL(strings.Join(fields, " "))
	}
	value = defaultHTTPS(value)
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || !isGoogleMapsURL(parsed) {
		return ""
	}
	parsed.Scheme = "https"
	result := parsed.String()
	if len(result) > 2048 {
		return ""
	}
	return result
}

func googleMapsSearchURL(query string) string {
	parameters := url.Values{"api": {"1"}, "query": {query}}
	result := "https://www.google.com/maps/search/?" + parameters.Encode()
	if len(result) > 2048 {
		return ""
	}
	return result
}

func isGoogleMapsURL(parsed *url.URL) bool {
	host := strings.ToLower(parsed.Hostname())
	switch host {
	case "google.com", "www.google.com":
		return parsed.Path == "/maps" || strings.HasPrefix(parsed.Path, "/maps/")
	case "maps.google.com":
		return true
	case "maps.app.goo.gl":
		return strings.Trim(parsed.Path, "/") != ""
	case "goo.gl":
		return parsed.Path == "/maps" || strings.HasPrefix(parsed.Path, "/maps/")
	default:
		return false
	}
}

func cleanTelegramURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	digitsOnly := true
	for _, character := range value {
		if character < '0' || character > '9' {
			digitsOnly = false
			break
		}
	}
	if digitsOnly {
		value = "https://t.me/touchzouk/" + value
	} else {
		shorthand := strings.TrimPrefix(value, "/")
		lower := strings.ToLower(shorthand)
		switch {
		case strings.HasPrefix(lower, "t.me/"), strings.HasPrefix(lower, "telegram.me/"):
			value = "https://" + shorthand
		case strings.HasPrefix(shorthand, "@"):
			value = "https://t.me/" + strings.TrimPrefix(shorthand, "@")
		case strings.HasPrefix(lower, "touchzouk/"):
			value = "https://t.me/" + shorthand
		}
	}
	return cleanURL(value)
}

func parseTags(value string) []string {
	result := make([]string, 0, 3)
	seen := make(map[string]bool)
	for tag := range strings.SplitSeq(value, ",") {
		tag = cleanText(tag, 32)
		key := strings.ToLower(tag)
		if tag == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, tag)
		if len(result) == 3 {
			break
		}
	}
	return result
}

func randomID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func securityHeaders(next http.Handler) http.Handler {
	const contentSecurityPolicy = "default-src 'self'; " +
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
		"font-src 'self' https://fonts.gstatic.com; " +
		"img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; " +
		"frame-ancestors 'none'; base-uri 'self'; " +
		"form-action 'self' https://id.complynx.net"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		next.ServeHTTP(w, r)
	})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		slog.Info(
			"request",
			"method", r.Method,
			"path", r.URL.Path,
			"duration_ms", strconv.FormatInt(time.Since(started).Milliseconds(), 10),
		)
	})
}
