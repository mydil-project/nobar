import { db, auth, provider } from './firebase.js';
import { escapeHtml, isDesktopPointer, requestDocumentFullscreen, showFullscreenHint } from './utils.js';
import {
  ref, onValue, onChildAdded, set, push, update, remove, get, serverTimestamp, onDisconnect as fbOnDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// DOM
const $ = id => document.getElementById(id);
const loginScreen = $('loginScreen');
const hostPage = $('hostPage');
const btnLogin = $('btnGoogleLogin');
const loginError = $('loginError');
const hostPhoto = $('hostPhoto');
const hostName = $('hostName');
const hostViewerCountTop = $('hostViewerCountTop');
const hostChatCount = $('hostChatCount');
const hostNowTitle = $('hostNowTitle');
const hostVideoPlayer = $('hostVideoPlayer');
const hostYoutubeFrame = $('hostYoutubeFrame');
const hostNoVideo = $('hostNoVideo');
const hostPlayOverlay = $('hostPlayOverlay');
const hostViewerSection = $('hostViewerSection');
const viewerListSection = $('viewerListSection');
const inputTitle = $('inputTitle');
const inputUrl = $('inputUrl');
const inputSchedule = $('inputSchedule');
const btnAddPlaylist = $('btnAddPlaylist');
const playlistList = $('playlistList');
const chatMessages = $('chatMessages');
const chatInput = $('chatInput');
const btnChatSend = $('btnChatSend');
const hostViewerCountBar = $('hostViewerCountBar');
const nextFilmBar = $('nextFilmBar');
const btnPlayPause = $('btnPlayPause');
const btnMute = $('btnMute');
const progressBar = $('progressBar');
const progressCurrent = $('progressCurrent');
const progressDot = $('progressDot');
const timeDisplay = $('timeDisplay');
const btnToggleTime = $('btnToggleTime');
const btnToggleControls = $('btnToggleControls');
const videoControls = $('videoControls');
const infoSep = $('infoSep');
const nextFilmBarCountdown = $('nextFilmBarCountdown');
const nextFilmBarTitle = $('nextFilmBarTitle');
const btnSyncMode = $('btnSyncMode');
const syncModeLabel = $('syncModeLabel');
const btnPlayDefault = $('btnPlayDefault');
const rescheduleModal = $('rescheduleModal');
const rescheduleTitle = $('rescheduleTitle');
const rescheduleInput = $('rescheduleInput');
const rescheduleSave = $('rescheduleSave');
const rescheduleCancel = $('rescheduleCancel');

const DEFAULT_STREAM_URL = 'https://3ea22335.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/UmFrdXRlblRWLWdiX1JlZEJ1bGxUVl9ITFM/playlist.m3u8';
const DEFAULT_STREAM_TITLE = 'Red Bull TV';

let hls = null;
let currentUser = null;
let serverOffset = 0;
let timeSynced = false;
const afterTimeSync = [];
let autoMuted = false;
let fsRequested = false;
let playlistData = [];
let currentState = {};
let lastLoadedUrl = '';
let inited = false;
let presenceBound = false;
let scheduleBusy = false;
let rescheduleId = null;
let sessionActive = false;
let reanchorPausedAt = 0;
let lastReanchorWrite = 0;

// ===== HELPERS =====
function isYoutubeUrl(url) {
  return typeof url === 'string' && /(?:youtube\.com|youtu\.be)/.test(url);
}

function parseYoutubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '00:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = n => (n < 10 ? '0' : '') + n;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}

// ===== FIREBASE OFFSET =====
onValue(ref(db, '.info/serverTimeOffset'), snap => {
  serverOffset = snap.val() || 0;
  if (!timeSynced) {
    timeSynced = true;
    while (afterTimeSync.length) afterTimeSync.shift()();
    applyHostSync();
  }
});

function whenTimeSynced(fn) {
  if (timeSynced) fn();
  else afterTimeSync.push(fn);
}

function tryAutoFullscreen() {
  if (fsRequested || !isDesktopPointer()) return;
  fsRequested = true;
  requestDocumentFullscreen().catch(() => {});
}

// ===== AUTOPLAY =====
function hidePlayOverlay() {
  if (hostPlayOverlay) hostPlayOverlay.classList.add('hidden');
}

function showPlayOverlay() {
  if (hostPlayOverlay) hostPlayOverlay.classList.remove('hidden');
}

function tryPlay() {
  hostVideoPlayer.play()
    .then(hidePlayOverlay)
    .catch(() => {
      if (!hostVideoPlayer.muted) {
        hostVideoPlayer.muted = true;
        btnMute.textContent = '🔇';
        hostVideoPlayer.play()
          .then(() => {
            autoMuted = true;
            hidePlayOverlay();
          })
          .catch(() => showPlayOverlay());
      } else {
        showPlayOverlay();
      }
    });
}

function unlockAudioOnGesture() {
  if (!autoMuted) return;
  autoMuted = false;
  hostVideoPlayer.muted = false;
  btnMute.textContent = '🔊';
}

// ===== TOGGLE VIDEO CONTROLS (langsung, tidak menunggu login) =====
btnToggleControls.addEventListener('click', () => {
  videoControls.classList.toggle('hidden');
  btnToggleControls.classList.toggle('active');
});

// ===== TOGGLE SYNC/ASYNC MODE (host atur semua penonton) =====
let syncMode = 'sync';

function renderSyncMode() {
  const isAsync = syncMode === 'async';
  btnSyncMode.classList.toggle('active', isAsync);
  btnSyncMode.setAttribute('aria-pressed', String(isAsync));
  syncModeLabel.textContent = isAsync ? 'Mandiri' : 'Sinkron';
}

onValue(ref(db, 'settings/syncMode'), snap => {
  syncMode = snap.val() === 'async' ? 'async' : 'sync';
  renderSyncMode();
});

btnSyncMode.addEventListener('click', async () => {
  const next = syncMode === 'sync' ? 'async' : 'sync';
  await set(ref(db, 'settings/syncMode'), next);
});

btnPlayDefault.addEventListener('click', () => {
  playDefault(true);
});

// ===== AUTH =====
btnLogin.addEventListener('click', async () => {
  try {
    loginError.textContent = '';
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e && e.code === 'auth/popup-blocked') {
      try {
        await signInWithRedirect(auth, provider);
        return;
      } catch (e2) {
        loginError.textContent = 'Gagal login: ' + e2.message;
        return;
      }
    }
    loginError.textContent = 'Gagal login: ' + e.message;
  }
});

