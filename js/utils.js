export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Avatar (huruf + foto) — SATU sumber kebenaran untuk chat & daftar penonton.
// Huruf selalu ada di dalam .message-avatar, foto menimpanya (position:absolute),
// dan onerror menghapus foto kalau URL gagal dimuat → huruf tetap tampil.
// Jangan emit <img> polos: URL foto Google yang gagal = ikon gambar rusak / kotak
// kosong yang menutupi huruf, bukan "profil tidak tampil".
export function avatarHtml(name, photo) {
  const initial = escapeHtml(String(name || '?').charAt(0).toUpperCase());
  const img = photo
    ? '<img src="' + escapeHtml(photo) + '" alt="" onerror="this.remove()">'
    : '';
  return '<div class="message-avatar">' + initial + img + '</div>';
}

export function userAvatarHtml(user) {
  return avatarHtml(user.name, user.photo) +
    '<span class="name">' + escapeHtml(user.name || '?') + '</span>';
}

// Jaring pengaman gambar, dipasang SETELAH html masuk DOM (innerHTML).
// Atribut onerror inline punya celah: kalau URL-nya sudah ada di cache dan gagal,
// event 'error' bisa menyala sebelum handler terpasang sehingga tidak pernah
// dijalankan dan huruf di baliknya tidak pernah terekspos. addEventListener +
// cek `complete && naturalWidth === 0` menutup celah itu.
export function guardAvatarImages(root) {
  if (!root || !root.querySelectorAll) return;
  const imgs = root.querySelectorAll('img'); // NodeList statis → aman dihapus saat loop
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    // Penanda pakai properti JS (bukan dataset) supaya proteksi tetap dipasang
    // di browser lama yang tidak punya HTMLElement.dataset.
    if (img.avatarGuard) continue;
    img.avatarGuard = true;
    img.addEventListener('error', () => img.remove(), { once: true });
    if (img.complete && img.naturalWidth === 0) img.remove();
  }
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
