/**
 * Список миграций схемы SQLite.
 *
 * Каждая миграция применяется ровно один раз (по version) и фиксируется
 * в таблице schema_migrations. Новые изменения схемы добавляются новыми
 * элементами массива — существующие не редактируются.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init_files_queue',
    sql: `
      CREATE TABLE IF NOT EXISTS files (
        path          TEXT PRIMARY KEY,
        size          INTEGER,
        md5           TEXT,
        mime          TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        worker_id     INTEGER,
        local_path    TEXT,
        error         TEXT,
        discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
        downloaded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
      CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5);
      CREATE INDEX IF NOT EXISTS idx_files_retry ON files(status, next_retry_at);
    `,
  },
  {
    version: 2,
    name: 'scan_dirs_and_meta',
    sql: `
      CREATE TABLE IF NOT EXISTS dirs (
        path       TEXT PRIMARY KEY,
        parent     TEXT,
        status     TEXT NOT NULL DEFAULT 'pending',
        scanned_at TEXT,
        error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dirs_status ON dirs(status);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `,
  },
  {
    version: 3,
    name: 'unlimited_photos',
    sql: `
      CREATE TABLE IF NOT EXISTS photo_clusters (
        cluster_id TEXT PRIMARY KEY,
        size       INTEGER,
        fetched    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS photos (
        id            TEXT PRIMARY KEY,
        cluster_id    TEXT,
        name          TEXT,
        size          INTEGER,
        md5           TEXT,
        mime          TEXT,
        taken_at      TEXT,
        remote_ref    TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        local_path    TEXT,
        error         TEXT,
        discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
        downloaded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);
      CREATE INDEX IF NOT EXISTS idx_photos_cluster ON photos(cluster_id);
      CREATE INDEX IF NOT EXISTS idx_photos_md5 ON photos(md5);
    `,
  },
  {
    version: 4,
    name: 'photos_retry_schedule',
    sql: `
      ALTER TABLE photos ADD COLUMN next_retry_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_photos_retry ON photos(status, next_retry_at);
    `,
  },
];
