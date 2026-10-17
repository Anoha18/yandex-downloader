import {
  LIST_PAGE,
  type PhotoItem,
  type PhotosliceClient,
  UNLIM_ROOT,
} from '../api/photosliceClient.js';
import type { PhotoUpsert, StateDb } from '../state/db.js';
import type { Logger } from '../util/logger.js';
import type { ProgressReporter } from '../util/progress.js';

export interface PhotosScanOptions {
  /** Сколько детей запрашивать за одну страницу `mpfs/list`. */
  pageSize?: number;
  /** Корень безлимитного хранилища. */
  root?: string;
}

export interface PhotosScanResult {
  /** Сколько фото прочитано с сервера (с учётом повторного сбора). */
  files: number;
  /** Сколько папок обойдено. */
  dirs: number;
  totalSize: number;
  durationMs: number;
}

/**
 * Сбор каталога безлимитного фото-хранилища (`/photounlim`) в БД.
 *
 * Использует постраничный `mpfs/list`, который сразу отдаёт имя, размер и md5 —
 * это позволяет качать и проверять каждый файл по отдельности.
 */
export class PhotosService {
  private readonly pageSize: number;
  private readonly root: string;

  constructor(
    private readonly client: PhotosliceClient,
    private readonly db: StateDb,
    private readonly log: Logger,
    options: PhotosScanOptions = {},
    private readonly progress?: ProgressReporter,
  ) {
    this.pageSize = Math.max(1, options.pageSize ?? LIST_PAGE);
    this.root = options.root ?? UNLIM_ROOT;
  }

  async collect(): Promise<PhotosScanResult> {
    const startedAt = Date.now();
    this.db.setMeta('photos_started_at', new Date().toISOString());
    this.progress?.info(`Собираю каталог безлимитных фото (${this.root})`);

    const queue: string[] = [this.root];
    const visited = new Set<string>();
    let files = 0;
    let totalSize = 0;

    while (queue.length > 0) {
      const dir = queue.shift() as string;
      if (visited.has(dir)) continue;
      visited.add(dir);
      this.progress?.setActivity(`каталог ${dir}`);

      let offset = 0;
      for (;;) {
        const page = await this.client.listDir(dir, offset, this.pageSize);

        if (page.files.length > 0) {
          this.db.upsertPhotos(page.files.map(toPhotoUpsert));
          const bytes = page.files.reduce((sum, item) => sum + (item.size ?? 0), 0);
          files += page.files.length;
          totalSize += bytes;
          this.progress?.incItems(page.files.length);
          this.progress?.addBytes(bytes);
        }

        for (const sub of page.dirs) {
          if (!visited.has(sub)) queue.push(sub);
        }

        offset += page.children;
        if (page.children < this.pageSize) break;
      }
      this.log.debug(`Каталог ${dir}: обработано фото ${files}`);
    }

    this.progress?.clearActivity();

    // Отбрасываем всё, что не относится к безлимиту (старый сбор тащил фото
    // обычного Диска — их качает ветка files).
    const removed = this.db.dropPhotosOutside(this.root);
    if (removed > 0) {
      this.log.info(`Убрано из очереди безлимита фото вне ${this.root}: ${removed}`);
      this.progress?.info(
        `Убрано фото вне безлимита: ${removed} (они качаются в ветке обычных файлов)`,
      );
    }

    const summary = this.db.summarizePhotos();
    this.db.setMeta('photos_finished_at', new Date().toISOString());
    this.db.setMeta('photos_count', String(summary.total));
    this.db.setMeta('photos_total_size', String(summary.totalSize));

    this.progress?.info(`Каталог безлимита собран: фото ${summary.total}`);
    return {
      files,
      dirs: visited.size,
      totalSize,
      durationMs: Date.now() - startedAt,
    };
  }
}

function toPhotoUpsert(item: PhotoItem): PhotoUpsert {
  return {
    id: item.id,
    clusterId: null,
    name: item.name,
    size: item.size,
    md5: item.md5,
    mime: item.mime,
    takenAt: null,
    remoteRef: item.remoteRef,
  };
}
