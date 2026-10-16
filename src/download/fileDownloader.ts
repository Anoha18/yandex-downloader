import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DiskApi } from '../api/diskApi.js';
import { type HttpClient, STORAGE_TIMEOUT_MESSAGE } from '../api/httpClient.js';
import type { FileJob } from '../state/db.js';
import { sleep } from '../util/async.js';
import { HttpError } from '../util/errors.js';
import { md5File } from '../util/hash.js';
import { ensureDir } from '../util/paths.js';
import { PathAllocator } from './localPath.js';

export interface FileDownloadResult {
  status: 'downloaded' | 'skipped' | 'failed';
  localPath: string;
  bytes: number;
  error?: string;
  /** Причина — недоступность backend хранилища (сбой на стороне Яндекса). */
  storageUnavailable?: boolean;
}

export interface FileRetryInfo {
  attempt: number;
  maxAttempts: number;
  reason: string;
  delayMs: number;
}

export interface FileDownloaderOptions {
  downloadDir: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Таймаут ожидания ответа при скачивании, мс. */
  connectTimeoutMs?: number;
  /** Сколько быстрых попыток делать при недоступном backend хранилища. */
  storageMaxAttempts?: number;
  /** Сколько быстрых попыток делать при сетевых обрывах (terminated/fetch failed). */
  networkMaxAttempts?: number;
  onProgress?: (remotePath: string, written: number, total: number | null) => void;
  onRetry?: (info: FileRetryInfo) => void;
}

/** Класс ошибки скачивания: определяет число и темп повторов. */
type FailureKind = 'storage' | 'network' | 'fatal';

const STORAGE_CAP_MS = 1000;
const NETWORK_CAP_MS = 3000;

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function classifyFailure(error: unknown): FailureKind {
  if (
    error instanceof HttpError &&
    error.status === 0 &&
    error.message === STORAGE_TIMEOUT_MESSAGE
  ) {
    return 'storage';
  }
  if (error instanceof HttpError) {
    // 429/5xx — временные, повторяем; остальные 4xx — смысла нет.
    return error.status === 429 || error.status >= 500 ? 'network' : 'fatal';
  }
  // Сетевые обрывы (terminated, fetch failed, ECONNRESET, таймауты и т.п.) — быстрые повторы.
  return 'network';
}

function fastDelay(attempt: number, capMs: number): number {
  const exp = Math.min(capMs, 500 * 2 ** (attempt - 1));
  return exp + Math.floor(Math.random() * 250);
}

function describeError(error: unknown): string {
  if (error instanceof HttpError) {
    return error.status === 0 ? error.message : `HTTP ${error.status}`;
  }
  const name = (error as Error)?.name;
  const message = (error as Error)?.message ?? String(error);
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|abort/i.test(message)) {
    return 'таймаут соединения';
  }
  return message;
}

/** Скачивание одного файла Диска: `.part` → проверка md5 → атомарный rename. */
export class FileDownloader {
  private readonly allocator: PathAllocator;

  constructor(
    private readonly api: DiskApi,
    private readonly http: HttpClient,
    private readonly options: FileDownloaderOptions,
  ) {
    this.allocator = new PathAllocator(options.downloadDir);
  }

  async download(
    job: FileJob,
    onProgress?: (written: number) => void,
  ): Promise<FileDownloadResult> {
    const localPath =
      job.local_path && existsSync(job.local_path)
        ? job.local_path
        : this.allocator.allocate(job.path);

    if (existsSync(localPath)) {
      if (await this.verifyExisting(localPath, job)) {
        return { status: 'skipped', localPath, bytes: statSize(localPath) };
      }
      rmSync(localPath, { force: true });
    }

    const partPath = `${localPath}.part`;
    ensureDir(dirname(localPath));

    // Не превышаем общий лимит попыток из конфига, но для скачивания делаем быстрые повторы.
    const storageMax = Math.max(
      1,
      Math.min(this.options.storageMaxAttempts ?? 2, this.options.maxAttempts),
    );
    const networkMax = Math.max(
      1,
      Math.min(this.options.networkMaxAttempts ?? 3, this.options.maxAttempts),
    );

    let lastError = '';
    let storageUnavailable = false;
    let storageAttempts = 0;
    let networkAttempts = 0;

    for (;;) {
      try {
        const href = await this.api.getDownloadUrl(job.path);
        const rangeFrom = existsSync(partPath) ? statSize(partPath) : 0;
        const result = await this.http.downloadToFile(href, partPath, {
          rangeFrom,
          connectTimeoutMs: this.options.connectTimeoutMs,
          onProgress: (written) => {
            this.options.onProgress?.(job.path, written, job.size);
            onProgress?.(written);
          },
        });

        const size = statSize(partPath);
        if (job.size !== null && size !== job.size) {
          throw new Error(`несовпадение размера: ${size} != ${job.size}`);
        }
        if (job.md5 && result.md5 !== job.md5) {
          rmSync(partPath, { force: true });
          throw new Error(`несовпадение md5: ${result.md5} != ${job.md5}`);
        }

        renameSync(partPath, localPath);
        return { status: 'downloaded', localPath, bytes: size };
      } catch (error) {
        lastError = describeError(error);
        const kind = classifyFailure(error);

        if (kind === 'fatal') break; // 4xx и прочее, что не станет лучше — без повторов

        if (kind === 'storage') {
          storageUnavailable = true;
          storageAttempts += 1;
          if (storageAttempts >= storageMax) break;
          const delayMs = fastDelay(storageAttempts, STORAGE_CAP_MS);
          this.options.onRetry?.({
            attempt: storageAttempts,
            maxAttempts: storageMax,
            reason: lastError,
            delayMs,
          });
          await sleep(delayMs);
        } else {
          networkAttempts += 1;
          if (networkAttempts >= networkMax) break;
          const delayMs = fastDelay(networkAttempts, NETWORK_CAP_MS);
          this.options.onRetry?.({
            attempt: networkAttempts,
            maxAttempts: networkMax,
            reason: lastError,
            delayMs,
          });
          await sleep(delayMs);
        }
      }
    }

    return { status: 'failed', localPath, bytes: 0, error: lastError, storageUnavailable };
  }

  private async verifyExisting(localPath: string, job: FileJob): Promise<boolean> {
    const size = statSize(localPath);
    if (job.size !== null && size !== job.size) return false;
    if (job.md5) return (await md5File(localPath)) === job.md5;
    return true;
  }
}
