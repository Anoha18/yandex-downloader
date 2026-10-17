import { once } from 'node:events';
import { createWriteStream } from 'node:fs';

import type { RateLimitConfig } from '../config/schema.js';
import { sleep } from '../util/async.js';
import { HttpError } from '../util/errors.js';
import { createMd5, hashFileInto } from '../util/hash.js';
import type { Limiter } from '../util/rateLimiter.js';

export const DISK_API_BASE = 'https://cloud-api.yandex.net/v1';

/** Хранилище не ответило: edge жив, но backend недоступен (сбой на стороне Яндекса). */
export const STORAGE_TIMEOUT_MESSAGE = 'нет ответа от хранилища (backend недоступен)';
/** Передача оборвалась из-за простоя. */
export const STALL_TIMEOUT_MESSAGE = 'передача прервана (таймаут простоя)';

export interface RequestOptions {
  /** Дополнительные query-параметры (кодируются автоматически). */
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  /** Ограничитель частоты запросов (базовый или адаптивный). */
  limiter?: Limiter;
  /** Параметры ретраев (maxAttempts, baseDelayMs, maxDelayMs). */
  rateLimit?: RateLimitConfig;
  /** Таймаут ожидания ответа (заголовков), мс. */
  requestTimeoutMs?: number;
  /** Инъекция fetch для тестов. */
  fetchImpl?: typeof fetch;
}

export interface DownloadOptions {
  /** Размер уже скачанной части (для докачки по Range). */
  rangeFrom?: number;
  signal?: AbortSignal;
  onProgress?: (written: number) => void;
  /** Таймаут ожидания ответа (заголовков), мс. */
  connectTimeoutMs?: number;
  /** Таймаут простоя без данных, мс. */
  stallTimeoutMs?: number;
  /** Отправлять OAuth-заголовок. Для подписанных ссылок (фото mpfs) не нужен. */
  sendAuth?: boolean;
}

export interface DownloadResult {
  bytes: number;
  md5: string;
}

function extractApiError(data: unknown): string | null {
  if (typeof data === 'string' && data.trim()) return data;
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    const parts = [record.message, record.description].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (parts.length > 0) return parts.join(': ');
  }
  return null;
}

