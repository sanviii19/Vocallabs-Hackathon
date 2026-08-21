import { Database } from "bun:sqlite";

export function openDb(path: string = "field-agent.sqlite"): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");

  db.run(`
    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dropout_base_rate REAL NOT NULL,
      mu REAL,
      sigma REAL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rider_id TEXT NOT NULL,
      ts REAL NOT NULL,
      anomaly_score REAL NOT NULL,
      stage2_confidence REAL,
      rationale TEXT NOT NULL,
      tier_before TEXT NOT NULL,
      tier_after TEXT NOT NULL,
      source TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS mock_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rider_id TEXT NOT NULL,
      ts REAL NOT NULL,
      channel TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rider_id TEXT NOT NULL,
      opened_ts REAL NOT NULL,
      resolved_ts REAL,
      final_tier TEXT NOT NULL,
      resolution_reason TEXT
    );
  `);

  return db;
}