onAuthStateChanged(auth, async user => {
  if (user) {
    currentUser = user;
    sessionActive = true;
    reanchorPausedAt = 0;
    await registerHost(user);
    loginScreen.classList.add('hidden');
    hostPage.classList.remove('hidden');
    hostPhoto.src = user.photoURL || '';
    hostName.textContent = user.displayName || 'Host';
    initAll();
    showFullscreenHint();
  } else {
    currentUser = null;
    sessionActive = false;
    reanchorPausedAt = 0;
    lastLoadedUrl = '';
    hostVideoPlayer.pause();
    stopVideoElements();
    hideYoutubeFrame();
    loginScreen.classList.remove('hidden');
    hostPage.classList.add('hidden');
  }
});

async function registerHost(user) {
  const userRef = ref(db, 'users/' + user.uid);
  await set(userRef, {
    name: user.displayName || 'Host',
    email: user.email || '',
    photo: user.photoURL || '',
    role: 'host',
    online: true,
    lastSeen: serverTimestamp()
  });

  if (presenceBound) return;
  presenceBound = true;

  onValue(ref(db, '.info/connected'), snap => {
    if (snap.val() && currentUser) {
      update(ref(db, 'users/' + currentUser.uid), { online: true });
      fbOnDisconnect(ref(db, 'users/' + currentUser.uid)).update({
        online: false,
        lastSeen: serverTimestamp()
      });
    }
  });

  window.addEventListener('beforeunload', () => {
    if (currentUser) {
      update(ref(db, 'users/' + currentUser.uid), { online: false });
    }
  });
}

