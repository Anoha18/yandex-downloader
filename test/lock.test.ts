import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { UsageError } from '../src/util/errors.js';
import { acquireLock } from '../src/util/lock.js';

test('lock: второй захват падает, после освобождения — снова можно', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-lock-'));
  const path = join(dir, 'download.lock');
  try {
    const release = acquireLock(path);
    assert.ok(existsSync(path));
    assert.throws(() => acquireLock(path), UsageError);
    release();
    assert.ok(!existsSync(path));

    const release2 = acquireLock(path);
    release2();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: устаревший лок (битый pid) перезаписывается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-lock-'));
  const path = join(dir, 'download.lock');
  try {
    writeFileSync(path, 'not-a-pid');
    const release = acquireLock(path);
    assert.ok(existsSync(path));
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
