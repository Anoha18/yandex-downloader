import { join } from 'node:path';

import { HttpClient } from '../api/httpClient.js';
import type { PhotosliceClient } from '../api/photosliceClient.js';
import { PROFILE_PRESETS } from '../config/schema.js';
import { DownloadService } from '../download/downloadService.js';
import { StateDb } from '../state/db.js';
import { UsageError } from '../util/errors.js';
import { humanBytes } from '../util/format.js';
import { acquireLock } from '../util/lock.js';
import { getLogger } from '../util/logger.js';
import { AdaptiveLimiter } from '../util/rateLimiter.js';
import { createSession } from './helpers.js';
import { createPhotosliceClient, ensureCookies, optionalString } from './photosCookies.js';
import { createProgress } from './progressFactory.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

function parsePositiveInt(raw: unknown, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag}: ожидается целое число >= 1`);
  }
  return value;
}

/**
 * `yd download` — скачивание очереди (файлы с сохранением структуры + фото).
 *
 *   --files            только обычные файлы
 *   --photos           только безлимитные фото
 *   --path <dir>       ограничить файлы поддеревом
 *   --concurrency <n>  воркеры для файлов/фото (по умолчанию из профиля)
 *   --limit <n>        скачать не более N файлов/фото (отладка)
 *   --retry-failed     вернуть упавшие в очередь
 *   --recheck          пересчитать md5 уже скачанных и перекачать побитые
 *   --dry-run          только показать, что будет скачано
 *   --download-timeout <с> таймаут ожидания ответа, сек
 *   --stall-timeout <с>    таймаут простоя без данных при скачивании фото, сек
 */
export const runDownload: CommandRunner = async (
  { options }: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const onlyFiles = options.files === true;
  const onlyPhotos = options.photos === true;

  const files = !(onlyPhotos && !onlyFiles);
  const photos = !(onlyFiles && !onlyPhotos);

  const profileDefault = ctx.config.concurrency ?? PROFILE_PRESETS[ctx.config.profile].concurrency;
  const concurrency =
    parsePositiveInt(options.concurrency, '--concurrency') ?? Math.max(1, profileDefault);
  const limit = parsePositiveInt(options.limit, '--limit');
  const downloadTimeoutSec = parsePositiveInt(options['download-timeout'], '--download-timeout');
  const stallTimeoutSec = parsePositiveInt(options['stall-timeout'], '--stall-timeout');

  const log = getLogger();
  const { reporter: progress, stop } = createProgress(ctx, 'download', { label: 'download' });
  const releaseLock = acquireLock(join(ctx.paths.baseDir, 'download.lock'));

  try {
    const session = await createSession(ctx);
    if (session.refreshed) log.debug('Токен был обновлён автоматически');

    const db = StateDb.open(ctx.config.statePath);
    try {
      let photosClient: PhotosliceClient | undefined;
      let photoHttp: HttpClient | undefined;
      if (photos && options['dry-run'] !== true) {
        const cookies = await ensureCookies(ctx, options);
        photosClient = createPhotosliceClient(ctx, cookies, () =>
          ensureCookies(ctx, { ...options, refresh: true }),
        );

        // Отдельный лимитер для фото: держит QPS и делает короткую паузу
        // только на 429. Сбои хранилища (5xx) предохранитель не включают —
        // «остывать» на минуты не нужно, ошибочные файлы просто помечаются failed.
        const photoLimiter = new AdaptiveLimiter({
          qps: PROFILE_PRESETS[ctx.config.profile].qps,
          minQps: 1,
          cooldownMs: Math.min(ctx.config.rateLimit.cooldownMs, 30_000),
          errorThreshold: 10_000,
          windowMs: 60_000,
        });
        photoHttp = new HttpClient(session.accessToken, {
          limiter: photoLimiter,
          rateLimit: ctx.config.rateLimit,
        });
      }

      const service = new DownloadService(
        db,
        log,
        {
          files,
          photos,
          path: optionalString(options.path),
          concurrency,
          limit,
          retryFailed: options['retry-failed'] === true,
          recheck: options.recheck === true,
          dryRun: options['dry-run'] === true,
        },
        {
          api: session.api,
          http: session.http,
          photoHttp,
          photosClient,
          downloadDir: ctx.config.downloadDir,
          photosDir: ctx.config.photosDir,
          maxAttempts: ctx.config.rateLimit.maxAttempts,
          baseDelayMs: ctx.config.rateLimit.baseDelayMs,
          maxDelayMs: ctx.config.rateLimit.maxDelayMs,
          connectTimeoutMs:
            downloadTimeoutSec !== undefined ? downloadTimeoutSec * 1000 : undefined,
          photoStallTimeoutMs: stallTimeoutSec !== undefined ? stallTimeoutSec * 1000 : undefined,
        },
        progress,
      );

      const stats = await service.run();
      progress.finish();

      const summary = db.summarize();
      const photoSummary = db.summarizePhotos();

      const lines = [
        '',
        'Готово.',
        `Файлы: скачано ${stats.filesDownloaded}, пропущено ${stats.filesSkipped}, ошибок ${stats.filesFailed}`,
        `Фото: скачано ${stats.photosDownloaded}, пропущено ${stats.photosSkipped}, ошибок ${stats.photosFailed}`,
        `Загружено объёмом: ${humanBytes(stats.bytes)}`,
        `Осталось в очереди (файлы): ${summary.byStatus.pending ?? 0}, (фото): ${photoSummary.byStatus.pending ?? 0}`,
        `Лог: ${ctx.config.logDir}/download.log`,
      ];
      if (stats.filesStorageUnavailable > 0) {
        lines.push(
          '',
          `⚠ ${stats.filesStorageUnavailable} файлов недоступны: сбой хранилища на стороне Яндекса`,
          '  (edge отвечает, но backend не отдаёт объект). Повторите позже:',
          '  yd download --retry-failed',
        );
      }
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    } finally {
      db.close();
    }
  } finally {
    stop();
    releaseLock();
  }
};
