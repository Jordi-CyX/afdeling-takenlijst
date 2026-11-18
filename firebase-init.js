import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBsAYMNFlgylSFmsc4-zsY74hgm4byReXg",
  authDomain: "zeiklijst-live.firebaseapp.com",
  projectId: "zeiklijst-live",
  storageBucket: "zeiklijst-live.firebasestorage.app",
  messagingSenderId: "83500458235",
  appId: "1:83500458235:web:401d87dc16e0feb503d05e"
};

export const ADMIN_UID = "Of3mAU2qJeczN6NDUfkgT73kfJn1";
export const ADMIN_EMAIL = "j.g_vdbos@outlook.com";

export const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
export const auth = getAuth(app);

export { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut };
