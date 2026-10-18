import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ensureDir } from '../util/paths.js';
import { MIGRATIONS } from './migrations.js';

/** Статус файла в очереди. */
export type FileStatus =
  | 'pending'
  | 'in_progress'
  | 'downloaded'
  | 'skipped'
  | 'failed'
  | 'missing';

/** Строка таблицы files. */
export interface FileRow {
  path: string;
  size: number | null;
  md5: string | null;
  mime: string | null;
  status: FileStatus;
  attempts: number;
  next_retry_at: string | null;
  worker_id: number | null;
  local_path: string | null;
  error: string | null;
  discovered_at: string;
  downloaded_at: string | null;
}

/** Данные файла для добавления/обновления в очереди. */
export interface FileUpsert {
  path: string;
  size: number | null;
  md5: string | null;
  mime: string | null;
}

/** Сводка по очереди. */
export interface QueueSummary {
  total: number;
  totalSize: number;
  byStatus: Record<string, number>;
  byStatusSize: Record<string, number>;
}

/** Данные фото из безлимитного хранилища. */
export interface PhotoUpsert {
  id: string;
  clusterId: string | null;
  name: string | null;
  size: number | null;
  md5: string | null;
  mime: string | null;
  takenAt: string | null;
  remoteRef: string | null;
}

/** Сводка по фото. */
export interface PhotosSummary {
  total: number;
  totalSize: number;
  byStatus: Record<string, number>;
}

/** Задача на скачивание обычного файла. */
export interface FileJob {
  path: string;
  size: number | null;
  md5: string | null;
  local_path: string | null;
}

/** Задача на скачивание фото. */
export interface PhotoJob {
  id: string;
  name: string | null;
  size: number | null;
  md5: string | null;
  remote_ref: string | null;
  attempts: number;
}

/**
 * Обёртка над встроенным node:sqlite.
 *
 * Хранит очередь файлов (files), дерево папок (dirs) и метаданные скана (meta).
 * Режим WAL, синхронный API.
 */
