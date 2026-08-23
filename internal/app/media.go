package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type Analysis struct {
	Title           string    `json:"title"`
	DurationSeconds float64   `json:"duration_seconds"`
	Waveform        []float64 `json:"waveform"`
}

type Analyzer interface {
	Analyze(ctx context.Context, audioPath string, waveformPoints int) (Analysis, error)
}

type stagedAnalyzer interface {
	Probe(ctx context.Context, audioPath string) (Analysis, error)
	AnalyzeWaveform(ctx context.Context, audioPath string, waveformPoints int, metadata Analysis) (Analysis, error)
}

type FFmpegAnalyzer struct {
	FFmpegPath  string
	FFprobePath string
}

type ffprobeOutput struct {
	Format struct {
		Duration   string            `json:"duration"`
		FormatName string            `json:"format_name"`
		Tags       map[string]string `json:"tags"`
	} `json:"format"`
	Streams []ffprobeStream `json:"streams"`
}

type ffprobeStream struct {
	CodecName string            `json:"codec_name"`
	CodecType string            `json:"codec_type"`
	Tags      map[string]string `json:"tags"`
}

func (a FFmpegAnalyzer) Analyze(ctx context.Context, audioPath string, waveformPoints int) (Analysis, error) {
	metadata, err := a.Probe(ctx, audioPath)
	if err != nil {
		return Analysis{}, err
	}
	return a.AnalyzeWaveform(ctx, audioPath, waveformPoints, metadata)
}

func (a FFmpegAnalyzer) Probe(ctx context.Context, audioPath string) (Analysis, error) {
	probe := exec.CommandContext(ctx, a.FFprobePath, //nolint:gosec // Trusted executable/path; no shell.
		"-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "a:0",
		"-show_entries", "format=duration,format_name:format_tags=title:stream=codec_name,codec_type:stream_tags=title",
		"-of", "json", audioPath,
	)
	probeOutput, err := probe.Output()
	if err != nil {
		return Analysis{}, commandError("ffprobe", err)
	}
	var metadata ffprobeOutput
	if decodeErr := json.Unmarshal(probeOutput, &metadata); decodeErr != nil {
		return Analysis{}, fmt.Errorf("decode ffprobe output: %w", decodeErr)
	}
	duration, err := strconv.ParseFloat(metadata.Format.Duration, 64)
	if err != nil || duration <= 0 || math.IsInf(duration, 0) || math.IsNaN(duration) {
		return Analysis{}, errors.New("audio has no valid duration")
	}
	if err := validateAudioProbe(audioPath, metadata); err != nil {
		return Analysis{}, err
	}
	return Analysis{Title: probeTitle(metadata), DurationSeconds: duration}, nil
}

func (a FFmpegAnalyzer) AnalyzeWaveform(
	ctx context.Context,
	audioPath string,
	waveformPoints int,
	metadata Analysis,
) (Analysis, error) {
	duration := metadata.DurationSeconds
	if duration <= 0 || math.IsInf(duration, 0) || math.IsNaN(duration) {
		return Analysis{}, errors.New("audio has no valid duration")
	}
	decode := exec.CommandContext(ctx, a.FFmpegPath, //nolint:gosec // Trusted executable/path; no shell.
		"-v", "error", "-protocol_whitelist", "file,pipe", "-i", audioPath,
		"-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "f32le", "-",
	)
	decodeError := &limitedDiagnostic{maximum: 4096}
	decode.Stderr = decodeError
	stdout, err := decode.StdoutPipe()
	if err != nil {
		return Analysis{}, fmt.Errorf("ffmpeg output: %w", err)
	}
	if err := decode.Start(); err != nil {
		return Analysis{}, commandError("ffmpeg", err)
	}
	waveform, readErr := waveformFromReader(stdout, int64(math.Ceil(duration*8000)), waveformPoints)
	waitErr := decode.Wait()
	if readErr != nil {
		return Analysis{}, readErr
	}
	if waitErr != nil {
		message := strings.TrimSpace(decodeError.String())
		if len(message) > 500 {
			message = message[:500]
		}
		if message != "" {
			return Analysis{}, fmt.Errorf("ffmpeg: %s", message)
		}
		return Analysis{}, commandError("ffmpeg", waitErr)
	}
	if len(waveform) == 0 {
		return Analysis{}, errors.New("decoded audio is empty")
	}
	return Analysis{
		Title:           metadata.Title,
		DurationSeconds: duration,
		Waveform:        waveform,
	}, nil
}

func probeTitle(metadata ffprobeOutput) string {
	tagSets := []map[string]string{metadata.Format.Tags}
	for _, stream := range metadata.Streams {
		tagSets = append(tagSets, stream.Tags)
	}
	for _, tags := range tagSets {
		for key, value := range tags {
			if strings.EqualFold(key, "title") {
				return strings.TrimSpace(value)
			}
		}
	}
	return ""
}

