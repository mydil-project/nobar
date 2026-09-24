# AGENTS.md

## Project

Static NOBAR (watch-together) web app. No package.json, bundler, or tests. Plain HTML/CSS/JS with ES modules and Firebase CDN imports.

## Run

- Open via HTTP server, not `file://` — ES modules and CDN imports fail on file protocol.
  - Example: `npx serve` or `python -m http.server` from this folder.
- Syntax check JS: `node --check js/<file>.js`

## Folder layout

```
login.html               # single login (Google) → host vs viewer
index.html, host.html     # app pages (no local login screen)
css/style.css             # base/desktop stylesheet (no @media blocks)
css/mobile.css            # all @media overrides — load after style.css
js/login.js               # login + UID gate (HOST_UID → host.html else index.html)
js/index.js, js/host.js   # page scripts
js/firebase.js            # Firebase config + db/auth/provider/HOST_UID exports
js/utils.js               # escapeHtml, isDesktopPointer, requestDocumentFullscreen, showFullscreenHint
database.rules.json       # RTDB security rules
AGENTS.md
```

## Entry points

| Page | Role |
|------|------|
| `login.html` + `js/login.js` | Single login. `auth.uid === HOST_UID` (`fFOsbbOhCMOcMXiF5Wf88KpBDe22`) → write `role: 'host'` + `location.replace('host.html')`; else `role: 'viewer'` + `index.html` |
| `host.html` + `js/host.js` | Host: playback control, playlist (+ play/reschedule/delete), schedule, sync/async toggle, chat, viewers. No login UI — not signed in / wrong UID → redirect `login.html` / `index.html` |
| `index.html` + `js/index.js` | Viewer: watch-only (sync or async per host mode), chat, viewers list — no playback controls or playlist. Not signed in → `login.html`; `HOST_UID` → `host.html` |

Shared: `css/style.css` + `css/mobile.css`, `js/firebase.js` (`HOST_UID`), `js/utils.js`. HTML refs: both stylesheets (`mobile.css` after `style.css`), `js/login.js?v=…`, `js/index.js?v=…`, `js/host.js?v=…`. JS imports stay relative within `js/` (`./firebase.js`, `./utils.js`).

## Architecture facts