// ===== INIT =====
function initAll() {
  if (inited) return;
  inited = true;

  initTabs();
  initPlayer();
  initPlaylist();
  initViewers();
  initChat();
  listenState();
  startScheduler();
  startHostReanchor();
  initFullscreen();
  startNextFilmCountdown();
  playDefault();

  $('btnLogout').addEventListener('click', async () => {
    sessionActive = false;
    lastLoadedUrl = '';
    hostVideoPlayer.pause();
    stopVideoElements();
    hideYoutubeFrame();
    if (currentUser) {
      await update(ref(db, 'users/' + currentUser.uid), { online: false });
    }
    await signOut(auth);
  });
}

// ===== TABS =====
function initTabs() {
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(tab.dataset.tab).classList.add('active');
    });
  });
}

// ===== PLAYER =====
function initPlayer() {
  hostVideoPlayer.addEventListener('ended', async () => {
    const s = currentState;
    if (s.isPlaylistItem && s.activePlaylistId) {
      await update(ref(db, 'playlist/' + s.activePlaylistId), { status: 'completed' });
      await playDefault(true);
    }
  });

  hostVideoPlayer.addEventListener('contextmenu', e => e.preventDefault());

  hostVideoPlayer.addEventListener('play', hidePlayOverlay);

  hostVideoPlayer.addEventListener('canplay', () => {
    applyHostSync();
    tryAutoFullscreen();
  });

  if (hostPlayOverlay) {
    hostPlayOverlay.addEventListener('click', () => {
      hostVideoPlayer.muted = false;
      autoMuted = false;
      btnMute.textContent = '🔊';
      hostVideoPlayer.play()
        .then(hidePlayOverlay)
        .catch(() => showPlayOverlay());
    });
  }
  document.addEventListener('pointerdown', unlockAudioOnGesture);
  document.addEventListener('keydown', unlockAudioOnGesture);

  hostVideoPlayer.addEventListener('timeupdate', updateProgressUI);
  hostVideoPlayer.addEventListener('durationchange', updateProgressUI);
  hostVideoPlayer.addEventListener('loadedmetadata', updateProgressUI);
  hostVideoPlayer.addEventListener('play', () => { btnPlayPause.textContent = '⏸'; });
  hostVideoPlayer.addEventListener('pause', () => { btnPlayPause.textContent = '▶'; });

  btnPlayPause.addEventListener('click', async () => {
    if (isYoutubeUrl(currentState.currentUrl)) return;
    if (currentState.playing) {
      await update(ref(db, 'state'), {
        playing: false,
        videoPosition: hostVideoPlayer.currentTime || 0
      });
    } else {
      await update(ref(db, 'state'), {
        playing: true,
        videoPosition: hostVideoPlayer.currentTime || 0,
        playbackStartTimestamp: Date.now() + serverOffset
      });
    }
  });

  btnMute.addEventListener('click', () => {
    hostVideoPlayer.muted = !hostVideoPlayer.muted;
    btnMute.textContent = hostVideoPlayer.muted ? '🔇' : '🔊';
  });

  btnToggleTime.addEventListener('click', () => {
    timeDisplay.classList.toggle('hidden');
  });

  progressBar.addEventListener('click', async e => {
    if (isYoutubeUrl(currentState.currentUrl)) return;
    const d = hostVideoPlayer.duration;
    if (!isFinite(d) || d <= 0) return;
    const rect = progressBar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const pos = ratio * d;
    if (hostVideoPlayer.readyState >= 2) hostVideoPlayer.currentTime = pos;
    const patch = { videoPosition: pos };
    if (currentState.playing) {
      patch.playing = true;
      patch.playbackStartTimestamp = Date.now() + serverOffset;
    }
    await update(ref(db, 'state'), patch);
  });
}