func validateAudioProbe(path string, metadata ffprobeOutput) error {
	extension := strings.ToLower(filepath.Ext(path))
	format := strings.ToLower(metadata.Format.FormatName)
	if (extension == ".opus" || extension == ".ogg") && !strings.Contains(format, "ogg") {
		return errors.New("audio contents are not an Ogg/Opus container")
	}
	if extension == ".flac" && !strings.Contains(format, "flac") {
		return errors.New("audio contents are not a FLAC container")
	}
	if len(metadata.Streams) != 1 || metadata.Streams[0].CodecType != uploadKindAudio {
		return errors.New("audio must contain a supported audio stream")
	}
	codec := strings.ToLower(metadata.Streams[0].CodecName)
	if codec != "opus" && codec != "vorbis" && codec != "flac" {
		return fmt.Errorf("unsupported audio codec %q", codec)
	}
	return nil
}

type limitedDiagnostic struct {
	buffer  bytes.Buffer
	maximum int
}

func (w *limitedDiagnostic) Write(contents []byte) (int, error) {
	remaining := w.maximum - w.buffer.Len()
	if remaining > 0 {
		if remaining > len(contents) {
			remaining = len(contents)
		}
		_, _ = w.buffer.Write(contents[:remaining])
	}
	return len(contents), nil
}

func (w *limitedDiagnostic) String() string { return w.buffer.String() }

func commandError(name string, err error) error {
	if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
		message := strings.TrimSpace(string(exitErr.Stderr))
		if len(message) > 500 {
			message = message[:500]
		}
		if message != "" {
			return fmt.Errorf("%s: %s", name, message)
		}
	}
	return fmt.Errorf("%s: %w", name, err)
}

func waveformFromPCM(pcm []byte, points int) ([]float64, error) {
	return waveformFromReader(bytes.NewReader(pcm), int64(len(pcm)/4), points)
}

func waveformFromReader(reader io.Reader, expectedSamples int64, points int) ([]float64, error) {
	if points <= 0 || expectedSamples <= 0 {
		return nil, errors.New("decoded audio is empty")
	}
	waveform := make([]float64, points)
	buffered := bufio.NewReaderSize(reader, 64*1024)
	buffer := make([]byte, 4)
	var sample int64
	for {
		_, err := io.ReadFull(buffered, buffer)
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read decoded audio: %w", err)
		}
		point := int(sample * int64(points) / expectedSamples)
		if point >= points {
			point = points - 1
		}
		bits := binary.LittleEndian.Uint32(buffer)
		value := math.Abs(float64(math.Float32frombits(bits)))
		if value > waveform[point] && !math.IsNaN(value) && !math.IsInf(value, 0) {
			waveform[point] = value
		}
		sample++
	}
	if sample == 0 {
		return nil, errors.New("decoded audio is empty")
	}
	var maximum float64
	for _, value := range waveform {
		if value > maximum {
			maximum = value
		}
	}
	if maximum == 0 {
		return waveform, nil
	}
	for index := range waveform {
		waveform[index] = math.Round((waveform[index]/maximum)*1000) / 1000
	}
	return waveform, nil
}

func writeWaveform(path string, analysis Analysis) error {
	contents, err := json.Marshal(struct {
		DurationSeconds float64   `json:"duration_seconds"`
		Points          []float64 `json:"points"`
	}{analysis.DurationSeconds, analysis.Waveform})
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		return errors.Join(err, temporary.Close())
	}
	if _, err := temporary.Write(append(contents, '\n')); err != nil {
		return errors.Join(err, temporary.Close())
	}
	if err := temporary.Sync(); err != nil {
		return errors.Join(err, temporary.Close())
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return replaceFile(temporaryPath, path)
}

func replaceFile(source, destination string) error {
	// Unix renames replace atomically. Windows requires the backup fallback when
	// the destination already exists.
	if err := os.Rename(source, destination); err == nil {
		return nil
	}
	backup := destination + ".previous"
	_ = os.Remove(backup)
	movedExisting := false
	if err := os.Rename(destination, backup); err == nil {
		movedExisting = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(source, destination); err != nil {
		if movedExisting {
			_ = os.Rename(backup, destination)
		}
		return err
	}
	if movedExisting {
		_ = os.Remove(backup)
	}
	return nil
}

func copyLimited(destination string, source io.Reader, maximum int64) (int64, error) {
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(file, io.LimitReader(source, maximum+1))
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(destination)
		return written, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(destination)
		return written, closeErr
	}
	if written > maximum {
		_ = os.Remove(destination)
		return written, errors.New("file exceeds upload limit")
	}
	return written, nil
}

func sniffFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	buffer := make([]byte, 32)
	count, err := file.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, errors.Join(err, file.Close())
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	return bytes.Clone(buffer[:count]), nil
}
