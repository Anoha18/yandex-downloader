import type { PhotosliceClient } from '../api/photosliceClient.js';
import type { PhotoUpsert, StateDb } from '../state/db.js';
import type { Logger } from '../util/logger.js';
import type { ProgressReporter } from '../util/progress.js';

export interface PhotosScanOptions {
  /** Сколько кластеров запрашивать за один вызов. */
  batchSize?: number;
}

export interface PhotosScanResult {
  clusters: number;
  photos: number;
  totalSize: number;
  durationMs: number;
}

/** Сбор каталога безлимитного фото-хранилища (photoslice) в БД. */
export class PhotosService {
  private readonly batchSize: number;

  constructor(
    private readonly client: PhotosliceClient,
    private readonly db: StateDb,
    private readonly log: Logger,
    options: PhotosScanOptions = {},
    private readonly progress?: ProgressReporter,
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? 15);
  }

  async collect(): Promise<PhotosScanResult> {
    const startedAt = Date.now();
    this.db.setMeta('photos_started_at', new Date().toISOString());
    this.progress?.info('Начинаю сбор каталога безлимитных фото');

    const snapshotId = await this.client.initSnapshot();
    this.db.setMeta('photos_snapshot', snapshotId);

    const clusters = await this.client.getSnapshot(snapshotId);
    this.progress?.info(`Кластеров (дней): ${clusters.length}`);
    this.db.upsertPhotoClusters(clusters);
    this.progress?.setTotals({ items: clusters.length });

    let fetched = 0;
    for (;;) {
      const batch = this.db.nextUnfetchedClusters(this.batchSize);
      if (batch.length === 0) break;
      this.progress?.setActivity(`архив кластеров (${batch.length})`);

      const items = await this.client.getClustersWithResources(snapshotId, batch);
      this.db.upsertPhotos(items.map(toPhotoUpsert));
      this.db.markClustersFetched(batch.map((cluster) => cluster.id));

      fetched += items.length;
      this.progress?.incItems(batch.length);
      this.progress?.addBytes(items.reduce((sum, item) => sum + (item.size ?? 0), 0));
      this.log.debug(`Обработано фото: ${fetched}`);
    }

    this.progress?.clearActivity();
    const summary = this.db.summarizePhotos();
    this.db.setMeta('photos_finished_at', new Date().toISOString());
    this.db.setMeta('photos_count', String(summary.total));
    this.db.setMeta('photos_total_size', String(summary.totalSize));

    this.progress?.info(`Каталог безлимита собран: фото ${summary.total}`);
    return {
      clusters: clusters.length,
      photos: summary.total,
      totalSize: summary.totalSize,
      durationMs: Date.now() - startedAt,
    };
  }
}

function toPhotoUpsert(item: {
  id: string;
  clusterId: string;
  name: string | null;
  size: number | null;
  md5: string | null;
  mime: string | null;
  takenAt: string | null;
  remoteRef: string;
}): PhotoUpsert {
  return {
    id: item.id,
    clusterId: item.clusterId,
    name: item.name,
    size: item.size,
    md5: item.md5,
    mime: item.mime,
    takenAt: item.takenAt,
    remoteRef: item.remoteRef,
  };
}
