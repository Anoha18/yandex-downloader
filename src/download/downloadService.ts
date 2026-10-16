import { existsSync } from 'node:fs';

import type { DiskApi } from '../api/diskApi.js';
import type { HttpClient } from '../api/httpClient.js';
import type { PhotosliceClient } from '../api/photosliceClient.js';
import type { StateDb } from '../state/db.js';
import { humanBytes } from '../util/format.js';
import { md5File } from '../util/hash.js';
import type { Logger } from '../util/logger.js';
import type { ProgressReporter } from '../util/progress.js';
import { FileDownloader } from './fileDownloader.js';
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
  photosClient?: PhotosliceClient;
  downloadDir: string;
  photosDir: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Таймаут ожидания ответа при скачивании, мс. */
  connectTimeoutMs?: number;
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

const PHOTO_BATCH_COUNT = 60;
const PHOTO_BATCH_BYTES = 500 * 1024 * 1024;

function normalizePrefix(path: string): string {
  if (path.startsWith('disk:')) return path;
  if (path.startsWith('/')) return `disk:${path}`;
  return `disk:/${path}`;
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
          this.db.markFileFailed(
            job.path,
            result.error ?? 'неизвестная ошибка',
            this.ctx.maxAttempts,
            Math.min(this.ctx.maxDelayMs, this.ctx.baseDelayMs * 2) / 1000,
          );
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

  private async runPhotos(stats: DownloadStats): Promise<void> {
    if (this.options.retryFailed) {
      const n = this.db.retryFailedPhotos();
      if (n > 0) this.progress.info(`Возвращено в очередь (фото): ${n}`);
    }
    const reset = this.db.resetPhotosInProgress();
    if (reset > 0) this.progress.info(`Восстановлено после остановки: ${reset} фото`);

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
    const downloader = new PhotoDownloader(this.ctx.photosClient, this.ctx.http, {
      photosDir: this.ctx.photosDir,
      seenMd5,
    });

    for (;;) {
      const batch = this.db.claimPendingPhotos(PHOTO_BATCH_COUNT, PHOTO_BATCH_BYTES);
      if (batch.length === 0) break;

      const batchBytes = batch.reduce((sum, photo) => sum + (photo.size ?? 0), 0);
      this.progress.info(`↓ пачка фото: ${batch.length} шт (${humanBytes(batchBytes)})`);
      this.progress.setCurrent(`архив (${batch.length} фото)`, batchBytes);

      const results = await downloader.downloadBatch(batch);
      this.progress.clearCurrent();

      for (const result of results) {
        if (result.status === 'downloaded') {
          this.db.markPhotoDownloaded(result.id, result.localPath ?? '');
          stats.photosDownloaded += 1;
        } else if (result.status === 'skipped') {
          this.db.markPhotoSkipped(result.id, result.localPath ?? '');
          stats.photosSkipped += 1;
        } else {
          this.db.markPhotoFailed(
            result.id,
            result.error ?? 'неизвестная ошибка',
            this.ctx.maxAttempts,
          );
          stats.photosFailed += 1;
        }
      }
      this.progress.incItems(results.length);
      this.progress.info(
        `Фото: скачано ${stats.photosDownloaded}, пропущено ${stats.photosSkipped}, ошибок ${stats.photosFailed}`,
      );
    }

    this.progress.info(
      `Фото завершены: скачано ${stats.photosDownloaded}, пропущено ${stats.photosSkipped}, ошибок ${stats.photosFailed}`,
    );
  }
}
