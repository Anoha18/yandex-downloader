import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import type { DiskApi } from '../api/diskApi.js';
import type { HttpClient } from '../api/httpClient.js';
import type { PhotosliceClient } from '../api/photosliceClient.js';
import type { StateDb } from '../state/db.js';
import { ConfigError } from '../util/errors.js';
import { humanBytes } from '../util/format.js';
import { md5File } from '../util/hash.js';
import type { Logger } from '../util/logger.js';
import { ensureDir } from '../util/paths.js';
import type { ProgressReporter } from '../util/progress.js';
import { FileDownloader } from './fileDownloader.js';
import { withSuffix } from './localPath.js';
import { PhotoDownloader } from './photoDownloader.js';

export interface DownloadOptions {
  files: boolean;
  photos: boolean;
  path?: string;
  concurrency: number;
  limit?: number;
  retryFailed: boolean;
  recheck: boolean;
  dryRun: boolean;
}

export interface DownloadContext {
  api: DiskApi;
  http: HttpClient;
  /** Отдельный HTTP-клиент для фото (свой лимитер, без OAuth-заголовка). */
  photoHttp?: HttpClient;
  photosClient?: PhotosliceClient;
  downloadDir: string;
  photosDir: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Таймаут ожидания ответа при скачивании, мс. */
  connectTimeoutMs?: number;
  /** Таймаут простоя без данных при скачивании фото, мс. */
  photoStallTimeoutMs?: number;
}

export interface DownloadStats {
  filesDownloaded: number;
  filesSkipped: number;
  filesFailed: number;
  /** Среди failed: недоступность backend хранилища (сбой на стороне Яндекса). */
  filesStorageUnavailable: number;
  photosDownloaded: number;
  photosSkipped: number;
  photosFailed: number;
  bytes: number;
}

/** Пауза для фото при HTTP 429 (лимит запросов), сек. */
const PHOTO_RATE_LIMIT_DELAY_SEC = 30;

function normalizePrefix(path: string): string {
  if (path.startsWith('disk:')) return path;
  if (path.startsWith('/')) return `disk:${path}`;
  return `disk:/${path}`;
}

/** Лежит ли путь внутри каталога. */
function isInsideDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Перенос файла с фолбэком на копирование между разными ФС. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** Уникальное имя в каталоге (не затирая существующие файлы). */
function uniquePhotoName(dir: string, name: string): string {
  let candidate = resolve(dir, name);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = withSuffix(resolve(dir, name), counter++);
  }
  return candidate;
}

/** Оркестрация скачивания: обычные файлы (пул воркеров) и фото (пачки ZIP). */
export class DownloadService {
  constructor(
    private readonly db: StateDb,
    private readonly log: Logger,
    private readonly options: DownloadOptions,
    private readonly ctx: DownloadContext,
    private readonly progress: ProgressReporter,
  ) {}

  async run(): Promise<DownloadStats> {
    const stats: DownloadStats = {
      filesDownloaded: 0,
      filesSkipped: 0,
      filesFailed: 0,
      filesStorageUnavailable: 0,
      photosDownloaded: 0,
      photosSkipped: 0,
      photosFailed: 0,
      bytes: 0,
    };

    if (this.options.files) await this.runFiles(stats);
    if (this.options.photos) await this.runPhotos(stats);
    this.log.debug('Скачивание завершено', stats);
    return stats;
  }