function updateProgressUI() {
  const d = hostVideoPlayer.duration;
  const c = hostVideoPlayer.currentTime || 0;

  if (!isFinite(d) || d <= 0) {
    progressCurrent.style.width = '100%';
    progressDot.style.left = '100%';
    timeDisplay.textContent = 'LIVE';
    return;
  }

  const pct = Math.min(100, (c / d) * 100);
  progressCurrent.style.width = pct + '%';
  progressDot.style.left = pct + '%';
  timeDisplay.textContent = fmtTime(c) + ' / ' + fmtTime(d);
}

function stopVideoElements() {
  if (hls) { hls.destroy(); hls = null; }
  hostVideoPlayer.pause();
  hostVideoPlayer.removeAttribute('src');
  hostVideoPlayer.load();
}

function loadVideo(url) {
  if (!url) {
    stopVideoElements();
    hostVideoPlayer.style.display = 'none';
    hideYoutubeFrame();
    hostNoVideo.classList.remove('hidden');
    hostNowTitle.textContent = 'Tidak ada';
    return;
  }

  hostNoVideo.classList.add('hidden');

  if (isYoutubeUrl(url)) {
    const ytId = parseYoutubeId(url);
    stopVideoElements();
    hostVideoPlayer.style.display = 'none';
    if (ytId) {
      hostYoutubeFrame.style.display = 'block';
      const embed = 'https://www.youtube.com/embed/' + ytId + '?autoplay=1&rel=0';
      if (hostYoutubeFrame.getAttribute('src') !== embed) {
        hostYoutubeFrame.setAttribute('src', embed);
      }
      tryAutoFullscreen();
    }
    return;
  }

  hideYoutubeFrame();
  hostVideoPlayer.style.display = 'block';

  const isHls = url.includes('.m3u8') || url.includes('m3u8');
  if (hls) { hls.destroy(); hls = null; }

  if (isHls) {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        startFragPrefetch: true
      });
      hls.loadSource(url);
      hls.attachMedia(hostVideoPlayer);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const inst = hls;
        let started = false;
        const startFirstPlay = () => {
          if (started || hls !== inst) return;
          started = true;
          hostVideoPlayer.muted = false;
          btnMute.textContent = '🔊';
          tryPlay();
        };
        inst.on(Hls.Events.FRAG_BUFFERED, startFirstPlay);
        setTimeout(startFirstPlay, 1500);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          console.error('HLS error:', data.type, data.details);
          if (hls) {
            try { hls.startLoad(); } catch (_) {}
          }
        }
      });
    } else if (hostVideoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      hostVideoPlayer.src = url;
      hostVideoPlayer.muted = false;
      btnMute.textContent = '🔊';
      tryPlay();
    }
  } else {
    hostVideoPlayer.src = url;
    hostVideoPlayer.muted = false;
    btnMute.textContent = '🔊';
    tryPlay();
  }
}

function hideYoutubeFrame() {
  hostYoutubeFrame.style.display = 'none';
  hostYoutubeFrame.setAttribute('src', 'about:blank');
}

async function playDefault(force = false) {
  if (!timeSynced) {
    whenTimeSynced(() => playDefault(force));
    return;
  }
  if (!force) {
    try {
      const snap = await get(ref(db, 'state'));
      if (snap.val() && snap.val().currentUrl) return;
    } catch (e) {
      console.error('Gagal cek state:', e);
    }
  }

  await set(ref(db, 'defaultUrl'), DEFAULT_STREAM_URL);
  await set(ref(db, 'state'), {
    currentUrl: DEFAULT_STREAM_URL,
    currentTitle: DEFAULT_STREAM_TITLE,
    playing: true,
    playbackStartTimestamp: Date.now() + serverOffset,
    videoPosition: 0,
    currentPlaylistIndex: -1,
    isDefault: true,
    isPlaylistItem: false,
    activePlaylistId: null
  });
}

