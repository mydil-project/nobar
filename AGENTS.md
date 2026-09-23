# AGENTS.md

## Project

Static NOBAR (watch-together) web app. No package.json, bundler, or tests. Plain HTML/CSS/JS with ES modules and Firebase CDN imports.

## Run

- Open via HTTP server, not `file://` — ES modules and CDN imports fail on file protocol.
  - Example: `npx serve` or `python -m http.server` from this folder.
- Syntax check JS: `node --check <file>.js`

## Entry points

| Page | Role |
|------|------|
| `host.html` + `host.js` | Host: playback control, playlist, schedule, sync/async toggle, chat, viewers |
| `index.html` + `index.js` | Viewer: watch-only (sync or async per host mode), chat, viewers list — no playback controls or playlist |

Shared: `style.css`, `firebase.js` (config + `db`/`auth`/`provider`), `utils.js` (`escapeHtml`).

## Architecture facts

- Playback sync is driven by Firebase RTDB path `state` (`currentUrl`, `playing`, `videoPosition`, `playbackStartTimestamp`, `activePlaylistId`). Only the host writes `state`; viewers only read and seek/play to match.
- Clock skew handled via `.info/serverTimeOffset` → `serverOffset`. Use `Date.now() + serverOffset` for schedule/state math.
- HLS streams (`.m3u8`) use global `hls.js` from CDN (`Hls`); YouTube URLs load in an iframe (`hostYoutubeFrame` / `userYoutubeFrame`). Detection: `isYoutubeUrl` / `parseYoutubeId`.
- Default stream when playlist empty: constant `DEFAULT_STREAM_URL` in `host.js` (Red Bull TV m3u8). Host `playDefault()` resets `state` to it when playlist is empty or active item removed.
- Presence: `users/{uid}` with `online`, `role` (`host` | `viewer`), `onDisconnect`. Chat: `chat` via `onChildAdded`.
- Playlist schedule: host-only `checkSchedule()` (1s interval, guarded by `scheduleBusy`). Viewers must not write playlist/schedule/state.
- Sync/async mode: path `settings/syncMode` (`'sync'` | `'async'`, default `'sync'`). Only the host writes it (toggle `#btnSyncMode` in `host.html`); viewers read and show badge `#viewerModeBadge`. **Sync** = viewer follows `state` (current behavior). **Async** = viewer ignores `state`, computes playback from playlist `scheduledTime` vs server clock (`now - scheduledTime`); before first schedule / gap after item ends → `DEFAULT_STREAM_URL` (constant duplicated in `index.js`). Items without `scheduledTime` never play in async mode.

## Conventions

- DOM ids are the contract between HTML and JS (`$('id')` at top of each page script). Adding UI: update HTML id, CSS, and the matching page script together.
- `host.html` and `index.html` intentionally diverge (host has controls/playlist; viewer does not). Shared look lives only in `style.css`.
- User-generated strings in HTML: always `escapeHtml` from `utils.js` (chat, names, photo URLs).
- `.hidden` class = `display: none !important`. Toggle for overlays/controls.
- Video controls overlay is hidden by default; host toggles with `#btnToggleControls` (bound at module top level, not after login).

## Gotchas

- `initAll()` runs once per page load (`inited` flag) — do not add Firebase listeners that re-bind on every auth change without a guard.
- Live HLS: do not force-seek (duration is Infinity). Seek-sync only when `isFinite(duration)`.
- After a playlist video ends, call `playDefault(true)` (force); non-force no-ops if `state.currentUrl` still set.
- Google sign-in requires this origin in Firebase Auth authorized domains.
- Async mode: YouTube iframe seek is only applied via `&start=` on load (no continuous re-sync). Gap after a VOD item ends is tracked with `asyncGapId` so the 1s `tickAsync()` does not reload the finished item before the next schedule.
