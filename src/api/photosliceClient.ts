import { basename } from 'node:path';

import type { Cookie } from '../auth/cookies.js';
import { cookiesToRecord } from '../auth/cookies.js';
import { sleep } from '../util/async.js';
import { ConfigError, HttpError } from '../util/errors.js';

const BASE = 'https://disk.yandex.ru';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Сессионные cookies, по которым определяем авторизацию. */
const SESSION_COOKIE_NAMES = ['Session_id', 'sessionid', 'yandex_login', 'L'];

/** Корень безлимитного фото-хранилища во внутреннем API Диска. */
export const UNLIM_ROOT = '/photounlim';
/** Сколько детей запрашивать за одну страницу mpfs/list. */
export const LIST_PAGE = 1000;
const LIST_META = 'size,md5,mimetype,mediatype';

/** Файл безлимитного хранилища (mpfs). */
export interface PhotoItem {
  id: string;
  name: string;
  size: number | null;
  md5: string | null;
  mime: string | null;
  remoteRef: string;
}

/** Страница листинга папки безлимита. */
export interface ListPage {
  files: PhotoItem[];
  dirs: string[];
  /** Сколько детей пришло на странице (без самой папки). */
  children: number;
}

/** Подписанная ссылка на оригинал файла. */
export interface FileUrl {
  url: string;
}

export type FetchLike = typeof fetch;

export interface PhotosliceOptions {
  cookies: Cookie[];
  fetchImpl?: FetchLike;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Вызывается при 401/403: пересобрать cookies (например, через браузер). */
  onSessionExpired?: () => Promise<Cookie[]>;
}

interface ApiError {
  status: number | null;
  code: number | null;
  title: string | null;
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return exp + Math.floor(Math.random() * Math.min(exp, 1000));
}

