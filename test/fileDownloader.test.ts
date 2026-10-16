import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DiskApi } from '../src/api/diskApi.js';
import { HttpClient, STORAGE_TIMEOUT_MESSAGE } from '../src/api/httpClient.js';
import { FileDownloader, type FileRetryInfo } from '../src/download/fileDownloader.js';
import { HttpError } from '../src/util/errors.js';

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

function fakeApi(href = 'https://x/file'): DiskApi {
  return {
    async getDownloadUrl() {
      return href;
    },
  } as unknown as DiskApi;
}

function options(downloadDir: string) {
  return { downloadDir, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };
}

test('FileDownloader: скачивает и проверяет md5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-fd-'));
  try {
    const data = Buffer.from('contents-123');
    const http = new HttpClient('tok', { fetchImpl: async () => new Response(data) });
    const downloader = new FileDownloader(fakeApi(), http, options(dir));
    const result = await downloader.download({
      path: 'disk:/a/b.txt',
      size: data.length,
      md5: md5(data),
      local_path: null,
    });
    assert.equal(result.status, 'downloaded');
    assert.equal(result.localPath, join(dir, 'a', 'b.txt'));
    assert.ok(existsSync(join(dir, 'a', 'b.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileDownloader: существующий корректный файл → skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-fd-'));
  try {
    const data = Buffer.from('same');
    const http = new HttpClient('tok', { fetchImpl: async () => new Response(data) });
    const downloader = new FileDownloader(fakeApi(), http, options(dir));
    await downloader.download({
      path: 'disk:/a.txt',
      size: data.length,
      md5: md5(data),
      local_path: null,
    });
    const second = await downloader.download({
      path: 'disk:/a.txt',
      size: data.length,
      md5: md5(data),
      local_path: join(dir, 'a.txt'),
    });
    assert.equal(second.status, 'skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileDownloader: сообщает о повторе (onRetry)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-fd-'));
  try {
    const data = Buffer.from('ok');
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls < 2) {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return new Response(data);
    };
    const http = new HttpClient('tok', { fetchImpl });
    const retries: FileRetryInfo[] = [];
    const downloader = new FileDownloader(fakeApi(), http, {
      downloadDir: dir,
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      onRetry: (info) => retries.push(info),
    });
    const result = await downloader.download({
      path: 'disk:/a.txt',
      size: data.length,
      md5: md5(data),
      local_path: null,
    });
    assert.equal(result.status, 'downloaded');
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.reason, 'таймаут соединения');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileDownloader: недоступный backend — быстрый пропуск (2 попытки)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-fd-'));
  try {
    let calls = 0;
    const http = {
      async downloadToFile() {
        calls += 1;
        throw new HttpError(0, STORAGE_TIMEOUT_MESSAGE);
      },
    } as unknown as HttpClient;
    const retries: FileRetryInfo[] = [];
    const downloader = new FileDownloader(fakeApi(), http, {
      downloadDir: dir,
      maxAttempts: 7,
      baseDelayMs: 1,
      maxDelayMs: 2,
      storageMaxAttempts: 2,
      onRetry: (info) => retries.push(info),
    });
    const result = await downloader.download({
      path: 'disk:/a.txt',
      size: null,
      md5: null,
      local_path: null,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.storageUnavailable, true);
    assert.equal(calls, 2);
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.reason, STORAGE_TIMEOUT_MESSAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileDownloader: 4xx не повторяется (fatal)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-fd-'));
  try {
    let calls = 0;
    const http = {
      async downloadToFile() {
        calls += 1;
        throw new HttpError(404, 'download: HTTP 404');
      },
    } as unknown as HttpClient;
    const retries: FileRetryInfo[] = [];
    const downloader = new FileDownloader(fakeApi(), http, {
      downloadDir: dir,
      maxAttempts: 7,
      baseDelayMs: 1,
      maxDelayMs: 2,
      onRetry: (info) => retries.push(info),
    });
    const result = await downloader.download({
      path: 'disk:/a.txt',
      size: null,
      md5: null,
      local_path: null,
    });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(retries.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileDownloader: сетевой обрыв — не более 3 быстрых попыток', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-fd-'));
  try {
    let calls = 0;
    const http = {
      async downloadToFile() {
        calls += 1;
        throw new Error('terminated');
      },
    } as unknown as HttpClient;
    const retries: FileRetryInfo[] = [];
    const downloader = new FileDownloader(fakeApi(), http, {
      downloadDir: dir,
      maxAttempts: 7,
      baseDelayMs: 1,
      maxDelayMs: 2,
      onRetry: (info) => retries.push(info),
    });
    const result = await downloader.download({
      path: 'disk:/a.txt',
      size: null,
      md5: null,
      local_path: null,
    });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 3);
    assert.equal(retries.length, 2);
    assert.equal(retries[0]?.maxAttempts, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileDownloader: несовпадение md5 → failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-fd-'));
  try {
    const data = Buffer.from('xx');
    const http = new HttpClient('tok', { fetchImpl: async () => new Response(data) });
    const downloader = new FileDownloader(fakeApi(), http, options(dir));
    const result = await downloader.download({
      path: 'disk:/a.txt',
      size: data.length,
      md5: 'deadbeef',
      local_path: null,
    });
    assert.equal(result.status, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