- Playback sync is driven by Firebase RTDB path `state` (`currentUrl`, `playing`, `videoPosition`, `playbackStartTimestamp`, `activePlaylistId`). Only the host writes `state`; viewers only read and seek/play to match.
- Sync mode arsitektur: **waktu host = kebenaran tunggal**. Host menjalankan `startHostReanchor()` (interval 500ms, dari `initAll`): bila drift `|currentTime − formula| > 0.5s` dan `playing` + non-YouTube → host menulis ulang `videoPosition` + `playbackStartTimestamp` ke posisi aktual. Viewer hanya mengejar formula (`expectedPosition`) → otomatis mengikuti host dan tidak mendahui. Playback normal drift ≈ 0 → hampir tidak ada tulisan (hemat Firebase, tidak ada loop). Guards: skip bila `!sessionActive` (setelah logout), `Number.isNaN(duration)`, atau host `paused` (tulis pertama setelah 4s pause, lalu throttle max 1 tulisan / 4s) — cegah spam tulis saat autoplay host gagal/buffer.
- Progress bar host: klik seek **langsung** set `hostVideoPlayer.currentTime` (wajib — re-anchor 0.5s akan membalik posisi bila hanya tulis state). Saat `state.playing === false`, patch hanya `videoPosition` (seek tanpa resume); saat playing, refresh `playing` + `playbackStartTimestamp`.
- Logout / signed-out (`onAuthStateChanged` null): set `sessionActive = false`, pause + `stopVideoElements()` + `hideYoutubeFrame()`, reset `lastLoadedUrl = ''` (host) / `initialSeekDone = false` (viewer) → re-anchor & `checkSchedule` berhenti, video tidak tetap bunyi di background → `location.replace('login.html')`. `onAuthStateChanged` host `await registerHost()` sebelum `initAll()` (pastikan `users/{uid}.role = 'host'` ada sebelum tulis `state` — dibutuhkan security rules).
- Clock skew handled via `.info/serverTimeOffset` → `serverOffset`. Use `Date.now() + serverOffset` for schedule/state math.
- HLS streams (`.m3u8`) use global `hls.js` from CDN (`Hls`); YouTube URLs load in an iframe (`hostYoutubeFrame` / `userYoutubeFrame`). Detection: `isYoutubeUrl` / `parseYoutubeId`.
- Default stream when playlist empty: constant `DEFAULT_STREAM_URL` in `js/host.js` (Red Bull TV m3u8). Host `playDefault()` resets `state` to it when playlist is empty or active item removed.
- Presence: `users/{uid}` with `online`, `role` (`host` | `viewer`), `onDisconnect`. Chat: `chat` via `onChildAdded`.
- Playlist schedule: host-only `checkSchedule()` (1s interval, guarded by `scheduleBusy`). Viewers must not write playlist/schedule/state. `scheduledTime` is ISO string; sort is by scheduled time on every `onValue(playlist)`.
- Playlist items host-only writes: `push` add, `remove` delete, `update` for status/reschedule/play. Item shape: `{ title, url, status: 'pending'|'active'|'completed', scheduledTime?: ISO }`.
- Manual default: tombol `#btnPlayDefault` di bar `movie-info` host → `playDefault(true)` (force, ganti `state` ke `DEFAULT_STREAM_URL` walau `currentUrl` masih terisi). Viewer tidak punya tombol ini.
- Sync/async mode: path `settings/syncMode` (`'sync'` | `'async'`, default `'sync'`). Only the host writes it (toggle `#btnSyncMode` in `host.html`); viewers read and show badge `#viewerModeBadge`. **Sync** = viewer follows `state` (current behavior). **Async** = viewer ignores `state`, computes playback from playlist `scheduledTime` vs server clock (`now - scheduledTime`); before first schedule / gap after item ends → `DEFAULT_STREAM_URL` (constant duplicated in `js/index.js`). Items without `scheduledTime` never play in async mode. `tickAsync()` skip item `status === 'completed'` kecuali sedang aktif (`asyncActiveId`) — viewer yang tertinggal tetap boleh menyelesaikan item-nya.
- RTDB security rules: `database.rules.json` (deploy via Firebase CLI / Console). `state`, `defaultUrl`, `settings`, `playlist/*`, dan identitas host di `chat` write hanya `auth.uid === HOST_UID`; `chat` viewer write auth + `uid` cocok `auth.uid`; `users/{uid}` write hanya own uid + **validate: `role === 'host'` hanya boleh bila `auth.uid === HOST_UID`**; root `.read/.write` false. Role host hanya ditulis `js/login.js` / `js/host.js` `registerHost()` untuk `HOST_UID` — user biasa tidak bisa set `role: 'host'` lagi.

### Playlist item actions (host only)

- **Play**: `.btn-play` or dblclick → `playPlaylistItem(idx)`. Sets `status: 'active'` if item has schedule, then writes `state`.
- **Reschedule**: `.btn-sched` → modal `#rescheduleModal` (`#rescheduleInput` datetime-local). Save: `update` `scheduledTime` (ISO); if `status === 'completed'` → `pending`. Empty input + save clears `scheduledTime` and sets `status: 'pending'`. Does **not** stop active playback. Close: Batal / overlay click / Esc.
- **Delete**: `.btn-del` → `removePlaylistItem(id)`.

### Auth + fullscreen (PC)