// ===== STATE =====
// Tarik formula state ke currentTime host yang aktual (drift > 0.5s).
// Viewer mengejar formula → otomatis mengikuti host, tidak mendahui.
function startHostReanchor() {
  setInterval(() => {
    if (!timeSynced || !sessionActive) return;
    const state = currentState;
    if (!state.playing || !state.currentUrl || isYoutubeUrl(state.currentUrl)) return;
    if (!hostVideoPlayer.src || hostVideoPlayer.readyState < 2) return;
    const dur = hostVideoPlayer.duration;
    if (Number.isNaN(dur)) return;

    const actual = hostVideoPlayer.currentTime || 0;

    if (hostVideoPlayer.paused) {
      if (!reanchorPausedAt) reanchorPausedAt = Date.now();
      if (Date.now() - reanchorPausedAt < 4000) return;
      if (Date.now() - lastReanchorWrite < 4000) return;
    } else {
      reanchorPausedAt = 0;
    }

    const elapsed = (Date.now() + serverOffset - (state.playbackStartTimestamp || 0)) / 1000;
    const expected = (state.videoPosition || 0) + elapsed;

    if (Math.abs(actual - expected) > 0.5) {
      lastReanchorWrite = Date.now();
      update(ref(db, 'state'), {
        videoPosition: actual,
        playbackStartTimestamp: Date.now() + serverOffset
      });
    }
  }, 500);
}

function applyHostSync() {
  const state = currentState;
  if (isYoutubeUrl(state.currentUrl)) return;

  const mediaReady = hostVideoPlayer.readyState >= 2;

  if (state.playing) {
    if (hostVideoPlayer.paused && hostVideoPlayer.src && mediaReady) {
      tryPlay();
    }

    const canSeek = mediaReady && isFinite(hostVideoPlayer.duration) && hostVideoPlayer.duration > 0;
    if (canSeek && hostVideoPlayer.src && timeSynced) {
      const elapsed = (Date.now() + serverOffset - (state.playbackStartTimestamp || 0)) / 1000;
      const pos = (state.videoPosition || 0) + elapsed;
      if (pos >= 0 && pos < hostVideoPlayer.duration && Math.abs(hostVideoPlayer.currentTime - pos) > 2) {
        hostVideoPlayer.currentTime = pos;
      }
    }
  } else {
    if (!hostVideoPlayer.paused) hostVideoPlayer.pause();
    if (mediaReady && hostVideoPlayer.src && isFinite(hostVideoPlayer.duration) &&
        Math.abs(hostVideoPlayer.currentTime - (state.videoPosition || 0)) > 2) {
      hostVideoPlayer.currentTime = state.videoPosition || 0;
    }
  }
}

function listenState() {
  onValue(ref(db, 'state'), snap => {
    const state = snap.val() || {};
    currentState = state;

    if (state.currentUrl && state.currentUrl !== lastLoadedUrl) {
      lastLoadedUrl = state.currentUrl;
      loadVideo(state.currentUrl);
    }

    hostNowTitle.textContent = state.currentTitle || 'Tidak ada';
    btnPlayPause.textContent = state.playing ? '⏸' : '▶';

    applyHostSync();
  });
}

// ===== SCHEDULER =====
function startScheduler() {
  setInterval(checkSchedule, 1000);
}

