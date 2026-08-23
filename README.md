# touchzouk

DJ Touchzouk's public site and Sound Atlas. A single Go service serves the site,
streams media, manages the catalog, protects the admin page, and replaces the
previous nginx container.

## Local development

Requirements: Go 1.27 and FFmpeg/ffprobe. Copy the example to the ignored local
`config.yaml`; it uses a stub administrator login and SQLite in `./data`.

```bash
cp config.example.yaml config.yaml
go run ./testing/seed -config config.yaml
go run ./cmd/touchzouk -config config.yaml
```

Open <http://localhost:8080/listen>. Visiting `/admin` uses the explicit local
stub identity configured in `config.yaml`. The seed command is idempotent and
creates four varied sets and six songs using bundled public-domain preview media
for local UI testing; it is not intended for production. Audio provenance is
documented in `testing/audio/README.md`.

For the Docker demo used by the browser test loop:

```bash
docker compose -f testing/docker-compose.yml up --build -d
```

Open <http://127.0.0.1:8000/listen>. The image verifies both `ffmpeg` and
`ffprobe` during its build and seeds the persistent demo volume before startup.
The testing image, seed command, fixture audio, stub configuration, and local
Compose overlays all live under `testing/`; none is copied into the root image.

## Media pipeline

The admin stages one set or song at a time:

- audio: `.opus`, `.ogg`, or `.flac`;
- cover: `.jpg`, `.png`, `.webp`, or `.avif`;
- required metadata: title and cover (title falls back to the embedded audio
  title tag and remains editable in the form);
- optional metadata: subtitle, event name/link, partial play date/time,
  country/city, up to three tags, and a Telegram post link.

Audio and cover uploads begin as soon as files are selected or dropped. FFprobe
first extracts title and duration so the editable fields and 12-minute set/song
suggestion become available immediately. FFmpeg then decodes a mono analysis
stream into a normalized waveform JSON cache, which is previewed before
publishing. The square cover preview can be dragged with a mouse or touch and
zoomed with a wheel or pinch gesture. Files are stored below `data_dir`; an
administrator can edit or delete any entry, pin a featured set, drag sets and
songs into their public order, and regenerate waveforms. Newly published media
is placed first in its list.
Interrupted staged analyses resume after restart, and abandoned drafts are
removed after their 24-hour expiry.
