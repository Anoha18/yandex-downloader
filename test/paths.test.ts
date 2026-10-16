import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureDir, findProjectRoot, resolveAppPaths } from '../src/util/paths.js';

test('resolveAppPaths: файлы лежат внутри базового каталога', () => {
  const paths = resolveAppPaths('/data/app');
  assert.equal(paths.baseDir, '/data/app');
  assert.equal(paths.configFile, '/data/app/config.json');
  assert.equal(paths.tokenFile, '/data/app/token.json');
  assert.equal(paths.stateDb, '/data/app/state.db');
  assert.equal(paths.logDir, '/data/app/logs');
});

test('findProjectRoot: находит корень проекта (где лежит package.json)', () => {
  const root = findProjectRoot();
  assert.ok(existsSync(join(root, 'package.json')));
  assert.equal(findProjectRoot(join(root, 'src', 'util')), root);
});

test('ensureDir: создаёт вложенные каталоги', () => {
  const base = mkdtempSync(join(tmpdir(), 'yd-paths-'));
  try {
    const target = join(base, 'a', 'b', 'c');
    ensureDir(target);
    assert.ok(existsSync(target));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