export class StateDb {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(file: string): StateDb {
    ensureDir(dirname(file));
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    const instance = new StateDb(db);
    instance.migrate();
    return instance;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const appliedRows = this.db
      .prepare('SELECT version FROM schema_migrations')
      .all() as unknown as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((row) => row.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
          .run(migration.version, migration.name);
      });
    }
  }

  // ── files ────────────────────────────────────────────────────────────────

  /**
   * Идемпотентно добавляет/обновляет файлы.
   *
   * Если файл уже был скачан и не изменился (совпали size и md5) — статус и
   * история сохраняются. Если изменился — сбрасывается в 'pending'.
   */
  upsertFiles(files: FileUpsert[]): void {
    if (files.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO files (path, size, md5, mime, status, discovered_at)
      VALUES (?, ?, ?, ?, 'pending', datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        discovered_at = datetime('now'),
        status = CASE
          WHEN files.size IS NOT excluded.size OR files.md5 IS NOT excluded.md5
            THEN 'pending'
          ELSE files.status
        END,
        attempts = CASE
          WHEN files.size IS NOT excluded.size OR files.md5 IS NOT excluded.md5
            THEN 0
          ELSE files.attempts
        END,
        error = CASE
          WHEN files.size IS NOT excluded.size OR files.md5 IS NOT excluded.md5
            THEN NULL
          ELSE files.error
        END,
        size = excluded.size,
        md5 = excluded.md5,
        mime = excluded.mime
    `);
    this.transaction(() => {
      for (const file of files) {
        stmt.run(file.path, file.size, file.md5, file.mime);
      }
    });
  }

  /** Устанавливает статус файла (используется тестами и последующими этапами). */
  setFileStatus(path: string, status: FileStatus): void {
    this.db.prepare('UPDATE files SET status = ? WHERE path = ?').run(status, path);
  }

  allFiles(): Array<{ path: string; size: number | null; md5: string | null }> {
    return this.db
      .prepare('SELECT path, size, md5 FROM files ORDER BY path')
      .all() as unknown as Array<{ path: string; size: number | null; md5: string | null }>;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM files GROUP BY status')
      .all() as unknown as Array<{ status: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.status] = row.count;
    return result;
  }

  totalFiles(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM files').get() as unknown as {
      count: number;
    };
    return row.count;
  }

  summarize(): QueueSummary {
    const rows = this.db
      .prepare(
        'SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM files GROUP BY status',
      )
      .all() as unknown as Array<{ status: string; count: number; size: number }>;
    const summary: QueueSummary = { total: 0, totalSize: 0, byStatus: {}, byStatusSize: {} };
    for (const row of rows) {
      summary.total += row.count;
      summary.totalSize += row.size;
      summary.byStatus[row.status] = row.count;
      summary.byStatusSize[row.status] = row.size;
    }
    return summary;
  }

  // ── dirs (для режима --deep и резюмируемости) ──────────────────────────────

  upsertDirs(dirs: Array<{ path: string; parent: string | null }>): void {
    if (dirs.length === 0) return;
    const stmt = this.db.prepare('INSERT OR IGNORE INTO dirs (path, parent) VALUES (?, ?)');
    this.transaction(() => {
      for (const dir of dirs) stmt.run(dir.path, dir.parent);
    });
  }

  nextPendingDirs(limit: number): string[] {
    const rows = this.db
      .prepare("SELECT path FROM dirs WHERE status = 'pending' ORDER BY path LIMIT ?")
      .all(limit) as unknown as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  /**
   * Атомарно «забирает» папки в работу (pending → in_progress), чтобы параллельные
   * воркеры не обрабатывали одну и ту же папку.
   */
  claimPendingDirs(limit: number): string[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT path FROM dirs WHERE status = 'pending' ORDER BY path LIMIT ?")
        .all(limit) as unknown as Array<{ path: string }>;
      const paths = rows.map((row) => row.path);
      if (paths.length === 0) return paths;
      const stmt = this.db.prepare("UPDATE dirs SET status = 'in_progress' WHERE path = ?");
      for (const path of paths) stmt.run(path);
      return paths;
    });
  }

  /** Возвращает «зависшие» папки (in_progress) в очередь — для возобновления скана. */
  resetDirsInProgress(): number {
    return this.db.prepare("UPDATE dirs SET status = 'pending' WHERE status = 'in_progress'").run()
      .changes as number;
  }

  markDirScanned(path: string): void {
    this.db
      .prepare("UPDATE dirs SET status = 'scanned', scanned_at = datetime('now') WHERE path = ?")
      .run(path);
  }

  markDirFailed(path: string, error: string): void {
    this.db
      .prepare(
        "UPDATE dirs SET status = 'failed', scanned_at = datetime('now'), error = ? WHERE path = ?",
      )
      .run(error.slice(0, 500), path);
  }

  pendingDirCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM dirs WHERE status = 'pending'")
      .get() as unknown as { count: number };
    return row.count;
  }

  // ── meta ───────────────────────────────────────────────────────────────────

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  getAllMeta(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as unknown as Array<{
      key: string;
      value: string;
    }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  // ── photos (безлимитное хранилище / photoslice) ────────────────────────────

  upsertPhotos(photos: PhotoUpsert[]): void {
    if (photos.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO photos (id, cluster_id, name, size, md5, mime, taken_at, remote_ref, status, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        cluster_id = excluded.cluster_id,
        name = excluded.name,
        size = excluded.size,
        md5 = excluded.md5,
        mime = excluded.mime,
        taken_at = excluded.taken_at,
        remote_ref = excluded.remote_ref,
        discovered_at = datetime('now'),
        status = CASE
          WHEN photos.md5 IS NOT excluded.md5 OR photos.size IS NOT excluded.size
            THEN 'pending'
          ELSE photos.status
        END
    `);
    this.transaction(() => {
      for (const photo of photos) {
        stmt.run(
          photo.id,
          photo.clusterId,
          photo.name,
          photo.size,
          photo.md5,
          photo.mime,
          photo.takenAt,
          photo.remoteRef,
        );
      }
    });
  }

  upsertPhotoClusters(clusters: Array<{ id: string; size: number }>): void {
    if (clusters.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO photo_clusters (cluster_id, size) VALUES (?, ?)',
    );
    this.transaction(() => {
      for (const cluster of clusters) stmt.run(cluster.id, cluster.size);
    });
  }

  nextUnfetchedClusters(limit: number): Array<{ id: string; size: number }> {
    return this.db
      .prepare('SELECT cluster_id AS id, size FROM photo_clusters WHERE fetched = 0 LIMIT ?')
      .all(limit) as unknown as Array<{ id: string; size: number }>;
  }

  markClustersFetched(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE photo_clusters SET fetched = 1 WHERE cluster_id = ?');
    this.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
  }

  countPhotos(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM photos').get() as unknown as {
      count: number;
    };
    return row.count;
  }

  summarizePhotos(): PhotosSummary {
    const rows = this.db
      .prepare(
        'SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM photos GROUP BY status',
      )
      .all() as unknown as Array<{ status: string; count: number; size: number }>;
    const summary: PhotosSummary = { total: 0, totalSize: 0, byStatus: {} };
    for (const row of rows) {
      summary.total += row.count;
      summary.totalSize += row.size;
      summary.byStatus[row.status] = row.count;
    }
    return summary;
  }

  setPhotoStatus(id: string, status: FileStatus): void {
    this.db.prepare('UPDATE photos SET status = ? WHERE id = ?').run(status, id);
  }

  allPhotos(): Array<{ id: string; name: string | null; size: number | null; md5: string | null }> {
    return this.db
      .prepare('SELECT id, name, size, md5 FROM photos ORDER BY cluster_id, name')
      .all() as unknown as Array<{
      id: string;
      name: string | null;
      size: number | null;
      md5: string | null;
    }>;
  }

  // ── очередь скачивания: обычные файлы ──────────────────────────────────────

  claimPendingFiles(limit: number, pathPrefix?: string): FileJob[] {
    return this.transaction(() => {
      const columns = 'SELECT path, size, md5, local_path FROM files';
      const where = `WHERE status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))`;
      // Крупные файлы первыми: основную массу байт качаем, пока edge живы,
      // а «минное поле» из тысяч мелких файлов (node_modules и т.п.) — в конце.
      const order = 'ORDER BY size DESC, path LIMIT ?';

      const rows = (pathPrefix
        ? this.db
            .prepare(`${columns} ${where} AND (path = ? OR path LIKE ?) ${order}`)
            .all(pathPrefix, `${pathPrefix}/%`, limit)
        : this.db.prepare(`${columns} ${where} ${order}`).all(limit)) as unknown as FileJob[];

      const stmt = this.db.prepare("UPDATE files SET status = 'in_progress' WHERE path = ?");
      for (const row of rows) stmt.run(row.path);
      return rows;
    });
  }

  markFileDownloaded(path: string, localPath: string): void {
    this.db
      .prepare(
        `UPDATE files SET status = 'downloaded', local_path = ?, downloaded_at = datetime('now'),
         error = NULL, next_retry_at = NULL WHERE path = ?`,
      )
      .run(localPath, path);
  }

  markFileSkipped(path: string, localPath: string): void {
    this.db
      .prepare("UPDATE files SET status = 'skipped', local_path = ?, error = NULL WHERE path = ?")
      .run(localPath, path);
  }

  markFileFailed(path: string, error: string, maxAttempts: number, retryDelaySec: number): void {
    this.db
      .prepare(
        `UPDATE files SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
           next_retry_at = CASE WHEN attempts + 1 >= ? THEN NULL
             ELSE datetime('now', '+' || ? || ' seconds') END,
           error = ? WHERE path = ?`,
      )
      .run(
        maxAttempts,
        maxAttempts,
        Math.max(0, Math.round(retryDelaySec)),
        error.slice(0, 500),
        path,
      );
  }

  resetFilesInProgress(): number {
    return this.db.prepare("UPDATE files SET status = 'pending' WHERE status = 'in_progress'").run()
      .changes as number;
  }

  retryFailedFiles(): number {
    return this.db
      .prepare(
        "UPDATE files SET status = 'pending', attempts = 0, next_retry_at = NULL, error = NULL WHERE status = 'failed'",
      )
      .run().changes as number;
  }

  setFilePending(path: string): void {
    this.db
      .prepare("UPDATE files SET status = 'pending', attempts = 0, error = NULL WHERE path = ?")
      .run(path);
  }

  downloadedFiles(): Array<{ path: string; md5: string | null; local_path: string | null }> {
    return this.db
      .prepare("SELECT path, md5, local_path FROM files WHERE status = 'downloaded'")
      .all() as unknown as Array<{ path: string; md5: string | null; local_path: string | null }>;
  }

  /** Все файлы с локальными путями и статусами — для очистки `.part`. */
  filesForCleanup(): Array<{ path: string; local_path: string | null; status: FileStatus }> {
    return this.db.prepare('SELECT path, local_path, status FROM files').all() as unknown as Array<{
      path: string;
      local_path: string | null;
      status: FileStatus;
    }>;
  }

  // ── очередь скачивания: фото ───────────────────────────────────────────────

  claimPendingPhotos(limit: number): PhotoJob[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, name, size, md5, remote_ref, attempts FROM photos
             WHERE status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
             ORDER BY rowid LIMIT ?`,
        )
        .all(limit) as unknown as PhotoJob[];

      const stmt = this.db.prepare("UPDATE photos SET status = 'in_progress' WHERE id = ?");
      for (const row of rows) stmt.run(row.id);
      return rows;
    });
  }

  markPhotoDownloaded(
    id: string,
    localPath: string,
    md5?: string | null,
    size?: number | null,
  ): void {
    this.db
      .prepare(
        `UPDATE photos SET status = 'downloaded', local_path = ?, downloaded_at = datetime('now'),
         md5 = COALESCE(?, md5), size = COALESCE(?, size),
         error = NULL, next_retry_at = NULL WHERE id = ?`,
      )
      .run(localPath || null, md5 ?? null, size ?? null, id);
  }

  markPhotoSkipped(id: string, localPath: string, md5?: string | null, size?: number | null): void {
    this.db
      .prepare(
        `UPDATE photos SET status = 'skipped', local_path = ?,
         md5 = COALESCE(?, md5), size = COALESCE(?, size),
         error = NULL, next_retry_at = NULL WHERE id = ?`,
      )
      .run(localPath || null, md5 ?? null, size ?? null, id);
  }

  markPhotoFailed(id: string, error: string, maxAttempts: number, retryDelaySec: number): void {
    this.db
      .prepare(
        `UPDATE photos SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
           next_retry_at = CASE WHEN attempts + 1 >= ? THEN NULL
             ELSE datetime('now', '+' || ? || ' seconds') END,
           error = ? WHERE id = ?`,
      )
      .run(
        maxAttempts,
        maxAttempts,
        Math.max(0, Math.round(retryDelaySec)),
        error.slice(0, 500),
        id,
      );
  }

  /** Откладывает фото (сбой хранилища/сети), не сжигая попытку. */
  markPhotoDeferred(id: string, error: string, retryDelaySec: number): void {
    this.db
      .prepare(
        `UPDATE photos SET status = 'pending',
           next_retry_at = datetime('now', '+' || ? || ' seconds'),
           error = ? WHERE id = ?`,
      )
      .run(Math.max(0, Math.round(retryDelaySec)), error.slice(0, 500), id);
  }

  resetPhotosInProgress(): number {
    return this.db
      .prepare("UPDATE photos SET status = 'pending' WHERE status = 'in_progress'")
      .run().changes as number;
  }

  retryFailedPhotos(): number {
    return this.db
      .prepare(
        "UPDATE photos SET status = 'pending', attempts = 0, next_retry_at = NULL, error = NULL WHERE status = 'failed'",
      )
      .run().changes as number;
  }

  setPhotoPending(id: string): void {
    this.db
      .prepare(
        "UPDATE photos SET status = 'pending', attempts = 0, next_retry_at = NULL, error = NULL WHERE id = ?",
      )
      .run(id);
  }

  /**
   * Удаляет из очереди безлимита фото вне указанного корня (например, `/disk/...`).
   *
   * Старый сбор через photoslice тащил в эту таблицу все фото аккаунта, включая
   * обычный Диск. Такие файлы качает ветка `files`, а через mpfs они недоступны.
   */
  dropPhotosOutside(prefix: string): number {
    const normalized = prefix.replace(/\/+$/, '');
    return this.db
      .prepare(
        "DELETE FROM photos WHERE status IN ('pending','in_progress','failed') AND id NOT LIKE ?",
      )
      .run(`${normalized}/%`).changes as number;
  }

  updatePhotoLocalPath(id: string, localPath: string): void {
    this.db.prepare('UPDATE photos SET local_path = ? WHERE id = ?').run(localPath, id);
  }

  downloadedPhotoMd5s(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT md5 FROM photos WHERE status IN ('downloaded','skipped') AND md5 IS NOT NULL",
      )
      .all() as unknown as Array<{ md5: string }>;
    return rows.map((row) => row.md5);
  }

  downloadedPhotos(): Array<{ id: string; md5: string | null; local_path: string | null }> {
    return this.db
      .prepare("SELECT id, md5, local_path FROM photos WHERE status IN ('downloaded','skipped')")
      .all() as unknown as Array<{ id: string; md5: string | null; local_path: string | null }>;
  }

  close(): void {
    this.db.close();
  }
}