  private async runFiles(stats: DownloadStats): Promise<void> {
    if (this.options.retryFailed) {
      const n = this.db.retryFailedFiles();
      if (n > 0) this.progress.info(`Возвращено в очередь (файлы): ${n}`);
    }
    const reset = this.db.resetFilesInProgress();
    if (reset > 0) this.progress.info(`Восстановлено после остановки: ${reset} файлов`);

    if (this.options.recheck) await this.recheckFiles();

    const summary = this.db.summarize();
    const pending = summary.byStatus.pending ?? 0;
    const pendingBytes = summary.byStatusSize.pending ?? 0;
    this.progress.setTotals({ items: pending, bytes: pendingBytes });

    if (this.options.dryRun) {
      this.progress.info(`[dry-run] к скачиванию файлов: ${pending} (${humanBytes(pendingBytes)})`);
      return;
    }
    if (pending === 0) {
      this.progress.info('Файлов к скачиванию нет.');
      return;
    }

    const prefix = this.options.path ? normalizePrefix(this.options.path) : undefined;
    const concurrency = Math.max(1, this.options.concurrency);
    const multi = concurrency > 1;

    const downloader = new FileDownloader(this.ctx.api, this.ctx.http, {
      downloadDir: this.ctx.downloadDir,
      maxAttempts: this.ctx.maxAttempts,
      baseDelayMs: this.ctx.baseDelayMs,
      maxDelayMs: this.ctx.maxDelayMs,
      connectTimeoutMs: this.ctx.connectTimeoutMs,
      storageMaxAttempts: 2,
      onProgress: multi
        ? undefined
        : (_remotePath, written) => this.progress.currentProgress(written),
      onRetry: (info) =>
        this.progress.info(
          `↻ повтор ${info.attempt}/${info.maxAttempts} через ${Math.round(info.delayMs / 1000)}с (${info.reason})`,
        ),
    });

    if (multi) this.progress.setActive(concurrency);
    let taken = 0;

    const worker = async (index: number): Promise<void> => {
      for (;;) {
        if (this.options.limit !== undefined && taken >= this.options.limit) return;
        const [job] = this.db.claimPendingFiles(1, prefix);
        if (!job) return;
        taken += 1;

        const sizeLabel = job.size !== null ? ` (${humanBytes(job.size)})` : '';
        this.progress.info(`↓ ${job.path}${sizeLabel}`);

        let result: Awaited<ReturnType<FileDownloader['download']>>;
        if (multi) {
          const key = String(index);
          this.progress.beginFile(key, job.path, job.size ?? undefined);
          try {
            result = await downloader.download(job, (written) =>
              this.progress.updateFile(key, written),
            );
          } finally {
            this.progress.endFile(key);
          }
        } else {
          this.progress.setCurrent(job.path, job.size ?? undefined);
          result = await downloader.download(job);
          this.progress.clearCurrent();
        }

        if (result.status === 'downloaded') {
          this.db.markFileDownloaded(job.path, result.localPath);
          stats.filesDownloaded += 1;
          stats.bytes += result.bytes;
          this.progress.addBytes(result.bytes);
          this.progress.info(`✓ ${job.path} (${humanBytes(result.bytes)})`);
        } else if (result.status === 'skipped') {
          this.db.markFileSkipped(job.path, result.localPath);
          stats.filesSkipped += 1;
          this.progress.info(`↷ ${job.path} (уже есть, md5 совпал)`);
        } else {
          // Внутри FileDownloader уже есть быстрые повторы (2–3), поэтому файл
          // помечаем `failed` сразу: добор — через `--retry-failed`. Иначе очередь
          // 7 раз переотдавала бы файл заново, плодя дубли `.part`.
          this.db.markFileFailed(job.path, result.error ?? 'неизвестная ошибка', 1, 0);
          stats.filesFailed += 1;
          if (result.storageUnavailable === true) {
            stats.filesStorageUnavailable += 1;
            this.progress.warn(
              `${job.path}: ${result.error} — сбой на стороне Яндекса, повторите позже`,
            );
          } else {
            this.progress.warn(`${job.path}: ${result.error}`);
          }
        }
        this.progress.incItems(1);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
    if (multi) this.progress.setActive(0);
    const storageNote =
      stats.filesStorageUnavailable > 0
        ? `, из них недоступно хранилище: ${stats.filesStorageUnavailable}`
        : '';
    this.progress.info(
      `Файлы: скачано ${stats.filesDownloaded}, пропущено ${stats.filesSkipped}, ошибок ${stats.filesFailed}${storageNote}`,
    );
  }

  private async recheckFiles(): Promise<void> {
    const files = this.db.downloadedFiles();
    let pending = 0;
    for (const file of files) {
      if (!file.local_path || !existsSync(file.local_path)) {
        this.db.setFilePending(file.path);
        pending += 1;
        continue;
      }
      if (file.md5) {
        const md5 = await md5File(file.local_path);
        if (md5 !== file.md5) {
          this.db.setFilePending(file.path);
          pending += 1;
          this.progress.warn(`md5 не сошёлся, перекачаем: ${file.path}`);
        }
      }
    }
    if (pending > 0) this.progress.info(`Перепроверка: ${pending} файлов вернулись в очередь`);
  }

  private async recheckPhotos(): Promise<void> {
    const photos = this.db.downloadedPhotos();
    let pending = 0;
    for (const photo of photos) {
      if (!photo.local_path || !existsSync(photo.local_path)) {
        this.db.setPhotoPending(photo.id);
        pending += 1;
        continue;
      }
      if (photo.md5) {
        const md5 = await md5File(photo.local_path);
        if (md5 !== photo.md5) {
          this.db.setPhotoPending(photo.id);
          pending += 1;
          this.progress.warn(`md5 не сошёлся, перекачаем фото: ${photo.id}`);
        }
      }
    }
    if (pending > 0) this.progress.info(`Перепроверка фото: ${pending} вернулись в очередь`);
  }

  /**
   * Приводит локальные пути уже скачанных фото к текущему `photosDir`.
   *
   * Если файл лежит вне настроенной папки (например, скачан старым дефолтом) —
   * переносим его внутрь. Если файла нет — возвращаем фото в очередь.
   */
  private reconcilePhotoPaths(): void {
    const root = resolve(this.ctx.photosDir);
    const photos = this.db.downloadedPhotos();
    let moved = 0;
    let requeued = 0;

    for (const photo of photos) {
      if (!photo.local_path) {
        this.db.setPhotoPending(photo.id);
        requeued += 1;
        continue;
      }
      const path = resolve(photo.local_path);
      if (!existsSync(path)) {
        this.db.setPhotoPending(photo.id);
        requeued += 1;
        continue;
      }
      if (isInsideDir(root, path)) continue;

      try {
        ensureDir(root);
        const dest = uniquePhotoName(root, basename(path));
        moveFile(path, dest);
        this.db.updatePhotoLocalPath(photo.id, dest);
        moved += 1;
      } catch {
        this.db.setPhotoPending(photo.id);
        requeued += 1;
      }
    }

    if (moved > 0) this.progress.info(`Фото перенесено в ${root}: ${moved}`);
    if (requeued > 0)
      this.progress.info(`Фото без локальных файлов вернулись в очередь: ${requeued}`);
  }

  private async runPhotos(stats: DownloadStats): Promise<void> {
    if (this.options.retryFailed) {
      const n = this.db.retryFailedPhotos();
      if (n > 0) this.progress.info(`Возвращено в очередь (фото): ${n}`);
    }
    const reset = this.db.resetPhotosInProgress();
    if (reset > 0) this.progress.info(`Восстановлено после остановки: ${reset} фото`);

    this.reconcilePhotoPaths();
    if (this.options.recheck) await this.recheckPhotos();

    const summary = this.db.summarizePhotos();
    const pending = summary.byStatus.pending ?? 0;

    if (this.options.dryRun) {
      this.progress.info(`[dry-run] к скачиванию фото: ${pending}`);
      return;
    }
    if (!this.ctx.photosClient) return;
    if (pending === 0) {
      this.progress.info('Фото к скачиванию нет.');
      return;
    }

    const seenMd5 = new Set(this.db.downloadedPhotoMd5s());
    this.progress.resetTotals();
    this.progress.setTotals({ items: pending });

    // Свой HTTP-клиент для фото: отдельный лимитер, чтобы волна ошибок
    // хранилища не морозила всё общим 5-минутным предохранителем.
    const http = this.ctx.photoHttp ?? this.ctx.http;
    const downloader = new PhotoDownloader(this.ctx.photosClient, http, {
      photosDir: this.ctx.photosDir,
      connectTimeoutMs: this.ctx.connectTimeoutMs,
      stallTimeoutMs: this.ctx.photoStallTimeoutMs,
      seenMd5,
    });

    const concurrency = Math.max(1, this.options.concurrency);
    const multi = concurrency > 1;
    const limit = this.options.limit;
    let taken = 0;
    let stopped = false;
    let authError: string | null = null;

    if (multi) this.progress.setActive(concurrency);

    const worker = async (index: number): Promise<void> => {
      const key = String(index);
      for (;;) {
        if (stopped) return;
        if (limit !== undefined && taken >= limit) return;

        const [job] = this.db.claimPendingPhotos(1);
        if (!job) return;
        taken += 1;

        const name = job.name ?? job.remote_ref ?? job.id;
        if (multi) {
          this.progress.beginFile(key, name, job.size ?? undefined);
        } else {
          this.progress.setCurrent(name, job.size ?? undefined);
        }

        let result: Awaited<ReturnType<PhotoDownloader['downloadOne']>>;
        try {
          result = await downloader.downloadOne(job, (written) => {
            if (multi) this.progress.updateFile(key, written);
            else this.progress.currentProgress(written);
          });
        } finally {
          if (multi) this.progress.endFile(key);
          else this.progress.clearCurrent();
        }

        if (result.status === 'downloaded') {
          this.db.markPhotoDownloaded(job.id, result.localPath ?? '', result.md5, result.bytes);
          stats.photosDownloaded += 1;
          stats.bytes += result.bytes ?? 0;
          this.progress.addBytes(result.bytes ?? 0);
          this.progress.info(`✓ ${name} (${humanBytes(result.bytes ?? 0)})`);
        } else if (result.status === 'skipped') {
          this.db.markPhotoSkipped(job.id, result.localPath ?? '', result.md5, result.bytes);
          stats.photosSkipped += 1;
          this.progress.info(`↷ ${name} (уже есть)`);
        } else {
          const error = result.error ?? 'неизвестная ошибка';

          if (result.failureKind === 'auth') {
            // Куки протухли: фото возвращаем в очередь и выходим с понятной ошибкой.
            this.db.setPhotoPending(job.id);
            authError = `${error}. Обновите cookies: yd photos auth`;
            stopped = true;
            return;
          }

          if (result.failureKind === 'rate_limit') {
            // 429: попытку не сжигаем, вернём в очередь с небольшой задержкой,
            // чтобы не упереться в лимит запросов Яндекса.
            this.db.markPhotoDeferred(job.id, error, PHOTO_RATE_LIMIT_DELAY_SEC);
            this.progress.warn(`${name}: ${error} — отложено на ${PHOTO_RATE_LIMIT_DELAY_SEC} с`);
            continue;
          }

          // Любая другая ошибка: помечаем failed, добор — через --retry-failed.
          this.db.markPhotoFailed(job.id, error, 1, 0);
          stats.photosFailed += 1;
          this.progress.warn(`${name}: ${error}`);
        }

        this.progress.incItems(1);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
    if (multi) this.progress.setActive(0);

    if (authError) throw new ConfigError(authError);

    this.progress.info(
      `Фото завершены: скачано ${stats.photosDownloaded}, пропущено ${stats.photosSkipped}, ошибок ${stats.photosFailed}`,
    );
  }
}
