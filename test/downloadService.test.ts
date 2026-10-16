import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DiskApi } from '../src/api/diskApi.js';
import { HttpClient } from '../src/api/httpClient.js';
import {
  type DownloadContext,
  type DownloadOptions,
  DownloadService,
} from '../src/download/downloadService.js';
import { StateDb } from '../src/state/db.js';
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