async function checkSchedule() {
  if (!timeSynced || scheduleBusy || !sessionActive) return;
  scheduleBusy = true;

  try {
    const now = Date.now() + serverOffset;
    let matchedItem = null;
    let matchedTime = -Infinity;

    for (const item of playlistData) {
      if (item.status === 'completed' || !item.scheduledTime) continue;
      const t = new Date(item.scheduledTime).getTime();
      if (now >= t && t > matchedTime) {
        matchedItem = item;
        matchedTime = t;
      }
    }

    if (!matchedItem) return;
    if (currentState.activePlaylistId === matchedItem.id) return;

    if (
      currentState.isPlaylistItem &&
      currentState.activePlaylistId &&
      currentState.activePlaylistId !== matchedItem.id
    ) {
      const prev = playlistData.find(p => p.id === currentState.activePlaylistId);
      if (prev && prev.scheduledTime) {
        await update(ref(db, 'playlist/' + currentState.activePlaylistId), { status: 'completed' });
      }
    }

    await update(ref(db, 'playlist/' + matchedItem.id), { status: 'active' });
    const idx = playlistData.indexOf(matchedItem);
    await set(ref(db, 'state'), {
      currentUrl: matchedItem.url,
      currentTitle: matchedItem.title,
      currentPlaylistIndex: idx,
      playing: true,
      playbackStartTimestamp: Date.now() + serverOffset,
      videoPosition: 0,
      isPlaylistItem: true,
      activePlaylistId: matchedItem.id,
      isDefault: false
    });
  } finally {
    scheduleBusy = false;
  }
}

// ===== PLAYLIST =====
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function openReschedule(id) {
  const item = playlistData.find(p => p.id === id);
  if (!item) return;
  rescheduleId = id;
  rescheduleTitle.textContent = item.title;
  rescheduleInput.value = toDatetimeLocalValue(item.scheduledTime);
  rescheduleModal.classList.remove('hidden');
}

function closeReschedule() {
  rescheduleModal.classList.add('hidden');
  rescheduleId = null;
}

async function saveReschedule() {
  if (!rescheduleId) return;
  const item = playlistData.find(p => p.id === rescheduleId);
  if (!item) {
    closeReschedule();
    return;
  }

  const value = rescheduleInput.value;
  const patch = {};

  if (value) {
    patch.scheduledTime = new Date(value).toISOString();
    if (item.status === 'completed') patch.status = 'pending';
  } else {
    patch.scheduledTime = null;
    patch.status = 'pending';
  }

  await update(ref(db, 'playlist/' + rescheduleId), patch);
  closeReschedule();
}

function initPlaylist() {
  btnAddPlaylist.addEventListener('click', addPlaylistItem);
  inputUrl.addEventListener('keydown', e => { if (e.key === 'Enter') addPlaylistItem(); });
  inputTitle.addEventListener('keydown', e => { if (e.key === 'Enter') addPlaylistItem(); });

  rescheduleCancel.addEventListener('click', closeReschedule);
  rescheduleSave.addEventListener('click', saveReschedule);
  rescheduleModal.addEventListener('click', e => {
    if (e.target === rescheduleModal) closeReschedule();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !rescheduleModal.classList.contains('hidden')) closeReschedule();
  });

  onValue(ref(db, 'playlist'), snap => {
    const data = snap.val() || {};
    playlistData = Object.entries(data)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => {
        const ta = a.scheduledTime ? new Date(a.scheduledTime).getTime() : Infinity;
        const tb = b.scheduledTime ? new Date(b.scheduledTime).getTime() : Infinity;
        return ta - tb;
      });
    renderPlaylist();

    if (playlistData.length === 0 && currentState.currentUrl !== DEFAULT_STREAM_URL) {
      playDefault(true);
    } else if (
      currentState.isPlaylistItem &&
      currentState.activePlaylistId &&
      !playlistData.some(p => p.id === currentState.activePlaylistId)
    ) {
      playDefault(true);
    }
  });
}

async function addPlaylistItem() {
  const title = inputTitle.value.trim();
  const url = inputUrl.value.trim();
  const schedule = inputSchedule.value;
  if (!title || !url) return;

  const item = { title, url, status: 'pending' };
  if (schedule) item.scheduledTime = new Date(schedule).toISOString();

  await push(ref(db, 'playlist'), item);
  inputTitle.value = '';
  inputUrl.value = '';
  inputSchedule.value = '';
}

