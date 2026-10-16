import type { HttpClient } from './httpClient.js';

/** Ресурс Яндекс.Диска (файл или папка). */
export interface DiskResource {
  path: string;
  name: string;
  type: 'dir' | 'file';
  size?: number;
  md5?: string;
  mime_type?: string;
  created?: string;
  modified?: string;
}

/** Информация о диске (ответ GET /v1/disk). */
export interface DiskInfo {
  total_space: number;
  used_space: number;
  trash_size: number;
  system_folders?: Record<string, string>;
  user?: {
    login?: string;
    display_name?: string;
    uid?: string;
    country?: string;
  };
}

interface ResourcesResponse {
  _embedded?: {
    items?: DiskResource[];
    limit?: number;
    offset?: number;
    total?: number;
  };
}

/** Ответ плоского списка всех файлов (GET /v1/disk/resources/files). */
interface FilesResponse {
  items?: DiskResource[];
  limit?: number;
  offset?: number;
}

interface LinkResponse {
  href: string;
  method?: string;
  templated?: boolean;
}

/** Поля ресурса для листинга папки (без preview). */
const ITEM_FIELDS = [
  '_embedded.total',
  '_embedded.limit',
  '_embedded.offset',
  '_embedded.items.path',
  '_embedded.items.name',
  '_embedded.items.type',
  '_embedded.items.size',
  '_embedded.items.md5',
  '_embedded.items.mime_type',
  '_embedded.items.created',
  '_embedded.items.modified',
].join(',');

/** Поля файла для плоского списка. */
const FILE_FIELDS = [
  'path',
  'name',
  'type',
  'size',
  'md5',
  'mime_type',
  'created',
  'modified',
].join(',');

/** Размер страницы листинга папки/файлов. */
export const PAGE_LIMIT = 1000;

/** Приводит «disk:/»-путь к виду, который принимает API. */
function toApiPath(path: string): string {
  return path === 'disk:' || path === 'disk:/' ? '/' : path;
}

/**
 * Обёртка над Disk REST API (https://cloud-api.yandex.net/v1).
 *
 * Реализованы: информация о диске, листинг папки, плоский список всех файлов
 * (с пагинацией) и ссылка на скачивание. Скачивание файлов — Этап 3.
 */
export class DiskApi {
  constructor(private readonly http: HttpClient) {}

  getDiskInfo(): Promise<DiskInfo> {
    return this.http.getJson<DiskInfo>('/disk');
  }

  /** Содержимое папки целиком (все страницы). */
  async listDir(path = '/'): Promise<DiskResource[]> {
    const items: DiskResource[] = [];
    let offset = 0;

    for (;;) {
      const page = await this.http.getJson<ResourcesResponse>('/disk/resources', {
        query: { path: toApiPath(path), limit: PAGE_LIMIT, offset, fields: ITEM_FIELDS },
      });
      const embedded = page._embedded;
      const pageItems = embedded?.items ?? [];
      items.push(...pageItems);

      const total = embedded?.total;
      const nextOffset = offset + pageItems.length;
      if (pageItems.length === 0 || (typeof total === 'number' && nextOffset >= total)) break;
      offset = nextOffset;
    }

    return items;
  }

  /** Одна страница плоского списка файлов. */
  async listFilesPage(
    offset: number,
    limit = PAGE_LIMIT,
  ): Promise<{ items: DiskResource[]; effectiveLimit: number }> {
    const page = await this.http.getJson<FilesResponse>('/disk/resources/files', {
      query: { limit, offset, fields: FILE_FIELDS },
    });
    const items = page.items ?? [];
    const effectiveLimit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : limit;
    return { items, effectiveLimit };
  }

  /**
   * Итератор по страницам плоского списка всех файлов Диска (последовательный).
   *
   * В ответе нет общего количества, поэтому пагинация продолжается до пустой
   * страницы. Есть защита от не-продвижения (если offset сервер игнорирует).
   */
  async *iterateAllFiles(pageLimit = PAGE_LIMIT): AsyncGenerator<DiskResource[]> {
    let offset = 0;
    let previousFirstPath: string | null = null;

    for (;;) {
      const { items, effectiveLimit } = await this.listFilesPage(offset, pageLimit);
      if (items.length === 0) return;

      const firstPath = items[0]?.path ?? null;
      if (firstPath !== null && firstPath === previousFirstPath) return;
      previousFirstPath = firstPath;

      yield items;

      offset += items.length;
      if (items.length < effectiveLimit) return;
    }
  }

  /** Получает временную ссылку на скачивание файла. */
  async getDownloadUrl(path: string): Promise<string> {
    const link = await this.http.getJson<LinkResponse>('/disk/resources/download', {
      query: { path },
    });
    return link.href;
  }
}
