# Frontend And Audio

- Player has 3 linked surfaces: `site/shared-ui.js`, home `site/script.js`, Atlas `site/atlas.js`. Shared playback change requires `/` and `/listen` checked.
- Changed JavaScript needing cache bypass: bump query versions in `site/index.html` and `site/listen.html`.
- Admin library tab already conveys media kind. Never repeat `set` or `song` on cards. Show title, navigational context, duration, tags instead.
- Use real pointer drag, not click-only check. Playing drag: `audio.currentTime` jumps, playback stays active, visible elapsed time and `aria-valuetext` update. Paused drag: time updates, playback stays paused.
- Seeker lifecycle change: include pointer cancel or multi-pointer checks.
- `bindSeeker` accepts primary pointer button only. Secondary click opens share-time context menu; never move playhead.
- Atlas constellation order: prefer minimum interior angle `>=20deg`, then shortest valid non-crossing chain.