- Login: **hanya** `login.html` — `signInWithPopup` first; on `auth/popup-blocked` fall back to `signInWithRedirect`. Setelah auth: `HOST_UID` → `host.html`, selain itu → `index.html`. `host.html`/`index.html` tidak punya layar login; signed-out → `location.replace('login.html')`.
- Fullscreen (desktop only, `pointer: fine`): jangan panggil saat/sesaat setelah `signInWithPopup` — activation habis / popup diblokir. `tryAutoFullscreen()` dipanggil dari event `canplay` video pertama (atau saat iframe YouTube dimuat). Jika tetap ditolak (butuh gesture), toast `showFullscreenHint()` tetap fallback (klik → `requestDocumentFullscreen()`).
- Autoplay (**opsi A**): semua `play()` lewat `tryPlay()` — **selalu bersuara**, **tidak pernah** fallback `muted` + **tidak ada** toast `#soundToast` (`showSoundToast()` no-op). Jika `NotAllowedError`/`SecurityError` → tampilkan overlay `#userPlayOverlay` / `#hostPlayOverlay` ("Klik untuk memutar"); gesture berikutnya → `unlockAudioOnGesture()` → unmute + `resumeIfPlaying()` → play bersuara. Gagal media (`NotSupportedError`/`AbortError`) → diam, retry di `canplay`. **Target editable** (`input`/`textarea`/`[contenteditable]`/`.chat-input`, via `isEditableTarget`): hanya `hideSoundToast()` (hapus elemen sisa), **jangan** `tryPlay()`/`resumeIfPlaying()` — cegah keyboard mobile tidak terbuka saat tap kolom chat. `resumeIfPlaying()` juga dari `visibilitychange` + `IntersectionObserver`. `loadVideo()` reset `muted`/`autoMuted`. `#chatInput` `focus` → `hideAllToasts()` + delayed `scrollIntoView({ block: 'nearest' })` (lihat Mobile keyboard). Chat auto-scroll skip bila `document.activeElement === #chatInput`.
- If app visible but not fullscreen (e.g. session restore): `showFullscreenHint()` shows toast `#fsToast` (auto-hide 4s, click retries). Di `≤900px` `#fsToast` juga di **atas** agar tidak menutup `#chatInput`. Toast suara `#soundToast` **dihapus** (opsi A).

## Layout / responsive (`css/style.css` + `css/mobile.css`)

- **Split (opsi A)**: base/desktop rules live in `css/style.css` (no `@media`); **all** breakpoints live in `css/mobile.css` (loaded after via `<link>` on all 3 pages). Add new responsive overrides only in `mobile.css` — do not put `@media` back in `style.css`.
- Breakpoints (in `mobile.css`): `≤1000px` (sidebar 300px, hide `.time`), `≤900px` (stack column, video `aspect-ratio 16/9`, `html/body height: auto` + `padding-bottom: 16px` (spasi keyboard via `initKeyboardPadding()`, bukan statis) + `.app { overflow: visible }` agar scroll saat keyboard terbuka, `#fsToast` top), `≤560px` (phone: header compact, movie-info wrap, form judul/URL full-width + jadwal & Tambah sebaris (judul header `.playlist-title` disembunyikan — redundan dgn tab), touch targets ≥40px, playlist item 2-row), `@media (hover: none)` (chat delete always visible), `max-height: 480px` + `≤900px` (landscape: shorter chat/panels).
- Desktop panel heights: `.panel-content.active` and `.viewers.panel-content.active` = **140px** (video is `flex: 1` takes the rest). Mobile overrides use `max-height` (playlist 400px, viewers 220px) — do not raise desktop height without re-checking video size.
- Playlist item grid (base): `28px 1fr auto 32px 32px 32px` (idx | info | badge | sched | play | del). Buttons use `grid-column: -3/-2/-1` so missing badge leaves empty `auto` column. At `≤560px`: explicit 2-row areas (badge on row 2).
- Modal/reschedule + fullscreen toast styles live near top of `style.css` (UTIL / FULLSCREEN HINT / MODAL sections).

## Conventions

