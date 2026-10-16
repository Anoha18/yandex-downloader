import type { Cookie } from '../auth/cookies.js';
import { cookiesToRecord } from '../auth/cookies.js';
import { sleep } from '../util/async.js';
import { ConfigError, HttpError } from '../util/errors.js';

const BASE = 'https://disk.yandex.ru';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Сессионные cookies, по которым определяем авторизацию. */
const SESSION_COOKIE_NAMES = ['Session_id', 'sessionid', 'yandex_login', 'L'];

export interface PhotoCluster {
  id: string;
  size: number;
}

export interface PhotoItem {
  id: string;
  clusterId: string;
  name: string | null;
  size: number | null;
  md5: string | null;
  mime: string | null;
  takenAt: string | null;
  remoteRef: string;
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

/**
 * Клиент внутреннего web-API безлимитного фото-хранилища Яндекса (photoslice).
 *
 * Неофициальный интерфейс `disk.yandex.ru/models-v2`, требует cookies браузерной
 * сессии. Может измениться со стороны Яндекса.
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

    if (!response.ok || /passport\.yandex/i.test(response.url)) {
      throw new ConfigError('Cookies невалидны — сессия истекла. Обновите: yd photos auth');
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

  private async call(method: string, params?: unknown): Promise<Record<string, unknown>> {
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
        if (!data || typeof data !== 'object') {
          throw new HttpError(response.status, `photoslice ${method}: неожиданный ответ`, data);
        }
        this.refreshedForSession = false;
        return data as Record<string, unknown>;
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
      if (response.status === 429 || response.status >= 500) {
        lastError = new HttpError(
          response.status,
          `photoslice ${method}: HTTP ${response.status}`,
          data,
        );
        if (attempt >= maxAttempts) break;
        await sleep(backoffDelay(attempt, baseDelay, maxDelay));
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

  async initSnapshot(): Promise<string> {
    const data = await this.call('intapi/photo-init-snapshot');
    const psid = data.photoslice_id;
    if (typeof psid !== 'string' || psid.length === 0) {
      throw new HttpError(200, 'photoslice: не получен photoslice_id', data);
    }
    return psid;
  }

  /** Готовит ZIP-архив для пачки фото и возвращает ссылку на скачивание. */
  async bulkDownloadPrepare(refs: string[]): Promise<string> {
    const data = await this.call('mpfs/bulk-download-prepare', { items: refs });
    const raw = data.download_url;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new HttpError(200, 'photoslice: не получен download_url', data);
    }
    return raw.startsWith('//') ? `https:${raw}` : raw;
  }

  async getSnapshot(psid: string, amount = 100_000, offset = 0): Promise<PhotoCluster[]> {
    const data = await this.call('intapi/photo-get-snapshot', {
      id: psid,
      locale: 'ru',
      amount,
      offset,
    });
    const items = Array.isArray(data.items) ? data.items : [];
    const clusters: PhotoCluster[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const id = item.id;
      if (id === undefined || id === null) continue;
      clusters.push({ id: String(id), size: Number(item.size ?? 0) || 0 });
    }
    return clusters;
  }

  async getClustersWithResources(
    psid: string,
    clusters: PhotoCluster[],
    hideScreenshots = false,
  ): Promise<PhotoItem[]> {
    const clustersMap: Record<string, { range: [number, number] }> = {};
    for (const cluster of clusters) {
      clustersMap[cluster.id] = { range: [0, Math.max(cluster.size - 1, 0)] };
    }

    const data = await this.call('intapi/photo-get-clusters-with-resources', {
      photosliceId: psid,
      clusters: clustersMap,
      hideScreenshots,
    });

    const clustersObj = data.clusters as Record<string, unknown> | undefined;
    const fetched = Array.isArray(clustersObj?.fetched) ? (clustersObj?.fetched as unknown[]) : [];

    const result: PhotoItem[] = [];
    for (const rawCluster of fetched) {
      const cluster = rawCluster as Record<string, unknown>;
      const clusterId = String(cluster.id ?? '');
      const items = Array.isArray(cluster.items) ? cluster.items : [];
      for (const rawItem of items) {
        const item = rawItem as Record<string, unknown>;
        const id = item.id ?? item.resource_id;
        if (id === undefined || id === null) continue;
        const idStr = String(id);
        result.push({
          id: idStr,
          clusterId,
          name: str(item.name),
          size: num(item.size),
          md5: str(item.md5) ?? str(item.etag),
          mime: str(item.mimetype) ?? str(item.type),
          takenAt: str(item.taken_at) ?? str(item.created),
          remoteRef: idStr,
        });
      }
    }
    return result;
  }
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

/** Проверяет, что в cookies есть признак активной сессии. */
export function hasSession(cookies: Cookie[]): boolean {
  return cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
}