function makeConnectionId(uid: string): string {
  return `${uid}${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

function buildCookieHeader(cookies: Cookie[]): string {
  return Object.entries(cookiesToRecord(cookies))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Достаёт ошибку из тела ответа web-API (`{error:{statusCode,code,title}}` или строка). */
function extractApiError(data: unknown): ApiError | null {
  if (!isPlainObject(data) || !('error' in data)) return null;
  const raw = data.error;
  if (typeof raw === 'string') return { status: null, code: null, title: raw };
  if (!isPlainObject(raw)) return null;
  return {
    status: typeof raw.statusCode === 'number' ? raw.statusCode : null,
    code: typeof raw.code === 'number' ? raw.code : null,
    title: typeof raw.title === 'string' ? raw.title : null,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Клиент внутреннего web-API безлимитного фото-хранилища Яндекса (mpfs).
 *
 * Неофициальный интерфейс `disk.yandex.ru/models-v2`, требует cookies браузерной
 * сессии. Массовая выгрузка ZIP (`mpfs/bulk-download-prepare`) отключена Яндексом
 * (HTTP 429, code 394), поэтому файлы перечисляются через `mpfs/list`, а качаются
 * поштучно по подписанной ссылке из `mpfs/url`.
 */
export class PhotosliceClient {
  private readonly fetchImpl: FetchLike;
  private cookieHeader: string;
  private sk: string | null = null;
  private uid: string | null = null;
  private refreshedForSession = false;

  constructor(private readonly options: PhotosliceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cookieHeader = buildCookieHeader(options.cookies);
  }

  private applyCookies(cookies: Cookie[]): void {
    this.cookieHeader = buildCookieHeader(cookies);
    this.sk = null;
    this.uid = null;
  }

  private baseHeaders(json: boolean): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'ru,en;q=0.9',
      Cookie: this.cookieHeader,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async ensureSession(): Promise<void> {
    if (this.sk && this.uid) return;

    const response = await this.fetchImpl(`${BASE}/client/disk`, {
      headers: this.baseHeaders(false),
    });
    const html = await response.text();

    if (
      response.status === 401 ||
      response.status === 403 ||
      /passport\.yandex/i.test(response.url)
    ) {
      throw new ConfigError('Cookies невалидны — сессия истекла. Обновите: yd photos auth');
    }
    if (!response.ok) {
      throw new HttpError(
        response.status,
        `photoslice: не удалось открыть страницу Диска (HTTP ${response.status})`,
      );
    }

    const sk = html.match(/"sk"\s*:\s*"([^"]+)"/);
    const uid = html.match(/"uid"\s*:\s*"?(\d+)"?/);
    if (!sk?.[1] || !uid?.[1]) {
      throw new ConfigError(
        'Не удалось извлечь sk/uid со страницы Диска (Яндекс изменил формат). Обновите: yd photos auth',
      );
    }
    this.sk = sk[1];
    this.uid = uid[1];
  }

  private async call(method: string, params?: unknown): Promise<unknown> {
    await this.ensureSession();

    const body: Record<string, unknown> = {
      sk: this.sk,
      connection_id: makeConnectionId(this.uid as string),
      apiMethod: method,
    };
    if (params !== undefined) body.requestParams = params;

    const maxAttempts = Math.max(this.options.maxAttempts ?? 4, 1);
    const baseDelay = this.options.baseDelayMs ?? 1000;
    const maxDelay = this.options.maxDelayMs ?? 60_000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${BASE}/models-v2?m=${encodeURIComponent(method)}`, {
          method: 'POST',
          headers: {
            ...this.baseHeaders(true),
            Origin: BASE,
            Referer: `${BASE}/client/photo`,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;
        await sleep(backoffDelay(attempt, baseDelay, maxDelay));
        continue;
      }

      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }

      if (response.ok) {
        const apiError = extractApiError(data);
        if (apiError) {
          throw new HttpError(
            apiError.status ?? response.status,
            `photoslice ${method}: ${apiError.title ?? 'ошибка API'}`,
            data,
          );
        }
        if (!data || typeof data !== 'object') {
          throw new HttpError(response.status, `photoslice ${method}: неожиданный ответ`, data);
        }
        this.refreshedForSession = false;
        return data;
      }

      if (response.status === 401 || response.status === 403) {
        if (this.options.onSessionExpired && !this.refreshedForSession) {
          this.refreshedForSession = true;
          const fresh = await this.options.onSessionExpired();
          this.applyCookies(fresh);
          continue;
        }
        throw new ConfigError(
          `Сессия истекла (HTTP ${response.status}). Обновите cookies: yd photos auth`,
        );
      }

      const apiError = extractApiError(data);
      // Массовая выгрузка ZIP отключена Яндексом (code 394) — повторять бессмысленно.
      if (
        response.status === 429 &&
        (apiError?.code === 394 || /temporarily disabled/i.test(apiError?.title ?? ''))
      ) {
        throw new HttpError(
          response.status,
          `photoslice ${method}: ${apiError?.title ?? 'функция отключена на стороне Яндекса'}`,
          data,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new HttpError(
          response.status,
          `photoslice ${method}: HTTP ${response.status}`,
          data,
        );
        if (attempt >= maxAttempts) break;
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        await sleep(retryAfter ?? backoffDelay(attempt, baseDelay, maxDelay));
        continue;
      }
      throw new HttpError(response.status, `photoslice ${method}: HTTP ${response.status}`, data);
    }

    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(
      0,
      `photoslice ${method}: запрос не удался: ${(lastError as Error)?.message ?? String(lastError)}`,
    );
  }

  /**
   * Одна страница листинга папки безлимита (`mpfs/list`).
   *
   * API возвращает саму папку первым элементом (её пропускаем) и до `amount`
   * детей. `offset` считается по детям, без учёта самой папки.
   */
  async listDir(path: string = UNLIM_ROOT, offset = 0, amount = LIST_PAGE): Promise<ListPage> {
    const data = await this.call('mpfs/list', {
      path,
      amount,
      offset,
      meta: LIST_META,
    });
    if (!Array.isArray(data)) {
      throw new HttpError(200, 'photoslice mpfs/list: ожидался список', data);
    }

    const normalizedDir = path.replace(/\/+$/, '') || '/';
    const files: PhotoItem[] = [];
    const dirs: string[] = [];
    for (const raw of data) {
      if (!isPlainObject(raw)) continue;
      const itemPath = str(raw.path);
      if (!itemPath) continue;
      const normalized = itemPath.replace(/\/+$/, '') || '/';
      // Первый элемент ответа — сама запрошенная папка.
      if (normalized === normalizedDir || normalized === '/') continue;
      // Корзину не качаем: это удалённые фото.
      if (normalized.startsWith('/trash')) continue;

      if (raw.type === 'dir') {
        dirs.push(normalized);
        continue;
      }
      if (raw.type !== 'file') continue;

      const meta = isPlainObject(raw.meta) ? raw.meta : {};
      files.push({
        id: normalized,
        name: str(raw.name) ?? basename(normalized),
        size: num(meta.size) ?? num(raw.size),
        md5: str(meta.md5) ?? str(meta.etag),
        mime: str(meta.mimetype) ?? str(meta.mediatype) ?? str(meta.type) ?? str(raw.mimetype),
        remoteRef: normalized,
      });
    }
    return { files, dirs, children: files.length + dirs.length };
  }

  /** Подписанная ссылка на оригинал файла (`mpfs/url`). */
  async getFileUrl(ref: string): Promise<FileUrl> {
    const data = await this.call('mpfs/url', { path: ref });
    if (!isPlainObject(data)) {
      throw new HttpError(200, 'photoslice mpfs/url: неожиданный ответ', data);
    }
    const raw = data.file;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new HttpError(200, 'photoslice: не получена ссылка на файл', data);
    }
    return { url: raw.startsWith('//') ? `https:${raw}` : raw };
  }
}

/** Проверяет, что в cookies есть признак активной сессии. */
export function hasSession(cookies: Cookie[]): boolean {
  return cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
}
