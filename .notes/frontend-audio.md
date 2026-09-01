# Frontend And Audio

- Player has 3 linked surfaces: `site/shared-ui.js`, home `site/script.js`, Atlas `site/atlas.js`. Shared playback change requires `/` and `/listen` checked.
- Changed JavaScript needing cache bypass: bump query versions in `site/index.html` and `site/listen.html`.
- Admin library tab already conveys media kind. Never repeat `set` or `song` on cards. Show title, navigational context, duration, tags instead.
- Use real pointer drag, not click-only check. Playing drag: `audio.currentTime` jumps, playback stays active, visible elapsed time and `aria-valuetext` update. Paused drag: time updates, playback stays paused.
- Seeker lifecycle change: include pointer cancel or multi-pointer checks.
- `bindSeeker` accepts primary pointer button only. Secondary click opens share-time context menu; never move playhead.
- Atlas constellations: use largest stars per local cell; cover a fine viewport grid. Euclidean MST base; optional loop stays non-crossing, incident angles `>=30deg`.
- Atlas lyrics: expanded view has Copy action styled as existing icon controls. Compact current line stays clickable during playback. Karaoke font, line box, baseline = plain current lyric.
- Karaoke segment boundaries must preserve natural spaces; current lyric uses `white-space: pre`.
- Admin lyric pause = 1 virtual character. Before/after caret timing distinct. Timeline nav long-touch must not open context menu.
