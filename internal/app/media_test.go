package app

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWaveformFromPCMNormalizesPeaks(t *testing.T) {
	values := []float32{0.25, -0.5, 1, -0.75, 0.1, -0.2, 0.4, -0.8}
	var pcm bytes.Buffer
	for _, value := range values {
		require.NoError(t, binary.Write(&pcm, binary.LittleEndian, math.Float32bits(value)))
	}
	waveform, err := waveformFromPCM(pcm.Bytes(), 4)
	require.NoError(t, err)
	want := []float64{0.5, 1, 0.2, 0.8}
	assert.Equal(t, want, waveform)
}

func TestWriteWaveformReplacesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "waveform.json")
	require.NoError(t, writeWaveform(path, Analysis{DurationSeconds: 1, Waveform: []float64{0.1}}))
	require.NoError(t, writeWaveform(path, Analysis{DurationSeconds: 2, Waveform: []float64{0.8}}))
	contents, err := os.ReadFile(path)
	require.NoError(t, err)
	hasDuration := bytes.Contains(contents, []byte(`"duration_seconds":2`))
	hasPoints := bytes.Contains(contents, []byte(`"points":[0.8]`))
	assert.True(t, hasDuration, "unexpected replacement contents: %s", contents)
	assert.True(t, hasPoints, "unexpected replacement contents: %s", contents)
	_, err = os.Stat(path + ".previous")
	assert.ErrorIs(t, err, os.ErrNotExist)
}

func TestProbeTitleReadsVorbisStreamTag(t *testing.T) {
	var metadata ffprobeOutput
	metadata.Streams = append(metadata.Streams, ffprobeStream{Tags: map[string]string{"TITLE": " Für Elise "}})
	assert.Equal(t, "Für Elise", probeTitle(metadata))
}

func TestParseTagsDeduplicatesAndLimits(t *testing.T) {
	got := parseTags(" Deep, melodic, deep, closing, ignored ")
	want := []string{"Deep", "melodic", "closing"}
	assert.Equal(t, want, got)
}

func TestValidateCoverChecksContents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cover.png")
	require.NoError(t, os.WriteFile(path, []byte("not a png"), 0o600))
	require.Error(t, validateCover(path, ".png", "ffmpeg", "ffprobe"))
	file, err := os.Create(path)
	require.NoError(t, err)
	picture := image.NewRGBA(image.Rect(0, 0, 1, 1))
	picture.Set(0, 0, color.RGBA{R: 20, G: 40, B: 60, A: 255})
	require.NoError(t, png.Encode(file, picture))
	require.NoError(t, file.Close())
	require.NoError(t, validateCover(path, ".png", "ffmpeg", "ffprobe"))
}
