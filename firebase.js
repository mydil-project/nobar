import { initializeApp }
from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import { getDatabase }
from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { getAuth, GoogleAuthProvider }
from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAwl79E_oCNdDqhXL8nWG-irMRievWrFIE",
  authDomain: "nobar-project.firebaseapp.com",
  databaseURL: "https://nobar-project-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nobar-project",
  storageBucket: "nobar-project.firebasestorage.app",
  messagingSenderId: "581062726322",
  appId: "1:581062726322:web:4ed1b67abf58d9024fefab"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

export { db, auth, provider };
