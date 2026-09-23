import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let database;

function connect() {
  if (database) return database;
  const dataDir = process.env.BANBAN_WEB_DATA_DIR || join(process.cwd(), "data", "web");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, "web.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS test_tasks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'creating',
      upstream_task_id TEXT, payload_json TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_test_tasks_expires_at ON test_tasks(expires_at);
    CREATE TABLE IF NOT EXISTS rate_limits (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, key_hash TEXT NOT NULL,
      window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at ON rate_limits(updated_at);`);
  database = db;
  return db;
}

function statement(sql, values = []) {
  return {
    sql,
    values,
    bind(...next) { return statement(sql, next); },
    async run() {
      const meta = connect().prepare(sql).run(...values);
      return { meta: { changes: Number(meta.changes) } };
    },
    async first() { return connect().prepare(sql).get(...values) ?? null; },
    async all() { return { results: connect().prepare(sql).all(...values) }; },
  };
}

const DB = {
  prepare(sql) { return statement(sql); },
  async batch(commands) {
    const db = connect();
    db.exec("BEGIN IMMEDIATE");
    try {
      const results = commands.map(({ sql, values }) => {
        const prepared = db.prepare(sql);
        if (/^\s*SELECT\b/i.test(sql)) return { results: prepared.all(...values) };
        const meta = prepared.run(...values);
        return { results: [], meta: { changes: Number(meta.changes) } };
      });
      db.exec("COMMIT");
      return results;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
};

export const env = { DB };