async function removePlaylistItem(id) {
  await remove(ref(db, 'playlist/' + id));
}

async function playPlaylistItem(idx) {
  const item = playlistData[idx];
  if (!item) return;
  if (item.scheduledTime) {
    await update(ref(db, 'playlist/' + item.id), { status: 'active' });
  }
  await set(ref(db, 'state'), {
    currentUrl: item.url,
    currentTitle: item.title,
    currentPlaylistIndex: idx,
    playing: true,
    playbackStartTimestamp: Date.now() + serverOffset,
    videoPosition: 0,
    isPlaylistItem: true,
    activePlaylistId: item.id,
    isDefault: false
  });
}

function renderPlaylist() {
  const now = Date.now() + serverOffset;

  playlistList.innerHTML = playlistData.map((item, i) => {
    let scheduleLabel = '';
    let badgeClass = '';

    if (item.scheduledTime) {
      const schedMs = new Date(item.scheduledTime).getTime();
      const schedDate = new Date(item.scheduledTime);
      const timeStr = schedDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      const dateStr = schedDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });

      if (item.status === 'completed') {
        scheduleLabel = 'Selesai';
        badgeClass = 'completed';
      } else if (now >= schedMs) {
        scheduleLabel = 'Sedang Tayang';
        badgeClass = 'active';
      } else {
        const diff = schedMs - now;
        const hrs = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        scheduleLabel = timeStr + ' ' + dateStr + ' (' + (hrs > 0 ? hrs + 'j ' : '') + mins + 'm lagi)';
        badgeClass = 'pending';
      }
    }

    const isActive = currentState.activePlaylistId === item.id;

    return '<div class="playlist-item ' + (isActive ? 'active' : '') + '" data-idx="' + i + '">' +
      '<span class="idx">' + (i + 1) + '</span>' +
      '<div class="info">' +
        '<div class="title">' + escapeHtml(item.title) + '</div>' +
        '<div class="url">' + escapeHtml(item.url) + '</div>' +
      '</div>' +
      (scheduleLabel ? '<span class="schedule-badge ' + badgeClass + '">' + scheduleLabel + '</span>' : '') +
      '<button class="btn-sched" data-id="' + item.id + '" title="Ubah jadwal">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>' +
      '</button>' +
      '<button class="btn-play" data-idx="' + i + '" title="Putar">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
      '</button>' +
      '<button class="btn-del" data-id="' + item.id + '" title="Hapus">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
    '</div>';
  }).join('');

  playlistList.querySelectorAll('.btn-sched').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openReschedule(btn.dataset.id);
    });
  });

  playlistList.querySelectorAll('.btn-play').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      playPlaylistItem(parseInt(btn.dataset.idx, 10));
    });
  });

  playlistList.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removePlaylistItem(btn.dataset.id);
    });
  });

  playlistList.querySelectorAll('.playlist-item').forEach(el => {
    el.addEventListener('dblclick', () => {
      playPlaylistItem(parseInt(el.dataset.idx, 10));
    });
  });
}

// ===== VIEWERS =====
function initViewers() {
  onValue(ref(db, 'users'), snap => {
    const users = snap.val() || {};
    let count = 0;
    let hostHtml = '';
    let userHtml = '';

    Object.values(users).forEach(u => {
      if (!u.online) return;
      count++;
      if (u.role === 'host') {
        hostHtml = '<div class="viewer-item-host">' +
          '<img src="' + escapeHtml(u.photo || '') + '" alt="">' +
          '<span class="name">' + escapeHtml(u.name) + '</span>' +
          '<span class="badge">HOST</span></div>';
      } else {
        userHtml += '<div class="viewer-item">' +
          '<img src="' + escapeHtml(u.photo || '') + '" alt="">' +
          '<span class="name">' + escapeHtml(u.name) + '</span>' +
          '<span class="online-dot"></span></div>';
      }
    });

    hostViewerCountTop.textContent = count;
    hostViewerCountBar.textContent = count;
    if (hostChatCount) hostChatCount.textContent = count;
    hostViewerSection.innerHTML = hostHtml || '<div class="viewer-empty">-</div>';
    viewerListSection.innerHTML = userHtml || '<div class="viewer-empty">Belum ada penonton</div>';
  });
}

