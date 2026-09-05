import Database from 'better-sqlite3';

const databasePath = process.env.DB_PATH || './routerdeck.db';
const db = new Database(databasePath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

let closed = false;

export function closeDatabase() {
  if (closed) return;
  closed = true;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {}
  try {
    db.close();
  } catch (error) {
    console.error('[db] Failed to close SQLite cleanly:', error?.message || error);
  }
}

export function databaseStatus() {
  return { path: databasePath, open: !closed };
}

export default db;
