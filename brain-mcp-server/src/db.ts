#!/usr/bin/env node
/**
 * SQLite Database Helper for Igris Brain
 *
 * Provides connection management with WAL mode, busy_timeout,
 * and trusted_schema pragmas. Uses a singleton pattern to ensure
 * a single database connection per MCP server process.
 *
 * @module db
 * @author Fifty.ai
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';

/** Root directory for the Igris brain */
const BRAIN_DIR = path.join(os.homedir(), '.igris');

/** Path to the SQLite knowledge database */
const DB_PATH = path.join(BRAIN_DIR, 'memory', 'knowledge.db');

/** Singleton database instance */
let _db: Database.Database | null = null;

/**
 * Get the singleton database connection.
 * Initializes with WAL mode, busy timeout, and foreign keys on first call.
 *
 * @returns The SQLite database instance
 */
function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('trusted_schema = ON');
  }
  return _db;
}

/**
 * Close the database connection and clear the singleton.
 */
function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export { getDb, closeDb, BRAIN_DIR, DB_PATH };
