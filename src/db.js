import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";

export const HOME = process.env.T3LITE_HOME || join(homedir(), ".t3lite");
export const WORKTREES = join(HOME, "worktrees");
mkdirSync(WORKTREES, { recursive: true });

const db = new DatabaseSync(join(HOME, "t3lite.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New thread',
    worktree_path TEXT,
    agent TEXT NOT NULL DEFAULT 'pi',
    session_file TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_thread_seq ON items(thread_id, seq);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const now = () => Date.now();
const uid = () => crypto.randomUUID();

export function listProjects() {
  return db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all();
}

export function getProject(id) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

export function addProject({ name, path }) {
  const id = uid();
  db.prepare(
    "INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, name || path.split("/").filter(Boolean).pop() || path, path, now());
  return getProject(id);
}

export function listThreads() {
  return db
    .prepare("SELECT * FROM threads ORDER BY updated_at DESC")
    .all();
}

export function getThread(id) {
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
}

export function addThread({ projectId, title, worktreePath, agent }) {
  const id = uid();
  const t = now();
  db.prepare(
    `INSERT INTO threads (id, project_id, title, worktree_path, agent, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`
  ).run(id, projectId, title || "New thread", worktreePath || null, agent || "pi", t, t);
  return getThread(id);
}

export function updateThread(id, fields) {
  const allowed = ["title", "worktree_path", "session_file", "status", "agent"];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getThread(id);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE threads SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    now(),
    id
  );
  return getThread(id);
}

export function deleteThread(id) {
  db.prepare("DELETE FROM items WHERE thread_id = ?").run(id);
  db.prepare("DELETE FROM threads WHERE id = ?").run(id);
}

export function appendItem(threadId, type, payload) {
  const id = uid();
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM items WHERE thread_id = ?")
    .get(threadId);
  const seq = row.seq;
  const createdAt = now();
  const json = JSON.stringify(payload ?? {});
  db.prepare(
    "INSERT INTO items (id, thread_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, threadId, seq, type, json, createdAt);
  db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(createdAt, threadId);
  return { id, threadId, seq, type, payload, createdAt };
}

export function listItems(threadId, after = 0) {
  return db
    .prepare(
      "SELECT * FROM items WHERE thread_id = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(threadId, after)
    .map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
    }));
}

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
