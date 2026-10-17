import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DiskApi } from '../src/api/diskApi.js';
import { HttpClient } from '../src/api/httpClient.js';
import type { PhotosliceClient } from '../src/api/photosliceClient.js';
import {
  type DownloadContext,
  type DownloadOptions,
  DownloadService,
} from '../src/download/downloadService.js';
import { StateDb } from '../src/state/db.js';
import { HttpError } from '../src/util/errors.js';
import type { Logger } from '../src/util/logger.js';
import { ProgressReporter } from '../src/util/progress.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
const progress = new ProgressReporter('test', { quiet: true });

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'yd-ds-'));
  const db = StateDb.open(join(dir, 'state.db'));
  const a = Buffer.from('AAAAA');
  const b = Buffer.from('BBBBB');
  db.upsertFiles([
    { path: 'disk:/a.txt', size: a.length, md5: md5(a), mime: null },
    { path: 'disk:/b.txt', size: b.length, md5: md5(b), mime: null },
  ]);

  const fetchImpl: typeof fetch = async (url) =>
    new Response(String(url).endsWith('a.txt') ? a : b);
  const http = new HttpClient('tok', { fetchImpl });
  const api = {
    async getDownloadUrl(path: string) {
      return `https://x/${path.split('/').pop()}`;
    },
  } as unknown as DiskApi;
  const ctx: DownloadContext = {
    api,
    http,
    downloadDir: join(dir, 'out'),
    photosDir: join(dir, 'photos'),
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
  };
  return { dir, db, ctx };
}

function options(overrides: Partial<DownloadOptions> = {}): DownloadOptions {
  return {
    files: true,
    photos: false,
    concurrency: 2,
    retryFailed: false,
    recheck: false,
    dryRun: false,
    ...overrides,
  };
}

test('DownloadService: скачивает файлы и ставит статусы', async () => {
  const { dir, db, ctx } = setup();
  try {
    const stats = await new DownloadService(db, silent, options(), ctx, progress).run();
    assert.equal(stats.filesDownloaded, 2);
    assert.deepEqual(db.countByStatus(), { downloaded: 2 });
    assert.ok(existsSync(join(ctx.downloadDir, 'a.txt')));
    assert.ok(existsSync(join(ctx.downloadDir, 'b.txt')));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DownloadService: --limit ограничивает число файлов', async () => {
  const { dir, db, ctx } = setup();
  try {
    const stats = await new DownloadService(
      db,
      silent,
      options({ concurrency: 1, limit: 1 }),
      ctx,
      progress,
    ).run();
    assert.equal(stats.filesDownloaded, 1);
    assert.equal(db.countByStatus().pending, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DownloadService: dry-run ничего не скачивает', async () => {
  const { dir, db, ctx } = setup();
  try {
    const stats = await new DownloadService(
      db,
      silent,
      options({ dryRun: true }),
      ctx,
      progress,
    ).run();
    assert.equal(stats.filesDownloaded, 0);
    assert.deepEqual(db.countByStatus(), { pending: 2 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DownloadService: провал сразу помечает failed и не плодит дубли .part', async () => {
  const { dir, db, ctx } = setup();
  try {
    const fetchImpl: typeof fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error('обрыв'));
        },
      });
      return new Response(stream, { status: 200 });
    };
    ctx.http = new HttpClient('tok', { fetchImpl });

    const stats = await new DownloadService(
      db,
      silent,
      options({ concurrency: 1 }),
      ctx,
      progress,
    ).run();

    assert.equal(stats.filesFailed, 2);
    assert.deepEqual(db.countByStatus(), { failed: 2 });

    // Ровно по одному `.part` на файл и без суффиксов «(1)», «(2)»…
    const parts = readdirSync(ctx.downloadDir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.part'))
      .sort();
    assert.deepEqual(parts, ['a.txt.part', 'b.txt.part']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DownloadService: переносит фото из старой папки в текущий photosDir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-ds-'));
  const db = StateDb.open(join(dir, 'state.db'));
  try {
    const oldDir = join(dir, 'old');
    mkdirSync(oldDir, { recursive: true });
    const content = Buffer.from('photo');
    const oldPath = join(oldDir, 'p.jpg');
    writeFileSync(oldPath, content);

    db.upsertPhotos([
      {
        id: '/photounlim/p.jpg',
        clusterId: null,
        name: 'p.jpg',
        size: content.length,
        md5: md5(content),
        mime: 'image/jpeg',
        takenAt: null,
        remoteRef: '/photounlim/p.jpg',
      },
    ]);
    db.markPhotoDownloaded('/photounlim/p.jpg', oldPath, md5(content), content.length);

    const photosClient = {
      async getFileUrl() {
        throw new Error('не должен вызываться');
      },
    } as unknown as PhotosliceClient;
    const ctx: DownloadContext = {
      api: {} as DiskApi,
      http: new HttpClient('tok'),
      photosClient,
      downloadDir: join(dir, 'out'),
      photosDir: join(dir, 'photos'),
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
    };

    await new DownloadService(
      db,
      silent,
      options({ files: false, photos: true, concurrency: 1 }),
      ctx,
      progress,
    ).run();

    const photo = db.downloadedPhotos()[0];
    assert.equal(photo?.local_path, join(dir, 'photos', 'p.jpg'));
    assert.ok(existsSync(join(dir, 'photos', 'p.jpg')));
    assert.ok(!existsSync(oldPath));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function insertPhoto(db: StateDb, id: string, name: string, size: number): void {
  db.upsertPhotos([
    {
      id,
      clusterId: null,
      name,
      size,
      md5: 'm',
      mime: null,
      takenAt: null,
      remoteRef: id,
    },
  ]);
}

function photoCtx(dir: string, photosClient: PhotosliceClient): DownloadContext {
  return {
    api: {} as DiskApi,
    http: new HttpClient('tok'),
    photosClient,
    downloadDir: join(dir, 'out'),
    photosDir: join(dir, 'photos'),
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
  };
}

test('DownloadService: ошибка хранилища помечает фото failed (добор через --retry-failed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-ds-'));
  const db = StateDb.open(join(dir, 'state.db'));
  try {
    insertPhoto(db, '/photounlim/p.jpg', 'p.jpg', 3);
    const photosClient = {
      async getFileUrl(): Promise<never> {
        throw new HttpError(500, 'download: HTTP 500');
      },
    } as unknown as PhotosliceClient;

    const stats = await new DownloadService(
      db,
      silent,
      options({ files: false, photos: true, concurrency: 1, limit: 1 }),
      photoCtx(dir, photosClient),
      progress,
    ).run();

    assert.equal(stats.photosFailed, 1);
    assert.deepEqual(db.summarizePhotos().byStatus, { failed: 1 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DownloadService: 429 откладывает фото, не сжигая попытку', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-ds-'));
  const db = StateDb.open(join(dir, 'state.db'));
  try {
    insertPhoto(db, '/photounlim/p.jpg', 'p.jpg', 3);
    const photosClient = {
      async getFileUrl(): Promise<never> {
        throw new HttpError(429, 'photoslice: HTTP 429');
      },
    } as unknown as PhotosliceClient;

    const stats = await new DownloadService(
      db,
      silent,
      options({ files: false, photos: true, concurrency: 1, limit: 1 }),
      photoCtx(dir, photosClient),
      progress,
    ).run();

    assert.equal(stats.photosFailed, 0);
    assert.deepEqual(db.summarizePhotos().byStatus, { pending: 1 });
    assert.equal(db.claimPendingPhotos(1).length, 0); // отложено
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
