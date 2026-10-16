import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiskApi } from '../src/api/diskApi.js';
import type { HttpClient, RequestOptions } from '../src/api/httpClient.js';

interface FakeItem {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

/** Фейковый HTTP-клиент с пагинацией по pageSize. */
function fakeHttp(all: FakeItem[], pageSize = 2): { http: HttpClient; offsets: number[] } {
  const offsets: number[] = [];
  const http = {
    async getJson(_path: string, options: RequestOptions = {}) {
      const offset = Number(options.query?.offset ?? 0);
      offsets.push(offset);
      const limit = Number(options.query?.limit ?? pageSize);
      const items = all.slice(offset, offset + Math.min(limit, pageSize));
      return { _embedded: { items, total: all.length, limit, offset } };
    },
  } as unknown as HttpClient;
  return { http, offsets };
}

test('DiskApi.listDir: собирает все страницы', async () => {
  const all: FakeItem[] = [
    { path: 'disk:/a', name: 'a', type: 'file' },
    { path: 'disk:/b', name: 'b', type: 'file' },
    { path: 'disk:/c', name: 'c', type: 'file' },
  ];
  const { http, offsets } = fakeHttp(all);
  const items = await new DiskApi(http).listDir('/');
  assert.equal(items.length, 3);
  assert.deepEqual(offsets, [0, 2]);
});

test('DiskApi.listDir: пустая папка', async () => {
  const { http } = fakeHttp([]);
  const items = await new DiskApi(http).listDir('/empty');
  assert.equal(items.length, 0);
});

test('DiskApi.iterateAllFiles: страницы до короткой, без потерь', async () => {
  const all: FakeItem[] = Array.from({ length: 5 }, (_, i) => ({
    path: `disk:/f${i}`,
    name: `f${i}`,
    type: 'file' as const,
  }));
  let calls = 0;
  const http = {
    async getJson(_path: string, options: RequestOptions = {}) {
      calls += 1;
      const offset = Number(options.query?.offset ?? 0);
      const limit = Number(options.query?.limit ?? 2);
      const items = all.slice(offset, offset + limit);
      return { items, limit, offset };
    },
  } as unknown as HttpClient;

  const collected: string[] = [];
  for await (const page of new DiskApi(http).iterateAllFiles(2)) {
    for (const item of page) collected.push(item.path);
  }
  assert.equal(collected.length, 5);
  assert.equal(calls, 3); // 2 + 2 + 1
});

test('DiskApi.listFilesPage: возвращает страницу и effectiveLimit', async () => {
  const all: FakeItem[] = [
    { path: 'disk:/a', name: 'a', type: 'file' },
    { path: 'disk:/b', name: 'b', type: 'file' },
    { path: 'disk:/c', name: 'c', type: 'file' },
  ];
  const http = {
    async getJson(_path: string, options: RequestOptions = {}) {
      const offset = Number(options.query?.offset ?? 0);
      const limit = Number(options.query?.limit ?? 2);
      return { items: all.slice(offset, offset + limit), limit, offset };
    },
  } as unknown as HttpClient;

  const page = await new DiskApi(http).listFilesPage(0, 2);
  assert.equal(page.items.length, 2);
  assert.equal(page.effectiveLimit, 2);
});
