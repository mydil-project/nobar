import { db, auth, provider } from './firebase.js';
import { escapeHtml } from './utils.js';
import {
  ref, onValue, onChildAdded, push, update, get, serverTimestamp, onDisconnect as fbOnDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// DOM
const $ = id => document.getElementById(id);
const loginScreen = $('loginScreen');
const userPage = $('userPage');
const btnLogin = $('btnGoogleLogin');
const loginError = $('loginError');
const userPhoto = $('userPhoto');
const userName = $('userName');
const userViewerCountTop = $('userViewerCountTop');
const userChatCount = $('userChatCount');
const userNowTitle = $('userNowTitle');
const userVideoPlayer = $('userVideoPlayer');
const userYoutubeFrame = $('userYoutubeFrame');
const userNoVideo = $('userNoVideo');
const hostViewerSection = $('hostViewerSection');
const viewerListSection = $('viewerListSection');
const chatMessages = $('chatMessages');
const chatInput = $('chatInput');
const btnChatSend = $('btnChatSend');
const nextFilmBar = $('nextFilmBar');
const nextFilmBarTitle = $('nextFilmBarTitle');
const nextFilmBarCountdown = $('nextFilmBarCountdown');
const infoSep = $('infoSep');
const userViewerCountBar = $('userViewerCountBar');
const viewerModeBadge = $('viewerModeBadge');

const DEFAULT_STREAM_URL = 'https://3ea22335.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/UmFrdXRlblRWLWdiX1JlZEJ1bGxUVl9ITFM/playlist.m3u8';
const DEFAULT_STREAM_TITLE = 'Red Bull TV';

let hls = null;
let currentUser = null;
let serverOffset = 0;
let playlistData = [];
let currentState = {};
let lastLoadedUrl = '';
let inited = false;
let presenceBound = false;
let watchMode = 'sync';
let pendingAsyncPos = null;
let asyncActiveId = null;
let asyncGapId = null;

// ===== HELPERS =====
function isYoutubeUrl(url) {
  return typeof url === 'string' && /(?:youtube\.com|youtu\.be)/.test(url);
}

function parseYoutubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// ===== FIREBASE OFFSET =====
onValue(ref(db, '.info/serverTimeOffset'), snap => { serverOffset = snap.val() || 0; });

// ===== AUTH =====
btnLogin.addEventListener('click', async () => {
  try {
    loginError.textContent = '';
    await signInWithPopup(auth, provider);
  } catch (e) {
    loginError.textContent = 'Gagal login: ' + e.message;
  }
});

onAuthStateChanged(auth, user => {
  if (user) {
    currentUser = user;
    registerViewer(user);
    loginScreen.classList.add('hidden');
    userPage.classList.remove('hidden');
    userPhoto.src = user.photoURL || '';
    userName.textContent = user.displayName || 'Penonton';
    initAll();
  } else {
    currentUser = null;
    loginScreen.classList.remove('hidden');
    userPage.classList.add('hidden');
  }
});

async function registerViewer(user) {
  const userRef = ref(db, 'users/' + user.uid);
  let prev = {};
  try {
    const snap = await get(userRef);
    prev = snap.val() || {};
  } catch (_) {}

  await update(userRef, {
    name: user.displayName || 'Penonton',
    email: user.email || '',
    photo: user.photoURL || '',
    role: prev.role === 'host' ? 'host' : 'viewer',
    online: true,
    lastSeen: serverTimestamp()
  });

  if (presenceBound) return;
  presenceBound = true;

  onValue(ref(db, '.info/connected'), snap2 => {
    if (snap2.val() && currentUser) {
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
async function initAll() {
  if (inited) return;
  inited = true;

  try {
    const snap = await get(ref(db, 'settings/syncMode'));
    watchMode = snap.val() === 'async' ? 'async' : 'sync';
  } catch (_) {}

  initPlayer();
  initViewers();
  initChat();
  listenSyncMode();
  listenState();
  listenPlaylistMeta();
  startNextFilmCountdown();
  initFullscreen();

  $('btnLogout').addEventListener('click', async () => {
    if (currentUser) {
      await update(ref(db, 'users/' + currentUser.uid), { online: false });
    }
    await signOut(auth);
  });
}

// ===== PLAYER (sinkron saja, tanpa kontrol) =====
function initPlayer() {
  userVideoPlayer.addEventListener('contextmenu', e => e.preventDefault());
  userVideoPlayer.addEventListener('play', () => {});
  userVideoPlayer.addEventListener('pause', () => {});

  userVideoPlayer.addEventListener('ended', () => {
    if (watchMode !== 'async') return;
    if (asyncActiveId) enterAsyncGap(asyncActiveId);
  });

  userVideoPlayer.addEventListener('loadedmetadata', () => {
    if (watchMode === 'async') applyAsyncAfterLoad();
  });
}

function hideYoutubeFrame() {
  userYoutubeFrame.style.display = 'none';
  userYoutubeFrame.setAttribute('src', 'about:blank');
}

function stopVideoElements() {
  if (hls) { hls.destroy(); hls = null; }
  userVideoPlayer.pause();
  userVideoPlayer.removeAttribute('src');
  userVideoPlayer.load();
}

function loadVideo(url) {
  if (!url) {
    stopVideoElements();
    userVideoPlayer.style.display = 'none';
    hideYoutubeFrame();
    userNoVideo.classList.remove('hidden');
    return;
  }

  userNoVideo.classList.add('hidden');

  if (isYoutubeUrl(url)) {
    const ytId = parseYoutubeId(url);
    stopVideoElements();
    userVideoPlayer.style.display = 'none';
    if (ytId) {
      userYoutubeFrame.style.display = 'block';
      let embed = 'https://www.youtube.com/embed/' + ytId + '?autoplay=1&rel=0';
      if (watchMode === 'async' && pendingAsyncPos != null && pendingAsyncPos > 0) {
        embed += '&start=' + Math.floor(pendingAsyncPos);
        pendingAsyncPos = null;
      }
      if (userYoutubeFrame.getAttribute('src') !== embed) {
        userYoutubeFrame.setAttribute('src', embed);
      }
    }
    return;
  }

  hideYoutubeFrame();
  userVideoPlayer.style.display = 'block';

  const isHls = url.includes('.m3u8') || url.includes('m3u8');
  if (hls) { hls.destroy(); hls = null; }

  if (isHls) {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(url);
      hls.attachMedia(userVideoPlayer);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyPlaybackAfterLoad();
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          console.error('HLS error:', data.type, data.details);
          if (hls) {
            try { hls.startLoad(); } catch (_) {}
          }
        }
      });
    } else if (userVideoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      userVideoPlayer.src = url;
      applyPlaybackAfterLoad();
    }
  } else {
    userVideoPlayer.src = url;
    applyPlaybackAfterLoad();
  }
}

function applyPlaybackAfterLoad() {
  if (watchMode === 'async') applyAsyncAfterLoad();
  else syncPlayback(true);
}

// ===== SINKRONISASI DENGAN HOST =====
function expectedPosition(state) {
  if (state.playing) {
    const elapsed = (Date.now() + serverOffset - (state.playbackStartTimestamp || 0)) / 1000;
    return (state.videoPosition || 0) + elapsed;
  }
  return state.videoPosition || 0;
}

function syncPlayback(force = false) {
  if (watchMode === 'async') return;
  const state = currentState;
  if (!state.currentUrl || isYoutubeUrl(state.currentUrl)) return;

  const canSeek = isFinite(userVideoPlayer.duration) && userVideoPlayer.duration > 0;
  const srcReady = !!userVideoPlayer.src;

  if (state.playing) {
    if (userVideoPlayer.paused && srcReady) {
      userVideoPlayer.play().catch(() => {});
    }

    if (canSeek && srcReady) {
      const pos = expectedPosition(state);
      const drift = Math.abs(userVideoPlayer.currentTime - pos);

      // Host pause sudah jalan → user mengikuti (termasuk lompat menit bila drift)
      if (pos >= 0 && pos < userVideoPlayer.duration && (force || drift > 2)) {
        userVideoPlayer.currentTime = pos;
      }
    }
  } else {
    if (!userVideoPlayer.paused) userVideoPlayer.pause();
    if (canSeek && srcReady) {
      const target = state.videoPosition || 0;
      if (force || Math.abs(userVideoPlayer.currentTime - target) > 2) {
        userVideoPlayer.currentTime = target;
      }
    }
  }
}

// ===== MODE SYNC/ASYNC (diatur host via settings/syncMode) =====
function renderViewerModeBadge() {
  const isAsync = watchMode === 'async';
  viewerModeBadge.textContent = isAsync ? '● Mandiri (jadwal)' : '● Sinkron host';
  viewerModeBadge.classList.toggle('sync', !isAsync);
  viewerModeBadge.classList.toggle('async', isAsync);
}

function resetAsyncTracking() {
  pendingAsyncPos = null;
  asyncActiveId = null;
  asyncGapId = null;
}

function listenSyncMode() {
  renderViewerModeBadge();

  onValue(ref(db, 'settings/syncMode'), snap => {
    const mode = snap.val() === 'async' ? 'async' : 'sync';
    const changed = mode !== watchMode;
    watchMode = mode;
    renderViewerModeBadge();

    if (!changed) return;

    if (mode === 'async') {
      resetAsyncTracking();
      lastLoadedUrl = '';
      tickAsync();
    } else {
      resetAsyncTracking();
      lastLoadedUrl = '';
      if (currentState.currentUrl) {
        lastLoadedUrl = currentState.currentUrl;
        loadVideo(currentState.currentUrl);
      }
      userNowTitle.textContent = currentState.currentTitle || 'Menunggu host...';
      syncPlayback(true);
    }
  });
}

function asyncSwitchTo(url, title, id, pos) {
  if (title) userNowTitle.textContent = title;
  if (url === lastLoadedUrl && id === asyncActiveId) return;
  lastLoadedUrl = url;
  asyncActiveId = id;
  pendingAsyncPos = pos;
  loadVideo(url);
}

function enterAsyncGap(id) {
  asyncGapId = id;
  pendingAsyncPos = null;
  asyncSwitchTo(DEFAULT_STREAM_URL, DEFAULT_STREAM_TITLE, null, null);
}

function applyAsyncAfterLoad() {
  if (watchMode !== 'async') return;
  userVideoPlayer.play().catch(() => {});

  const pos = pendingAsyncPos;
  if (pos == null) return;

  const d = userVideoPlayer.duration;
  if (!isFinite(d) || d <= 0) return;

  if (pos >= d) {
    pendingAsyncPos = null;
    if (asyncActiveId) enterAsyncGap(asyncActiveId);
    return;
  }

  userVideoPlayer.currentTime = pos;
  pendingAsyncPos = null;
}

function tickAsync() {
  if (watchMode !== 'async') return;

  const now = Date.now() + serverOffset;
  let active = null;
  for (const item of playlistData) {
    if (!item.scheduledTime) continue;
    const t = new Date(item.scheduledTime).getTime();
    if (now >= t) active = item;
  }

  if (!active) {
    asyncGapId = null;
    asyncSwitchTo(DEFAULT_STREAM_URL, DEFAULT_STREAM_TITLE, null, null);
    return;
  }

  if (asyncGapId === active.id) {
    asyncSwitchTo(DEFAULT_STREAM_URL, DEFAULT_STREAM_TITLE, null, null);
    return;
  }

  const pos = (now - new Date(active.scheduledTime).getTime()) / 1000;

  if (active.id !== asyncActiveId || active.url !== lastLoadedUrl) {
    asyncGapId = null;
    asyncActiveId = active.id;
    pendingAsyncPos = pos;
    userNowTitle.textContent = active.title;
    lastLoadedUrl = active.url;
    loadVideo(active.url);
    return;
  }

  if (isYoutubeUrl(active.url)) return;

  const d = userVideoPlayer.duration;
  if (isFinite(d) && d > 0) {
    if (pos >= d) {
      enterAsyncGap(active.id);
      return;
    }
    if (Math.abs(userVideoPlayer.currentTime - pos) > 2) {
      userVideoPlayer.currentTime = pos;
    }
  }
  if (userVideoPlayer.paused && userVideoPlayer.src) {
    userVideoPlayer.play().catch(() => {});
  }
}

function listenState() {
  onValue(ref(db, 'state'), snap => {
    const state = snap.val() || {};
    currentState = state;

    if (watchMode === 'async') return;

    if (state.currentUrl && state.currentUrl !== lastLoadedUrl) {
      lastLoadedUrl = state.currentUrl;
      loadVideo(state.currentUrl);
    }

    userNowTitle.textContent = state.currentTitle || 'Menunggu host...';

    syncPlayback();
  });

  // Tarik sinkron berkala (host pause / lompat menit → user ikut); async → ikut jadwal
  setInterval(() => {
    if (watchMode === 'async') tickAsync();
    else syncPlayback();
  }, 1000);
}

// ===== PLAYLIST META (read-only: info selanjutnya + jadwal async) =====
function listenPlaylistMeta() {
  onValue(ref(db, 'playlist'), snap => {
    const data = snap.val() || {};
    playlistData = Object.entries(data)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => {
        const ta = a.scheduledTime ? new Date(a.scheduledTime).getTime() : Infinity;
        const tb = b.scheduledTime ? new Date(b.scheduledTime).getTime() : Infinity;
        return ta - tb;
      });
    updateNextFilmInfo();
    if (watchMode === 'async') tickAsync();
  });
}

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

    userViewerCountTop.textContent = count;
    userViewerCountBar.textContent = count;
    if (userChatCount) userChatCount.textContent = count;
    hostViewerSection.innerHTML = hostHtml || '<div class="viewer-empty">Host offline</div>';
    viewerListSection.innerHTML = userHtml || '<div class="viewer-empty">Belum ada penonton</div>';
  });
}

// ===== CHAT (tanpa tombol hapus) =====
function initChat() {
  btnChatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  onChildAdded(ref(db, 'chat'), snap => {
    const msg = snap.val();
    if (msg) addChatMessage(msg);
  });
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentUser) return;

  try {
    await push(ref(db, 'chat'), {
      uid: currentUser.uid,
      name: currentUser.displayName || 'Penonton',
      photo: currentUser.photoURL || '',
      message: text,
      timestamp: Date.now()
    });
    chatInput.value = '';
  } catch (e) {
    console.error('Gagal kirim chat:', e);
  }
}

function addChatMessage(msg) {
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
    '</div>';

  chatMessages.appendChild(el);

  while (chatMessages.children.length > 200) {
    chatMessages.removeChild(chatMessages.firstChild);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===== FULLSCREEN (lihat saja, bukan kontrol playback) =====
function initFullscreen() {
  const btn = $('btnUserFullscreen');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      $('userPlayer').requestFullscreen().catch(() => {});
    }
  });
}
