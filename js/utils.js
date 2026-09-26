export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function userAvatarHtml(user) {
  const photo = user.photo
    ? '<img src="' + escapeHtml(user.photo) + '" alt="">'
    : '<div class="message-avatar">' + escapeHtml(String(user.name || '?').charAt(0).toUpperCase()) + '</div>';
  return photo + '<span class="name">' + escapeHtml(user.name || '?') + '</span>';
}

export const FS_TITLE_Y_DEFAULT = 4;
export const FS_TITLE_Y_MIN = 0;
export const FS_TITLE_Y_MAX = 60;
export const FS_TITLE_Y_STEP = 2;

export function clampFsTitleY(value) {
  const n = Number(value);
  const safe = isFinite(n) ? Math.round(n) : FS_TITLE_Y_DEFAULT;
  return Math.min(FS_TITLE_Y_MAX, Math.max(FS_TITLE_Y_MIN, safe));
}

export function applyFsTitleY(player, value) {
  if (!player) return FS_TITLE_Y_DEFAULT;
  const v = clampFsTitleY(value);
  player.style.setProperty('--fs-title-y', v + '%');
  return v;
}

export function isDesktopPointer() {
  return window.matchMedia('(pointer: fine)').matches;
}

export function requestDocumentFullscreen() {
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) {
    return Promise.resolve();
  }
  return document.documentElement.requestFullscreen().catch(() => {});
}

function hideFullscreenHint() {
  const el = document.getElementById('fsToast');
  if (el) el.classList.add('hidden');
}

export function showFullscreenHint() {
  if (!isDesktopPointer() || document.fullscreenElement) return;

  let el = document.getElementById('fsToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fsToast';
    el.className = 'fs-toast hidden';
    el.textContent = 'Klik untuk layar penuh (atau tekan F11)';
    el.addEventListener('click', () => {
      requestDocumentFullscreen();
      hideFullscreenHint();
    });
    document.body.appendChild(el);
  }

  el.classList.remove('hidden');
  clearTimeout(showFullscreenHint._timer);
  showFullscreenHint._timer = setTimeout(hideFullscreenHint, 4000);
}
