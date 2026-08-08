/**
 * db.js — MEDHAS Database Abstraction Layer
 *
 * Current Storage: SQLite via better-sqlite3 (Zero-config, fast, local persistence).
 * File:            medhas.db in project root.
 *
 * ── FIREBASE INTEGRATION GUIDE ────────────────────────────────────────────────
 * To switch to Firebase Firestore:
 * 1. Run: npm install firebase-admin
 * 2. Add your serviceAccountKey.json to the project root.
 * 3. Replace the SQLite implementations below with Firebase calls (or uncomment
 *    the Firebase Firestore section). All server routes call these methods, so
 *    switching databases requires 0 changes to server.js!
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, 'medhas.db');

// ── Open / create database ───────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');       // better concurrent read performance
db.pragma('foreign_keys = ON');

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT 'New Chat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK(role IN ('user','ai')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session  ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated  ON sessions(updated_at DESC);
`);

console.log(`[DB] SQLite database ready → ${DB_PATH}`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  insertSession:      db.prepare('INSERT INTO sessions (id,title,created_at,updated_at) VALUES (?,?,?,?)'),
  updateSessionTitle: db.prepare('UPDATE sessions SET title=?, updated_at=? WHERE id=?'),
  touchSession:       db.prepare('UPDATE sessions SET updated_at=? WHERE id=?'),
  deleteSession:      db.prepare('DELETE FROM sessions WHERE id=?'),
  getSessions:        db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC'),
  getSession:         db.prepare('SELECT * FROM sessions WHERE id=?'),

  insertMessage:      db.prepare('INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)'),
  getMessages:        db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC'),
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new session.
 * @param {string} [title]
 * @returns {{ id, title, created_at, updated_at }}
 */
export function createSession(title = 'New Chat') {
  const now = Date.now();
  const id  = randomUUID();
  stmts.insertSession.run(id, title, now, now);
  return { id, title, created_at: now, updated_at: now };
}

/**
 * Get a single session by id.
 * @param {string} id
 */
export function getSession(id) {
  return stmts.getSession.get(id) ?? null;
}

/**
 * Return all sessions sorted newest first.
 */
export function getSessions() {
  return stmts.getSessions.all();
}

/**
 * Add a message to a session. Also bumps the session's updated_at.
 * @param {string} sessionId
 * @param {'user'|'ai'} role
 * @param {string} content
 */
export function addMessage(sessionId, role, content) {
  const now = Date.now();
  const id  = randomUUID();
  stmts.insertMessage.run(id, sessionId, role, content, now);
  stmts.touchSession.run(now, sessionId);
  return { id, session_id: sessionId, role, content, created_at: now };
}

/**
 * Return all messages for a session in chronological order.
 * @param {string} sessionId
 */
export function getMessages(sessionId) {
  return stmts.getMessages.all(sessionId);
}

/**
 * Update the title of a session (called after first user message).
 * @param {string} sessionId
 * @param {string} title
 */
export function updateSessionTitle(sessionId, title) {
  stmts.updateSessionTitle.run(title.slice(0, 80), Date.now(), sessionId);
}

/**
 * Delete a session and cascade-delete its messages.
 * @param {string} sessionId
 */
export function deleteSession(sessionId) {
  stmts.deleteSession.run(sessionId);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   FIREBASE FIRESTORE ADAPTER TEMPLATE
   Uncomment and use this block if you wish to swap SQLite for Firebase Firestore.
   ═══════════════════════════════════════════════════════════════════════════════

import admin from 'firebase-admin';
import serviceAccount from './serviceAccountKey.json' assert { type: 'json' };

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const firestore = admin.firestore();

export async function createSessionFirebase(title = 'New Chat') {
  const id = randomUUID();
  const now = Date.now();
  const sessionData = { id, title, created_at: now, updated_at: now };
  await firestore.collection('sessions').doc(id).set(sessionData);
  return sessionData;
}

export async function addMessageFirebase(sessionId, role, content) {
  const id = randomUUID();
  const now = Date.now();
  const msg = { id, session_id: sessionId, role, content, created_at: now };
  await firestore.collection('sessions').doc(sessionId).collection('messages').doc(id).set(msg);
  await firestore.collection('sessions').doc(sessionId).update({ updated_at: now });
  return msg;
}

export async function getMessagesFirebase(sessionId) {
  const snap = await firestore.collection('sessions').doc(sessionId).collection('messages').orderBy('created_at', 'asc').get();
  return snap.docs.map(doc => doc.data());
}
*/
