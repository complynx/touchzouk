# Frontend And Audio

- Player has 3 linked surfaces: `site/shared-ui.js`, home `site/script.js`, Atlas `site/atlas.js`. Shared playback change requires both controllers checked.
- Configured `site_dir` serves site files; local server reads `./site`. Frontend-only edit needs browser reload, not Go rebuild.
- Changed JavaScript needing cache bypass: bump query versions in `site/index.html` and `site/listen.html`.
- Navigation or reload may reset player state. Before every playback test, recheck Volume slider = `0`.
- Use real pointer drag, not click-only check. Playing drag: `audio.currentTime` jumps, playback stays active, visible elapsed time and `aria-valuetext` update. Paused drag: time updates, playback stays paused.
- Controller change: test `/` and `/listen`. Seeker lifecycle change: include pointer cancel or multi-pointer checks.
