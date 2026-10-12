import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

/* Accepts either one JSON variable, or the three separate variables some
   setups use. The private key arrives with escaped newlines from Netlify. */
function credentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  };
}

const app = getApps()[0] || initializeApp({ credential: cert(credentials()) });

/* The app's data lives in the named database "brigvanti", not "(default)". */
export const db = getFirestore(app, 'brigvanti');
export const adminAuth = getAuth(app);
