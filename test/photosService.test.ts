import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { PhotoCluster, PhotosliceClient } from '../src/api/photosliceClient.js';
import { PhotosService } from '../src/scan/photosService.js';
import { StateDb } from '../src/state/db.js';
import type { Logger } from '../src/util/logger.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function fakeClient(): PhotosliceClient {
  return {
    async initSnapshot() {
      return 'PS';
    },
    async getSnapshot() {
      return [
        { id: 'c1', size: 2 },
        { id: 'c2', size: 1 },
      ];
    },
    async getClustersWithResources(_psid: string, clusters: PhotoCluster[]) {
      const out = [];
      for (const cluster of clusters) {
        for (let i = 0; i < cluster.size; i++) {
          const id = `${cluster.id}-f${i}`;
          out.push({
            id,
            clusterId: cluster.id,
            name: `${id}.jpg`,
            size: 10,
            md5: `m-${id}`,
            mime: 'image/jpeg',
            takenAt: null,
            remoteRef: id,
          });
        }
      }
      return out;
    },
  } as unknown as PhotosliceClient;
}

test('photos collect: наполняет каталог; повторный сбор идемпотентен', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-photos-'));
  const db = StateDb.open(join(dir, 'state.db'));
  try {
    const service = new PhotosService(fakeClient(), db, silent, { batchSize: 1 });
    const first = await service.collect();
    assert.equal(first.photos, 3);
    assert.equal(db.countPhotos(), 3);
    assert.equal(db.nextUnfetchedClusters(10).length, 0);

    const second = await service.collect();
    assert.equal(second.photos, 3);
    assert.equal(db.countPhotos(), 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
