import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCleanup } from '../src/commands/cleanup.js';
import type { CommandContext } from '../src/commands/types.js';
import { StateDb } from '../src/state/db.js';

function ctxFor(dir: string): CommandContext {
  const statePath = join(dir, 'state.db');
  return {
    config: {
      downloadDir: join(dir, 'downloads'),
      photosDir: join(dir, 'downloads', '_unlimited_photos'),
      oauth: { clientId: '', clientSecret: '' },
      tokenPath: join(dir, 'token.json'),
      statePath,
      cookiesPath: join(dir, 'cookies.json'),
      browserProfileDir: join(dir, 'browser'),
      logDir: join(dir, 'logs'),
      profile: 'normal',
      rateLimit: { maxAttempts: 7, baseDelayMs: 1, maxDelayMs: 2, cooldownMs: 0 },
    },
    paths: {
      baseDir: dir,
      configFile: join(dir, 'config.json'),
      tokenFile: join(dir, 'token.json'),
      stateDb: statePath,
      cookiesFile: join(dir, 'cookies.json'),
      browserProfileDir: join(dir, 'browser'),
      logDir: join(dir, 'logs'),
    },
    projectRoot: dir,
    configPath: join(dir, 'config.json'),
    configFileExists: false,
    flags: { verbose: false, quiet: true, noBrowser: true },
  };
}

function setup(): { dir: string; ctx: CommandContext; downloads: string } {
  const dir = mkdtempSync(join(tmpdir(), 'yd-clean-'));
  const ctx = ctxFor(dir);
  const downloads = ctx.config.downloadDir;
  mkdirSync(downloads, { recursive: true });

  const db = StateDb.open(ctx.config.statePath);
  try {
    // pending-файл: его .part — на докачку
    db.upsertFiles([{ path: 'disk:/b.txt', size: 10, md5: null, mime: null }]);
    // скачанный файл, который на Диске реально называется *.part
    db.upsertFiles([{ path: 'disk:/real.part', size: 1, md5: null, mime: null }]);
    const realPath = join(downloads, 'real.part');
    writeFileSync(realPath, 'R');
    db.markFileDownloaded('disk:/real.part', realPath);
  } finally {
    db.close();
  }
  return { dir, ctx, downloads };
}

test('cleanup: удаляет stale и осиротевшие .part, оставляет докачку и реальные файлы', async () => {
  const { dir, ctx, downloads } = setup();
  try {
    writeFileSync(join(downloads, 'a.txt'), 'A');
    writeFileSync(join(downloads, 'a.txt.part'), 'partial'); // stale: финал есть
    writeFileSync(join(downloads, 'b.txt.part'), 'partial'); // resumable: pending
    writeFileSync(join(downloads, 'c.txt.part'), 'partial'); // orphan

    const code = await runCleanup({ args: [], options: {} }, ctx);
    assert.equal(code, 0);

    assert.ok(!existsSync(join(downloads, 'a.txt.part')), 'stale удалён');
    assert.ok(existsSync(join(downloads, 'b.txt.part')), 'resumable оставлен');
    assert.ok(!existsSync(join(downloads, 'c.txt.part')), 'orphan удалён');
    assert.ok(existsSync(join(downloads, 'real.part')), 'реальный *.part не тронут');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup: --all-parts удаляет всё, кроме реальных *.part', async () => {
  const { dir, ctx, downloads } = setup();
  try {
    writeFileSync(join(downloads, 'b.txt.part'), 'partial');

    const code = await runCleanup({ args: [], options: { 'all-parts': true } }, ctx);
    assert.equal(code, 0);

    assert.ok(!existsSync(join(downloads, 'b.txt.part')));
    assert.ok(existsSync(join(downloads, 'real.part')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup: --dry-run ничего не удаляет', async () => {
  const { dir, ctx, downloads } = setup();
  try {
    writeFileSync(join(downloads, 'c.txt.part'), 'partial');

    await runCleanup({ args: [], options: { 'dry-run': true } }, ctx);
    assert.ok(existsSync(join(downloads, 'c.txt.part')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
