import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { StateDb } from '../src/state/db.js';

function withDb(fn: (db: StateDb) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'yd-db-'));
  const db = StateDb.open(join(dir, 'state.db'));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upsertFiles: новые файлы добавляются как pending', () =>
  withDb((db) => {
    db.upsertFiles([{ path: 'disk:/a.txt', size: 10, md5: 'm1', mime: 'text/plain' }]);
    assert.equal(db.totalFiles(), 1);
    assert.deepEqual(db.countByStatus(), { pending: 1 });
  }));

test('upsertFiles: неизменённый скачанный файл сохраняет статус', () =>
  withDb((db) => {
    db.upsertFiles([{ path: 'disk:/a.txt', size: 10, md5: 'm1', mime: null }]);
    db.setFileStatus('disk:/a.txt', 'downloaded');
    db.upsertFiles([{ path: 'disk:/a.txt', size: 10, md5: 'm1', mime: null }]);
    assert.deepEqual(db.countByStatus(), { downloaded: 1 });
  }));

test('upsertFiles: изменившийся файл сбрасывается в pending', () =>
  withDb((db) => {
    db.upsertFiles([{ path: 'disk:/a.txt', size: 10, md5: 'm1', mime: null }]);
    db.setFileStatus('disk:/a.txt', 'downloaded');
    db.upsertFiles([{ path: 'disk:/a.txt', size: 20, md5: 'm2', mime: null }]);
    assert.deepEqual(db.countByStatus(), { pending: 1 });
  }));

test('summarize: считает файлы и размер по статусам', () =>
  withDb((db) => {
    db.upsertFiles([
      { path: 'disk:/a', size: 100, md5: '1', mime: null },
      { path: 'disk:/b', size: 200, md5: '2', mime: null },
    ]);
    db.setFileStatus('disk:/a', 'downloaded');
    const summary = db.summarize();
    assert.equal(summary.total, 2);
    assert.equal(summary.totalSize, 300);
    assert.equal(summary.byStatus.downloaded, 1);
    assert.equal(summary.byStatus.pending, 1);
    assert.equal(summary.byStatusSize.downloaded, 100);
  }));

test('claimPendingFiles: крупные файлы выдаются первыми', () =>
  withDb((db) => {
    db.upsertFiles([
      { path: 'disk:/small', size: 10, md5: '1', mime: null },
      { path: 'disk:/big', size: 5000, md5: '2', mime: null },
      { path: 'disk:/mid', size: 100, md5: '3', mime: null },
    ]);
    const jobs = db.claimPendingFiles(2);
    assert.deepEqual(
      jobs.map((job) => job.path),
      ['disk:/big', 'disk:/mid'],
    );
  }));

test('meta: запись и чтение', () =>
  withDb((db) => {
    db.setMeta('scan_mode', 'flat');
    db.setMeta('scan_mode', 'deep');
    assert.equal(db.getMeta('scan_mode'), 'deep');
    assert.equal(db.getMeta('missing'), null);
    assert.deepEqual(db.getAllMeta(), { scan_mode: 'deep' });
  }));

test('dirs: очередь папок и статусы', () =>
  withDb((db) => {
    db.upsertDirs([
      { path: 'disk:/', parent: null },
      { path: 'disk:/a', parent: 'disk:/' },
    ]);
    db.upsertDirs([{ path: 'disk:/a', parent: 'disk:/' }]); // дубликат игнорируется
    assert.equal(db.pendingDirCount(), 2);
    const next = db.nextPendingDirs(1);
    assert.equal(next.length, 1);
    db.markDirScanned(next[0] as string);
    assert.equal(db.pendingDirCount(), 1);
    db.markDirFailed('disk:/a', 'boom');
    assert.equal(db.pendingDirCount(), 0);
  }));

test('dirs: claimPendingDirs помечает in_progress и не выдаёт дважды', () =>
  withDb((db) => {
    db.upsertDirs([
      { path: 'disk:/', parent: null },
      { path: 'disk:/a', parent: 'disk:/' },
    ]);
    assert.equal(db.claimPendingDirs(2).length, 2);
    assert.equal(db.claimPendingDirs(2).length, 0);
    assert.equal(db.resetDirsInProgress(), 2);
    assert.equal(db.pendingDirCount(), 2);
  }));

test('photos: кластеры, upsert и сводка', () =>
  withDb((db) => {
    db.upsertPhotoClusters([{ id: 'c1', size: 1 }]);
    assert.equal(db.nextUnfetchedClusters(10).length, 1);
    db.markClustersFetched(['c1']);
    assert.equal(db.nextUnfetchedClusters(10).length, 0);

    const photo = {
      id: 'p1',
      clusterId: 'c1',
      name: 'a.jpg',
      size: 5,
      md5: 'm',
      mime: 'image/jpeg',
      takenAt: null,
      remoteRef: 'p1',
    };
    db.upsertPhotos([photo, photo]);
    assert.equal(db.countPhotos(), 1);
    assert.equal(db.summarizePhotos().totalSize, 5);

    db.setPhotoStatus('p1', 'downloaded');
    assert.deepEqual(db.summarizePhotos().byStatus, { downloaded: 1 });
  }));

test('photos: markPhotoDeferred откладывает без времени и не сжигает попытку', () =>
  withDb((db) => {
    db.upsertPhotos([
      {
        id: 'p1',
        clusterId: null,
        name: 'a.jpg',
        size: 5,
        md5: 'm',
        mime: null,
        takenAt: null,
        remoteRef: 'p1',
      },
    ]);

    db.markPhotoDeferred('p1', 'HTTP 429', 60);
    assert.equal(db.claimPendingPhotos(1).length, 0); // ещё не время
    assert.deepEqual(db.summarizePhotos().byStatus, { pending: 1 });
  }));
