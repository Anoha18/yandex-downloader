import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HttpClient } from '../src/api/httpClient.js';
import type { FileUrl, PhotosliceClient } from '../src/api/photosliceClient.js';
import { PhotoDownloader } from '../src/download/photoDownloader.js';
import type { PhotoJob } from '../src/state/db.js';

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

function job(id: string, name: string, md5Value: string, size: number): PhotoJob {
  return { id, name, size, md5: md5Value, remote_ref: id, attempts: 0 };
}

/** Клиент, который по ref отдаёт подписанную ссылку на скачивание. */
function fakeClient(content: Record<string, Buffer>): PhotosliceClient {
  return {
    async getFileUrl(ref: string): Promise<FileUrl> {
      const body = content[ref];
      if (!body) throw new Error(`нет контента для ${ref}`);
      return { url: `https://downloader.test/${encodeURIComponent(ref)}` };
    },
  } as unknown as PhotosliceClient;
}

test('PhotoDownloader: качает по одному, разрешает коллизии и дедуп по md5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-pd-'));
  try {
    const A = Buffer.from('AAAAAAAA');
    const B = Buffer.from('BBBBBBBB');
    writeFileSync(join(dir, 'a.jpg'), 'preexisting-different-content');

    const content = { '1': A, '2': B, '3': A };
    const fetchImpl: typeof fetch = async (input) => {
      const ref = decodeURIComponent(String(input).split('/').pop() ?? '');
      return new Response(content[ref as keyof typeof content]);
    };

    const http = new HttpClient('tok', { fetchImpl });
    const downloader = new PhotoDownloader(fakeClient(content), http, {
      photosDir: dir,
      seenMd5: new Set(),
    });

    const first = await downloader.downloadOne(job('1', 'a.jpg', md5(A), A.length));
    const second = await downloader.downloadOne(job('2', 'b.jpg', md5(B), B.length));
    const third = await downloader.downloadOne(job('3', 'c.jpg', md5(A), A.length));

    assert.equal(first.status, 'downloaded');
    assert.equal(second.status, 'downloaded');
    assert.equal(third.status, 'skipped'); // дедуп по md5

    // Коллизия имён разрешена суффиксом.
    assert.ok(existsSync(join(dir, 'a (1).jpg')));
    assert.ok(existsSync(join(dir, 'b.jpg')));
    // Чужой файл не затёрт.
    assert.equal(readFileSync(join(dir, 'a.jpg'), 'utf8'), 'preexisting-different-content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PhotoDownloader: уже скачанный файл пропускается без запроса к API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-pd-'));
  try {
    const A = Buffer.from('AAAAAAAA');
    writeFileSync(join(dir, 'a.jpg'), A);

    const client = {
      async getFileUrl(): Promise<FileUrl> {
        throw new Error('не должен вызываться');
      },
    } as unknown as PhotosliceClient;

    const http = new HttpClient('tok', {
      fetchImpl: async () => {
        throw new Error('не должен скачиваться');
      },
    });
    const downloader = new PhotoDownloader(client, http, { photosDir: dir });

    const result = await downloader.downloadOne(job('1', 'a.jpg', md5(A), A.length));
    assert.equal(result.status, 'skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PhotoDownloader: несовпадение md5 → failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-pd-'));
  try {
    const A = Buffer.from('AAAAAAAA');
    const content = { '1': A };
    const fetchImpl: typeof fetch = async () => new Response(A);
    const downloader = new PhotoDownloader(
      fakeClient(content),
      new HttpClient('tok', { fetchImpl }),
      {
        photosDir: dir,
      },
    );

    const result = await downloader.downloadOne(job('1', 'a.jpg', 'deadbeef', A.length));
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /md5/);
    assert.ok(!existsSync(join(dir, 'a.jpg')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