function buildUrl(pathOrUrl: string, query?: RequestOptions['query']): string {
  const base = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${DISK_API_BASE}${pathOrUrl}`;
  if (!query) return base;
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(exp, 1000));
  return exp + jitter;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * HTTP-клиент к Disk API с OAuth-токеном.
 *
 * Ограничивает частоту запросов, повторяет сетевые ошибки/429/5xx с экспонентой
 * и уважает Retry-After. Умеет скачивать файл потоково в `.part` с докачкой по Range.
 */
export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly accessToken: string,
    private readonly options: HttpClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  async getJson<T>(pathOrUrl: string, options: RequestOptions = {}): Promise<T> {
    const url = buildUrl(pathOrUrl, options.query);
    const maxAttempts = Math.max(this.options.rateLimit?.maxAttempts ?? 5, 1);
    const baseDelay = this.options.rateLimit?.baseDelayMs ?? 1000;
    const maxDelay = this.options.rateLimit?.maxDelayMs ?? 60_000;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.options.limiter?.acquire();

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: {
            Authorization: `OAuth ${this.accessToken}`,
            Accept: 'application/json',
          },
          signal: combineSignal(options.signal, this.requestTimeoutMs),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = error;
        if (attempt >= maxAttempts) break;
        await sleep(backoffDelay(attempt, baseDelay, maxDelay));
        continue;
      }

      if (response.ok) {
        this.options.limiter?.recordSuccess?.();
        return await this.parseJson<T>(response);
      }

      if (response.status === 429 || response.status >= 500) {
        this.options.limiter?.recordError?.(response.status);
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        lastError = await this.errorFrom(response);
        if (attempt >= maxAttempts) break;
        await sleep(retryAfter ?? backoffDelay(attempt, baseDelay, maxDelay));
        continue;
      }

      throw await this.errorFrom(response);
    }

    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(
      0,
      `Disk API: запрос не удался после ${maxAttempts} попыток: ${(lastError as Error)?.message ?? String(lastError)}`,
    );
  }

  /**
   * Скачивает файл по ссылке в destPath потоково, считая md5.
   *
   * При rangeFrom > 0 и ответе 206 — докачивает; при 200 (сервер не поддержал
   * Range) — начинает заново, сбрасывая префикс из хэша.
   */
  async downloadToFile(
    url: string,
    destPath: string,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    await this.options.limiter?.acquire();

    const prefix = options.rangeFrom ?? 0;
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const headers: Record<string, string> = { Accept: '*/*' };
    if (this.accessToken && options.sendAuth !== false) {
      headers.Authorization = `OAuth ${this.accessToken}`;
    }
    if (prefix > 0) headers.Range = `bytes=${prefix}-`;

    const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    let headerTimedOut = false;
    const headerTimer = setTimeout(() => {
      headerTimedOut = true;
      controller.abort();
    }, connectTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal: controller.signal });
    } catch (error) {
      if (headerTimedOut) throw new HttpError(0, STORAGE_TIMEOUT_MESSAGE);
      throw error;
    } finally {
      clearTimeout(headerTimer);
    }

    if (response.status === 429 || response.status >= 500) {
      this.options.limiter?.recordError?.(response.status);
      throw new HttpError(response.status, `download: HTTP ${response.status}`);
    }

    if (response.status === 416 && prefix > 0) {
      const hash = createMd5();
      await hashFileInto(hash, destPath);
      this.options.limiter?.recordSuccess?.();
      return { bytes: prefix, md5: hash.digest('hex') };
    }

    if (response.status !== 200 && response.status !== 206) {
      throw new HttpError(response.status, `download: HTTP ${response.status}`);
    }

    const resuming = prefix > 0 && response.status === 206;
    const hash = createMd5();
    let written = 0;
    if (resuming) {
      await hashFileInto(hash, destPath);
      written = prefix;
    }

    const out = createWriteStream(destPath, { flags: resuming ? 'a' : 'w' });
    // Постоянный обработчик ошибок: иначе при обрыве загрузки (destroy во время
    // незавершённого write) Node эмитит 'error' без слушателя и роняет процесс.
    let streamError: Error | null = null;
    out.on('error', (error: Error) => {
      streamError = error;
    });
    const stallMs = options.stallTimeoutMs ?? 300_000;
    let lastData = Date.now();
    let stalled = false;
    const watchdog = setInterval(
      () => {
        if (Date.now() - lastData > stallMs) {
          stalled = true;
          controller.abort();
        }
      },
      Math.max(1000, Math.floor(stallMs / 3)),
    );

    try {
      const body = response.body;
      if (!body) throw new HttpError(response.status, 'download: пустое тело ответа');
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (streamError) throw streamError;
        lastData = Date.now();
        const chunk = Buffer.from(value);
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
        if (streamError) throw streamError;
        written += chunk.length;
        options.onProgress?.(written);
      }
      out.end();
      await once(out, 'finish');
      if (streamError) throw streamError;
      this.options.limiter?.recordSuccess?.();
      return { bytes: written, md5: hash.digest('hex') };
    } catch (error) {
      if (!out.destroyed) out.destroy();
      if (stalled) throw new HttpError(0, STALL_TIMEOUT_MESSAGE);
      if (streamError) throw streamError;
      throw error;
    } finally {
      clearInterval(watchdog);
    }
  }

  private async parseJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private async errorFrom(response: Response): Promise<HttpError> {
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    const detail = extractApiError(data) ?? response.statusText;
    return new HttpError(response.status, `Disk API: ${detail} (HTTP ${response.status})`, data);
  }
}
