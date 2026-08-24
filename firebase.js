import { initializeApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyCRLwNVveYk89PFHOVC1GHVY99Q1P8LESE",
  authDomain: "memorymap-web-3a40d.firebaseapp.com",
  projectId: "memorymap-web-3a40d",
  storageBucket: "memorymap-web-3a40d.firebasestorage.app",
  messagingSenderId: "942069672579",
  appId: "1:942069672579:web:c755f915140d8ffe5c09b6",
  measurementId: "G-VC2QJM13QX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Persist user login session in browser
setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error("Auth persistence error:", error);
});
