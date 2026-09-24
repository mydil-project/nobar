import { db, auth, provider, HOST_UID } from './firebase.js';
import {
  ref, update, set, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  signInWithPopup, signInWithRedirect, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const $ = id => document.getElementById(id);
const btnLogin = $('btnGoogleLogin');
const loginError = $('loginError');

let routing = false;

async function routeAfterLogin(user) {
  if (routing) return;
  routing = true;

  try {
    const userRef = ref(db, 'users/' + user.uid);

    if (user.uid === HOST_UID) {
      await set(userRef, {
        name: user.displayName || 'Host',
        email: user.email || '',
        photo: user.photoURL || '',
        role: 'host',
        online: true,
        lastSeen: serverTimestamp()
      });
      location.replace('host.html');
      return;
    }

    await update(userRef, {
      name: user.displayName || 'Penonton',
      email: user.email || '',
      photo: user.photoURL || '',
      role: 'viewer',
      online: true,
      lastSeen: serverTimestamp()
    });

    location.replace('index.html');
  } catch (e) {
    routing = false;
    loginError.textContent = 'Gagal menyiapkan akun: ' + (e && e.message ? e.message : e);
  }
}

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

onAuthStateChanged(auth, user => {
  if (user) routeAfterLogin(user);
});
