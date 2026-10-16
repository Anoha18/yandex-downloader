import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DiskApi, DiskInfo, DiskResource } from '../src/api/diskApi.js';
import { ScanService } from '../src/scan/scanService.js';
import { buildTree } from '../src/scan/tree.js';
import { StateDb } from '../src/state/db.js';
import type { Logger } from '../src/util/logger.js';

const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

const diskInfo: DiskInfo = { total_space: 1000, used_space: 500, trash_size: 0 };

function file(path: string, size: number, md5?: string): DiskResource {
  return { path, name: path.split('/').pop() ?? path, type: 'file', size, md5 };
}

function dir(path: string): DiskResource {
  return { path, name: path.split('/').pop() ?? path, type: 'dir' };
}

function withDb(fn: (db: StateDb) => Promise<void> | void): Promise<void> | void {
  const tempDir = mkdtempSync(join(tmpdir(), 'yd-scan-'));
  const db = StateDb.open(join(tempDir, 'state.db'));
  const finish = (): void => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    const result = fn(db);
    if (result instanceof Promise) return result.finally(finish);
    finish();
    return undefined;
  } catch (error) {
    finish();
    throw error;
  }
}

/** Фейковый API с постраничным плоским списком. */
function fakeFlatApi(all: DiskResource[]): DiskApi {
  return {
    async listFilesPage(offset: number, limit: number) {
      return { items: all.slice(offset, offset + limit), effectiveLimit: limit };
    },
    async getDiskInfo() {
      return diskInfo;
    },
  } as unknown as DiskApi;
}

function fakeDeepApi(dirMap: Record<string, DiskResource[]>): DiskApi {
  return {
    async listDir(path: string) {
      return dirMap[path] ?? [];
    },
    async getDiskInfo() {
      return diskInfo;
    },
  } as unknown as DiskApi;
}

test('flat scan: наполняет очередь и пишет метаданные', async () =>
  withDb(async (db) => {
    const api = fakeFlatApi([
      file('disk:/a.txt', 10, 'm1'),
      file('disk:/b.txt', 20, 'm2'),
      file('disk:/Корзина/c.txt', 30),
    ]);
    const service = new ScanService(api, db, silentLogger);
    const result = await service.run({});

    assert.equal(result.mode, 'flat');
    assert.equal(result.files, 2); // файл из Корзины пропущен
    assert.equal(result.totalSize, 30);
    assert.equal(db.totalFiles(), 2);
    assert.equal(db.getMeta('scan_mode'), 'flat');
    assert.equal(db.getMeta('disk_used_space'), '500');
  }));

test('flat scan: конкурентный режим собирает все страницы без потерь', async () =>
  withDb(async (db) => {
    const all = Array.from({ length: 5 }, (_, i) => file(`disk:/f${i}.txt`, i + 1, `m${i}`));
    const api = fakeFlatApi(all);
    const service = new ScanService(api, db, silentLogger, { concurrency: 3, pageLimit: 2 });
    const result = await service.run({});
    assert.equal(result.files, 5);
    assert.equal(db.totalFiles(), 5);
    assert.equal(db.getMeta('scan_concurrency'), '3');
  }));

test('flat scan: повторный скан не сбрасывает скачанное', async () =>
  withDb(async (db) => {
    const api = fakeFlatApi([file('disk:/a.txt', 10, 'm1')]);
    const service = new ScanService(api, db, silentLogger);
    await service.run({});
    db.setFileStatus('disk:/a.txt', 'downloaded');
    await service.run({});
    assert.deepEqual(db.countByStatus(), { downloaded: 1 });
  }));

test('deep scan: обходит подпапки и собирает файлы', async () =>
  withDb(async (db) => {
    const api = fakeDeepApi({
      'disk:/': [dir('disk:/docs'), file('disk:/root.txt', 5, 'r')],
      'disk:/docs': [dir('disk:/docs/nested'), file('disk:/docs/inner.txt', 7, 'i')],
      'disk:/docs/nested': [],
    });
    const service = new ScanService(api, db, silentLogger);
    const result = await service.run({ deep: true });

    assert.equal(result.mode, 'deep');
    assert.equal(result.files, 2);
    assert.equal(result.dirs, 2);
    assert.equal(db.totalFiles(), 2);
    assert.equal(db.pendingDirCount(), 0);
  }));

test('deep scan: конкурентный обход', async () =>
  withDb(async (db) => {
    const api = fakeDeepApi({
      'disk:/': [dir('disk:/a'), dir('disk:/b'), dir('disk:/c')],
      'disk:/a': [file('disk:/a/1.txt', 1)],
      'disk:/b': [file('disk:/b/1.txt', 1)],
      'disk:/c': [file('disk:/c/1.txt', 1)],
    });
    const service = new ScanService(api, db, silentLogger, { concurrency: 3 });
    const result = await service.run({ deep: true });
    assert.equal(result.files, 3);
    assert.equal(result.dirs, 3);
    assert.equal(db.pendingDirCount(), 0);
  }));

test('buildTree: строит вложенное дерево из путей', () => {
  const tree = buildTree([
    { path: 'disk:/foo/a.txt', size: 1, md5: 'a' },
    { path: 'disk:/foo/bar/b.txt', size: 2, md5: 'b' },
  ]);
  assert.equal(tree.type, 'dir');
  const foo = tree.children?.find((child) => child.name === 'foo');
  assert.ok(foo);
  assert.equal(foo.type, 'dir');
  const bar = foo.children?.find((child) => child.name === 'bar');
  assert.ok(bar);
  assert.equal(bar.children?.[0]?.name, 'b.txt');
});