- DOM ids are the contract between HTML and JS (`$('id')` at top of each page script). Adding UI: update HTML id, CSS, and the matching page script together.
- `host.html` and `index.html` intentionally diverge (host has controls/playlist/modal; viewer does not). Shared look lives only in `css/style.css` + `css/mobile.css`.
- User-generated strings in HTML: always `escapeHtml` from `js/utils.js` (chat, names, photo URLs, playlist titles/urls).
- `.hidden` class = `display: none !important`. Toggle for overlays/controls/modals.
- Video controls overlay is hidden by default; host toggles with `#btnToggleControls` (bound at module top level, not after login).
- Touch targets on phone (`≤560px`) should stay ≥40px for action buttons; form inputs 36px + `font-size: 16px` to prevent iOS zoom. `#chatInput` di `≤900px` juga `16px` (bukan hanya `≤560px`).
- Only the host writes playlist, `state`, and `settings/*`. Viewers are read-only for those paths.
- Mobile keyboard: `bindChatInputFocus()` dipanggil **di top-level module** (bukan di `initAll`) — focus/wrapper handler siap sebelum login. Wrapper `.chat-input` `pointerdown` → `hideAllToasts()`; target non-input → `preventDefault`; **selalu** `chatInput.focus()` (jangan rely native focus — Android bisa menelan). `chatInput` `click` juga → `focus()`. `focus` → `hideAllToasts()` + `setTimeout` 300ms → `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` agar input naik di atas keyboard. Viewport meta: `interactive-widget=resizes-content` (Chrome Android resize layout saat keyboard buka). Di `≤900px`: `html/body { height: auto }` + `body { padding-bottom: 16px }` (fallback) + `scroll-margin-bottom: 16px` (clearance kecil — ruang scroll keyboard dari `initKeyboardPadding`, bukan margin besar). **Spasi keyboard dinamis**: `initKeyboardPadding()` (duplikat di `host.js`/`index.js`, dipanggil top-level bersama `bindChatInputFocus`) — ukur `kb = maxVv − visualViewport.height`; `kb > 80` → inline `body.style.paddingBottom = kb` (pas setinggi keyboard), selain itu `16px`; reset baseline saat `orientationchange`, skip saat fullscreen, clear inline di `>900px`. Tap `.chat` → `hideAllToasts()`. Toast `#fsToast` di `≤900px` juga dipindah ke atas. Viewer: `initChat()` dipanggil **sebelum** `await get(settings/syncMode)` agar listener chat/counter tidak tertahan network. `initChat.done` guard anti double-bind.
- Chat message count `#chatMsgCount`: hitung dari DOM (`chatMessages.querySelectorAll('.message').length`), bukan hanya `chatEls.size` — cegah angka `0` saat pesan tampil. Script di-load dengan `?v=login1` untuk bust cache module di mobile.

## Gotchas

- `initAll()` runs once per page load (`inited` flag) — do not add Firebase listeners that re-bind on every auth change without a guard.
- Sync/seek hanya dijalankan setelah `timeSynced` (`.info/serverTimeOffset` callback pertama) dan media `readyState >= 2` + duration finite — cegah seek salah di awal load. Viewer: force-seek pertama hanya sekali di `canplay` (flag `initialSeekDone`), reset saat ganti URL/mode/logout.
- HLS: `lowLatencyMode: false`, buffer awal besar (`maxBufferLength: 60`), play pertama ditunda sampai `FRAG_BUFFERED` (timeout 1.5s) agar tidak patah saat mulai. `<video preload="metadata">`.
- Live HLS: do not force-seek (duration is Infinity). Seek-sync only when `isFinite(duration)`.
- After a playlist video ends, call `playDefault(true)` (force); non-force no-ops if `state.currentUrl` still set.
- Google sign-in requires this origin in Firebase Auth authorized domains.
- Async mode: YouTube iframe seek is only applied via `&start=` on load (no continuous re-sync). Gap after a VOD item ends is tracked with `asyncGapId` so the 1s `tickAsync()` does not reload the finished item before the next schedule.
- Reschedule of an *active* item only changes `scheduledTime`; leave `state` alone (playback continues by design).
- Clearing schedule uses `scheduledTime: null` in RTDB `update` (removes key), not empty string.
- Fullscreen toast and modal handlers are bound once in `initPlaylist()` / via `showFullscreenHint` self-init — do not re-bind on every `renderPlaylist()`.
- Known limitation: YouTube di mode sync tidak pernah di-seek (iframe tanpa akses `currentTime`; drift bebas). Satu akun Google dibuka di host.html + index.html = 1 record `users/{uid}` (role/online bisa saling menimpa antar tab).
- Deploy rules: `database.rules.json` harus di-deploy ke RTDB project (`firebase deploy --only database` atau tempel di Console → Rules) sebelum aturan host-only aktif.
