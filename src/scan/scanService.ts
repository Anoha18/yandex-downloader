import { type DiskApi, type DiskResource, PAGE_LIMIT } from '../api/diskApi.js';
import type { FileUpsert, StateDb } from '../state/db.js';
import type { Logger } from '../util/logger.js';
import type { ProgressReporter } from '../util/progress.js';
import { buildTree, writeTreeFile } from './tree.js';

export interface ScanOptions {
  /** Рекурсивный обход (полное дерево, включая пустые папки). */
  deep?: boolean;
  /** Корень обхода (по умолчанию «/»). */
  path?: string;
  /** Если задано — выгрузить дерево в JSON. */
  export?: string;
}

export interface ScanSettings {
  /** Число одновременных запросов/воркеров. */
  concurrency?: number;
  /** Размер страницы плоского списка (для тестов). */
  pageLimit?: number;
}

export interface ScanResult {
  mode: 'flat' | 'deep';
  files: number;
  dirs: number;
  totalSize: number;
  durationMs: number;
}

interface Counters {
  files: number;
  dirs: number;
  totalSize: number;
}

/** Префиксы путей, которые никогда не сканируем (Корзина). */
const TRASH_PREFIXES = ['disk:/Корзина', 'disk:/Trash', '/Корзина', '/Trash'];

function isTrash(path: string): boolean {
  return TRASH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function normalizePath(path: string): string {
  if (path.startsWith('disk:')) return path;
  if (path.startsWith('/')) return `disk:${path}`;
  return `disk:/${path}`;
}

function toFileUpsert(item: DiskResource): FileUpsert {
  return {
    path: item.path,
    size: item.size ?? null,
    md5: item.md5 ?? null,
    mime: item.mime_type ?? null,
  };
}

/** Оркестрация сканирования Диска (плоский список или рекурсивный обход). */
export class ScanService {
  private readonly concurrency: number;
  private readonly pageLimit: number;

  constructor(
    private readonly api: DiskApi,
    private readonly db: StateDb,
    private readonly log: Logger,
    settings: ScanSettings = {},
    private readonly progress?: ProgressReporter,
  ) {
    this.concurrency = Math.max(1, settings.concurrency ?? 1);
    this.pageLimit = settings.pageLimit ?? PAGE_LIMIT;
  }

  async run(options: ScanOptions = {}): Promise<ScanResult> {
    const startedAt = Date.now();
    const mode = options.deep ? 'deep' : 'flat';
    const root = normalizePath(options.path ?? '/');

    this.db.setMeta('scan_mode', mode);
    this.db.setMeta('scan_root', root);
    this.db.setMeta('scan_started_at', new Date().toISOString());
    this.db.setMeta('scan_concurrency', String(this.concurrency));

    this.progress?.info(
      `Начинаю ${mode === 'deep' ? 'рекурсивный' : 'плоский'} обход (воркеров: ${this.concurrency})`,
    );

    const counters = options.deep ? await this.deepScan(root) : await this.flatScan();

    try {
      const info = await this.api.getDiskInfo();
      this.db.setMeta('disk_total_space', String(info.total_space));
      this.db.setMeta('disk_used_space', String(info.used_space));
    } catch (error) {
      this.progress?.warn(`Не удалось получить информацию о диске: ${(error as Error).message}`);
    }

    this.db.setMeta('scan_finished_at', new Date().toISOString());
    this.db.setMeta('scan_files', String(counters.files));
    this.db.setMeta('scan_dirs', String(counters.dirs));
    this.db.setMeta('scan_total_size', String(counters.totalSize));

    if (options.export) {
      writeTreeFile(options.export, buildTree(this.db.allFiles()));
      this.progress?.info(`Дерево выгружено в ${options.export}`);
    }

    return { mode, ...counters, durationMs: Date.now() - startedAt };
  }

  /**
   * Плоский скан: пул воркеров тянет страницы по общему счётчику offset.
   * Общий rate limiter в HttpClient держит фактический QPS в рамках профиля.
   */
  private async flatScan(): Promise<Counters> {
    const counters: Counters = { files: 0, dirs: 0, totalSize: 0 };
    let nextOffset = 0;
    let finished = false;

    const worker = async (): Promise<void> => {
      while (!finished) {
        const offset = nextOffset;
        nextOffset += this.pageLimit;

        const { items, effectiveLimit } = await this.api.listFilesPage(offset, this.pageLimit);
        if (items.length === 0) {
          finished = true;
          return;
        }

        const batch: FileUpsert[] = [];
        let pageBytes = 0;
        for (const item of items) {
          if (isTrash(item.path)) continue;
          batch.push(toFileUpsert(item));
          counters.files += 1;
          counters.totalSize += item.size ?? 0;
          pageBytes += item.size ?? 0;
        }
        this.db.upsertFiles(batch);

        this.progress?.incItems(batch.length);
        this.progress?.addBytes(pageBytes);
        this.log.debug(`Получено файлов: ${counters.files}`);

        if (items.length < effectiveLimit) finished = true;
      }
    };

    await Promise.all(Array.from({ length: this.concurrency }, () => worker()));
    this.log.debug(`Плоский скан завершён: файлов ${counters.files}`);
    return counters;
  }

  /** Рекурсивный обход: пул воркеров атомарно забирает папки из очереди. */
  private async deepScan(root: string): Promise<Counters> {
    const reset = this.db.resetDirsInProgress();
    if (reset > 0) this.progress?.info(`Возобновление: ${reset} папок возвращено в очередь`);
    this.db.upsertDirs([{ path: root, parent: null }]);

    const counters: Counters = { files: 0, dirs: 0, totalSize: 0 };

    const worker = async (): Promise<void> => {
      for (;;) {
        const [dirPath] = this.db.claimPendingDirs(1);
        if (!dirPath) return;
        this.progress?.setActivity(`сканирую ${dirPath}`);

        try {
          const items = await this.api.listDir(dirPath);
          const childDirs: Array<{ path: string; parent: string | null }> = [];
          const batch: FileUpsert[] = [];
          let batchBytes = 0;
          for (const item of items) {
            if (isTrash(item.path)) continue;
            if (item.type === 'dir') {
              childDirs.push({ path: item.path, parent: dirPath });
              counters.dirs += 1;
            } else {
              batch.push(toFileUpsert(item));
              counters.files += 1;
              counters.totalSize += item.size ?? 0;
              batchBytes += item.size ?? 0;
            }
          }
          this.db.upsertDirs(childDirs);
          this.db.upsertFiles(batch);
          this.db.markDirScanned(dirPath);

          this.progress?.incItems(batch.length);
          this.progress?.addBytes(batchBytes);
        } catch (error) {
          this.db.markDirFailed(dirPath, (error as Error).message);
          this.progress?.warn(`Не удалось прочитать ${dirPath}: ${(error as Error).message}`);
        }
      }
    };

    await Promise.all(Array.from({ length: this.concurrency }, () => worker()));
    this.progress?.clearActivity();
    this.log.debug(`Рекурсивный скан завершён: папок ${counters.dirs}, файлов ${counters.files}`);
    return counters;
  }
}
