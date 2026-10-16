import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultConfig, loadConfig } from '../src/config/load.js';
import { validateConfig } from '../src/config/schema.js';
import { ConfigError } from '../src/util/errors.js';
import { resolveAppPaths } from '../src/util/paths.js';

const paths = resolveAppPaths('/proj/data');
const defaults = defaultConfig(paths, '/proj');
const noConfig = { configPath: '/tmp/yd-nonexistent-config.json' } as const;

test('validateConfig: без данных возвращает значения по умолчанию', () => {
  const config = validateConfig(undefined, defaults);
  assert.equal(config.downloadDir, '/proj/downloads');
  assert.equal(config.profile, 'normal');
  assert.deepEqual(config.rateLimit, defaults.rateLimit);
});

test('validateConfig: накладывает указанные поля поверх дефолтов', () => {
  const config = validateConfig(
    {
      downloadDir: '/mnt/backup',
      profile: 'gentle',
      rateLimit: { maxAttempts: 3 },
    },
    defaults,
  );
  assert.equal(config.downloadDir, '/mnt/backup');
  assert.equal(config.profile, 'gentle');
  assert.equal(config.rateLimit.maxAttempts, 3);
  assert.equal(config.rateLimit.baseDelayMs, defaults.rateLimit.baseDelayMs);
});

test('validateConfig: не мутирует defaults', () => {
  validateConfig({ downloadDir: '/other' }, defaults);
  assert.equal(defaults.downloadDir, '/proj/downloads');
});

test('validateConfig: читает concurrency', () => {
  const config = validateConfig({ concurrency: 12 }, defaults);
  assert.equal(config.concurrency, 12);
});

test('validateConfig: отклоняет неверный concurrency', () => {
  assert.throws(() => validateConfig({ concurrency: 0 }, defaults), ConfigError);
  assert.throws(() => validateConfig({ concurrency: '10' }, defaults), ConfigError);
});

test('validateConfig: отклоняет неверный профиль', () => {
  assert.throws(() => validateConfig({ profile: 'turbo' }, defaults), ConfigError);
});

test('validateConfig: maxDelayMs не может быть меньше baseDelayMs', () => {
  assert.throws(
    () => validateConfig({ rateLimit: { baseDelayMs: 5000, maxDelayMs: 1000 } }, defaults),
    ConfigError,
  );
});

test('validateConfig: собирает несколько ошибок в одном сообщении', () => {
  try {
    validateConfig({ profile: 'x', downloadDir: '' }, defaults);
    assert.fail('ожидалась ошибка');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /profile/);
    assert.match(error.message, /downloadDir/);
  }
});

test('validateConfig: отклоняет не-объект', () => {
  assert.throws(() => validateConfig('nope', defaults), ConfigError);
});

test('loadConfig: читает учётные данные OAuth из окружения', () => {
  const { config } = loadConfig({
    ...noConfig,
    env: { YD_OAUTH_CLIENT_ID: 'cid', YD_OAUTH_CLIENT_SECRET: 'sec', YD_PROFILE: 'fast' },
  });
  assert.equal(config.oauth.clientId, 'cid');
  assert.equal(config.oauth.clientSecret, 'sec');
  assert.equal(config.profile, 'fast');
});

test('loadConfig: без окружения креды пусты', () => {
  const { config } = loadConfig({ ...noConfig, env: {} });
  assert.equal(config.oauth.clientId, '');
  assert.equal(config.oauth.clientSecret, '');
});

test('loadConfig: приоритеты — CLI-флаг профиля выше env', () => {
  const { config } = loadConfig({
    ...noConfig,
    env: { YD_PROFILE: 'fast' },
    overrides: { profile: 'gentle' },
  });
  assert.equal(config.profile, 'gentle');
});
