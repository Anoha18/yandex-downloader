import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { HttpClient } from '../api/httpClient.js';
import { STORAGE_TIMEOUT_MESSAGE } from '../api/httpClient.js';
import type { PhotosliceClient } from '../api/photosliceClient.js';
import type { PhotoJob } from '../state/db.js';
import { ConfigError, HttpError } from '../util/errors.js';
import { md5File } from '../util/hash.js';
import { ensureDir } from '../util/paths.js';
import { sanitizeSegment, withSuffix } from './localPath.js';

/** Почему фото не скачалось — от этого зависит, сжигать ли попытку. */
export type PhotoFailureKind = 'auth' | 'rate_limit' | 'network' | 'storage' | 'fatal';

export interface PhotoDownloadResult {
  id: string;
  status: 'downloaded' | 'skipped' | 'failed';
  localPath?: string;
  bytes?: number;
  /** Фактический md5 скачанного файла (для дозаполнения БД). */
  md5?: string;
  error?: string;
  failureKind?: PhotoFailureKind;
}

export interface PhotoDownloaderOptions {
  photosDir: string;
  /** Таймаут ожидания ответа (заголовков), мс. */
  connectTimeoutMs?: number;
  /** Таймаут простоя без данных, мс. */
  stallTimeoutMs?: number;
  /** Множество md5 уже скачанных фото (для дедупликации). */
  seenMd5?: Set<string>;
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function classifyFailure(error: unknown): PhotoFailureKind {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return 'auth';
    if (error.status === 429) return 'rate_limit';
    if (error.status >= 500) return 'network';
    if (error.status === 0 && error.message === STORAGE_TIMEOUT_MESSAGE) return 'storage';
    return 'fatal';
  }
  if (error instanceof ConfigError) return 'auth';
  return 'network';
}

function describeError(error: unknown): string {
  if (error instanceof HttpError) {
    return error.status === 0 ? error.message : `HTTP ${error.status}: ${error.message}`;
  }
  return (error as Error)?.message ?? String(error);
}

/**
 * Скачивание фото безлимитного хранилища поштучно.
 *
 * Для каждого файла запрашивает подписанную ссылку (`mpfs/url`), качает её в
 * `.part` (с докачкой по Range), проверяет размер/md5 и атомарно переименовывает.
 * Массовая выгрузка ZIP отключена Яндексом, поэтому пачек больше нет.
 */
export class PhotoDownloader {
  constructor(
    private readonly client: PhotosliceClient,
    private readonly http: HttpClient,
    private readonly options: PhotoDownloaderOptions,
  ) {}

  async downloadOne(
    job: PhotoJob,
    onProgress?: (written: number) => void,
  ): Promise<PhotoDownloadResult> {
    const ref = job.remote_ref ?? job.id;
    const base = sanitizeSegment(basename(job.name ?? ref));
    let dest = join(this.options.photosDir, base);

    if (existsSync(dest)) {
      if (await matchesExisting(dest, job)) {
        return { id: job.id, status: 'skipped', localPath: dest, bytes: statSize(dest) };
      }
      // Файл с таким именем уже есть, но это другое содержимое — не затираем.
      dest = uniqueName(this.options.photosDir, base);
    }
    ensureDir(dirname(dest));

    const partPath = `${dest}.part`;

    try {
      const { url } = await this.client.getFileUrl(ref);
      const result = await this.http.downloadToFile(url, partPath, {
        rangeFrom: existsSync(partPath) ? statSize(partPath) : 0,
        connectTimeoutMs: this.options.connectTimeoutMs ?? 15_000,
        stallTimeoutMs: this.options.stallTimeoutMs ?? 60_000,
        sendAuth: false,
        onProgress,
      });

      const size = statSize(partPath);
      if (job.size !== null && job.size > 0 && size !== job.size) {
        rmSync(partPath, { force: true });
        throw new Error(`несовпадение размера: ${size} != ${job.size}`);
      }
      // md5 из каталога mpfs/list (если известен) — проверяем; digest из mpfs/url
      // для этого не годится, это ссылка на отдельный бинарный digest-файл.
      if (job.md5 && result.md5 !== job.md5) {
        rmSync(partPath, { force: true });
        throw new Error(`несовпадение md5: ${result.md5} != ${job.md5}`);
      }

      // Дедупликация по md5: одинаковое фото уже лежит под другим именем.
      const seen = this.options.seenMd5;
      if (seen?.has(result.md5)) {
        rmSync(partPath, { force: true });
        return { id: job.id, status: 'skipped', bytes: size, md5: result.md5 };
      }

      renameSync(partPath, dest);
      if (seen) seen.add(result.md5);
      return {
        id: job.id,
        status: 'downloaded',
        localPath: dest,
        bytes: size,
        md5: result.md5,
      };
    } catch (error) {
      rmSync(partPath, { force: true });
      return {
        id: job.id,
        status: 'failed',
        error: describeError(error),
        failureKind: classifyFailure(error),
      };
    }
  }
}

async function matchesExisting(path: string, job: PhotoJob): Promise<boolean> {
  const size = statSize(path);
  if (job.size !== null && job.size > 0 && size !== job.size) return false;
  if (job.md5) return (await md5File(path)) === job.md5;
  return true;
}

function uniqueName(dir: string, name: string): string {
  let candidate = join(dir, name);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = withSuffix(join(dir, name), counter++);
  }
  return candidate;
}