// ===== CHAT =====
function initChat() {
  btnChatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  onChildAdded(ref(db, 'chat'), snap => {
    const msg = snap.val();
    if (msg) addChatMessage(msg, snap.key);
  });
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentUser) return;

  try {
    await push(ref(db, 'chat'), {
      uid: currentUser.uid,
      name: currentUser.displayName || 'Host',
      photo: currentUser.photoURL || '',
      message: text,
      timestamp: Date.now()
    });
    chatInput.value = '';
  } catch (e) {
    console.error('Gagal kirim chat:', e);
  }
}

function addChatMessage(msg, msgId) {
  const el = document.createElement('div');
  el.className = 'message chat-msg';
  const time = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : '';

  el.innerHTML =
    '<img src="' + escapeHtml(msg.photo || '') + '" alt="">' +
    '<div class="message-content">' +
      '<div class="message-top">' +
        '<strong>' + escapeHtml(msg.name) + '</strong>' +
        '<small>' + time + '</small>' +
      '</div>' +
      '<p>' + escapeHtml(msg.message) + '</p>' +
    '</div>' +
    '<button class="chat-delete" title="Hapus">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
    '</button>';

  el.querySelector('.chat-delete').addEventListener('click', async () => {
    if (msgId) {
      await remove(ref(db, 'chat/' + msgId));
      el.remove();
    }
  });

  chatMessages.appendChild(el);

  while (chatMessages.children.length > 200) {
    chatMessages.removeChild(chatMessages.firstChild);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===== NEXT FILM COUNTDOWN =====
function startNextFilmCountdown() {
  setInterval(updateNextFilmInfo, 1000);
}

function updateNextFilmInfo() {
  const now = Date.now() + serverOffset;

  const nextItem = playlistData.find(item => {
    if (!item.scheduledTime) return false;
    if (item.status === 'completed' || item.status === 'active') return false;
    if (currentState.activePlaylistId === item.id) return false;
    return new Date(item.scheduledTime).getTime() > now;
  });

  if (!nextItem) {
    if (nextFilmBar) nextFilmBar.classList.add('hidden');
    if (nextFilmBarCountdown) {
      nextFilmBarCountdown.classList.add('hidden');
      nextFilmBarCountdown.textContent = '--:--';
    }
    if (infoSep) infoSep.classList.add('hidden');
    return;
  }

  const diff = new Date(nextItem.scheduledTime).getTime() - now;
  const totalSec = Math.floor(diff / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  let timeStr = '';
  if (hrs > 0) timeStr += hrs + 'j ';
  timeStr += mins + 'm ' + (secs < 10 ? '0' : '') + secs + 'd';

  if (nextFilmBarTitle) nextFilmBarTitle.textContent = nextItem.title;
  if (nextFilmBarCountdown) {
    nextFilmBarCountdown.textContent = timeStr;
    nextFilmBarCountdown.classList.remove('hidden');
  }
  if (nextFilmBar) nextFilmBar.classList.remove('hidden');
  if (infoSep) infoSep.classList.remove('hidden');
}

// ===== FULLSCREEN =====
function initFullscreen() {
  const btnFS = $('btnFullscreen');
  const btnFSAlt = $('btnFullscreenAlt');

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      $('hostPlayer').requestFullscreen().catch(() => {});
    }
  };

  btnFS.addEventListener('click', toggleFullscreen);
  if (btnFSAlt) btnFSAlt.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      btnFS.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    } else {
      btnFS.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }
  });
}
