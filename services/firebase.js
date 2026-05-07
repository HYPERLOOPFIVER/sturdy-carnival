import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let db;

export function initFirebase() {
  if (admin.apps.length === 0) {
    let serviceAccount;

    // 1. Try reading from Environment Variable (Best for Production)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        console.log('✅ Parsed service account keys:', Object.keys(serviceAccount).join(', '));
      } catch (err) {
        console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err.message);
      }
    }

    // 2. Fallback to serviceAccountKey.json file (Local Dev)
    if (!serviceAccount) {
      const keyPath = resolve(__dirname, '..', 'serviceAccountKey.json');
      if (existsSync(keyPath)) {
        serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8'));
        console.log('✅ Loading Firebase from serviceAccountKey.json');
      }
    }

    if (!serviceAccount) {
      throw new Error(
        `❌ No Firebase credentials found.\n` +
        `   Set FIREBASE_SERVICE_ACCOUNT_JSON env var or place serviceAccountKey.json in the backend/ folder.`
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: `${serviceAccount.project_id}.firebasestorage.app`
    });
  }

  db = admin.firestore();
  console.log('✅ Firebase Admin initialized');
  return db;
}

export function getDb() {
  if (!db) return initFirebase();
  return db;
}

// ─── Clinic Lookup ────────────────────────────────────────────
export async function getClinicByForwardedNumber(forwardedNumber) {
  const normalized = normalizeNumber(forwardedNumber);
  const snapshot = await getDb()
    .collection('clinics')
    .where('forwardedNumber', '==', normalized)
    .where('isActive', '==', true)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

export async function getClinicById(clinicId) {
  const doc = await getDb().collection('clinics').doc(clinicId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// ─── Appointment CRUD ─────────────────────────────────────────
export async function bookAppointment(clinicId, appointmentData) {
  const ref = await getDb()
    .collection('clinics')
    .doc(clinicId)
    .collection('appointments')
    .add({
      ...appointmentData,
      status: 'confirmed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  return ref.id;
}

export async function getAppointmentsByDate(clinicId, date) {
  const snapshot = await getDb()
    .collection('clinics')
    .doc(clinicId)
    .collection('appointments')
    .where('date', '==', date)
    .where('status', '==', 'confirmed')
    .orderBy('time')
    .get();

  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Call Log ─────────────────────────────────────────────────
export async function logCall(clinicId, callData) {
  await getDb()
    .collection('clinics')
    .doc(clinicId)
    .collection('callLogs')
    .add({
      ...callData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

// ─── Conversation State ───────────────────────────────────────
// In-memory store for active call sessions (use Redis in production)
const sessions = new Map();

export function getSession(callSid) {
  return sessions.get(callSid) || null;
}

export function setSession(callSid, data) {
  sessions.set(callSid, data);
}

export function deleteSession(callSid) {
  sessions.delete(callSid);
}

// ─── Helpers ─────────────────────────────────────────────────
function normalizeNumber(num) {
  if (!num) return '';
  // Strip all non-digits
  const digits = num.replace(/\D/g, '');
  // Handle Indian numbers: remove leading 91 country code
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}
