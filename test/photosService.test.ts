import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ListPage, PhotoItem, PhotosliceClient } from '../src/api/photosliceClient.js';
import { PhotosService } from '../src/scan/photosService.js';
import { StateDb } from '../src/state/db.js';
import type { Logger } from '../src/util/logger.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function item(id: string, size: number): PhotoItem {
  return {
    id,
    name: id.split('/').pop() as string,
    size,
    md5: `md5-${id}`,
    mime: 'image/jpeg',
    remoteRef: id,
  };
}

const pages: Record<string, Record<number, ListPage>> = {
  '/photounlim': {
    0: {
      files: [item('/photounlim/a.jpg', 1), item('/photounlim/b.jpg', 2)],
      dirs: [],
      children: 2,
    },
    2: {
      files: [item('/photounlim/c.jpg', 3)],
      dirs: ['/photounlim/sub'],
      children: 2,
    },
    4: { files: [], dirs: [], children: 0 },
  },
  '/photounlim/sub': {
    0: { files: [item('/photounlim/sub/d.jpg', 4)], dirs: [], children: 1 },
  },
};

function fakeClient(): PhotosliceClient {
  return {
    async listDir(path: string, offset: number): Promise<ListPage> {
      const page = pages[path]?.[offset];
      if (!page) throw new Error(`нет страницы ${path} offset=${offset}`);
      return page;
    },
  } as unknown as PhotosliceClient;
}

test('photos collect: постраничный обход, подпапки и идемпотентность', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-photos-'));
  const db = StateDb.open(join(dir, 'state.db'));
  try {
    const service = new PhotosService(fakeClient(), db, silent, { pageSize: 2 });

    // Хвост старого сбора: фото обычного Диска, не относящееся к безлимиту.
    db.upsertPhotos([
      {
        id: '/disk/other.jpg',
        clusterId: null,
        name: 'other.jpg',
        size: 99,
        md5: 'other',
        mime: null,
        takenAt: null,
        remoteRef: '/disk/other.jpg',
      },
    ]);

    const first = await service.collect();
    assert.equal(first.files, 4);
    assert.equal(first.dirs, 2);
    assert.equal(db.countPhotos(), 4);
    assert.equal(
      db.allPhotos().some((p) => p.id === '/disk/other.jpg'),
      false,
    );
    assert.deepEqual(db.summarizePhotos().byStatus, { pending: 4 });
    assert.equal(db.summarizePhotos().totalSize, 10);

    const photo = db.allPhotos().find((p) => p.id === '/photounlim/a.jpg');
    assert.equal(photo?.name, 'a.jpg');
    assert.equal(photo?.size, 1);
    assert.equal(photo?.md5, 'md5-/photounlim/a.jpg');

    const second = await service.collect();
    assert.equal(second.files, 4);
    assert.equal(db.countPhotos(), 4);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
