import { existsSync } from 'node:fs';

import type { DiskApi } from '../api/diskApi.js';
import type { HttpClient } from '../api/httpClient.js';
import type { PhotosliceClient } from '../api/photosliceClient.js';
import type { StateDb } from '../state/db.js';
import { sleep } from '../util/async.js';
import { ConfigError } from '../util/errors.js';
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

const PHOTO_RATE_LIMIT_PAUSE_MS = 45_000;
const PHOTO_RATE_LIMIT_STREAK_LIMIT = 5;

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
      connectTimeoutMs: this.ctx.connectTimeoutMs,
      seenMd5,
    });

    const concurrency = Math.max(1, this.options.concurrency);
    const multi = concurrency > 1;
    const limit = this.options.limit;
    let taken = 0;
    let cooldownUntil = 0;
    let stopped = false;
    let authError: string | null = null;

    if (multi) this.progress.setActive(concurrency);

    const worker = async (index: number): Promise<void> => {
      const key = String(index);
      let rateLimitStreak = 0;
      for (;;) {
        if (stopped) return;
        if (limit !== undefined && taken >= limit) return;

        const wait = cooldownUntil - Date.now();
        if (wait > 0) await sleep(wait);
        if (stopped) return;

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
          rateLimitStreak = 0;
          this.progress.info(`✓ ${name} (${humanBytes(result.bytes ?? 0)})`);
        } else if (result.status === 'skipped') {
          this.db.markPhotoSkipped(job.id, result.localPath ?? '', result.md5, result.bytes);
          stats.photosSkipped += 1;
          rateLimitStreak = 0;
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
            // Лимит Яндекса: попытку не сжигаем, файл вернётся в очередь после паузы.
            this.db.setPhotoPending(job.id);
            taken -= 1;
            rateLimitStreak += 1;
            const pause = Math.min(600_000, PHOTO_RATE_LIMIT_PAUSE_MS * 2 ** (rateLimitStreak - 1));
            cooldownUntil = Math.max(cooldownUntil, Date.now() + pause);
            this.progress.warn(
              `Яндекс просит реже обращаться (${error}). Пауза ${Math.round(pause / 1000)} с`,
            );
            if (rateLimitStreak >= PHOTO_RATE_LIMIT_STREAK_LIMIT) {
              stopped = true;
              this.progress.warn(
                'Слишком много HTTP 429 подряд — останавливаю скачивание фото, попробуйте позже.',
              );
              return;
            }
            continue;
          }

          const attempts = job.attempts ?? 0;
          const fatal = result.failureKind === 'fatal';
          const retryDelaySec = fatal ? 0 : Math.min(300, 15 * 2 ** attempts);
          this.db.markPhotoFailed(job.id, error, fatal ? 1 : this.ctx.maxAttempts, retryDelaySec);
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
