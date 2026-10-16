import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  cookiesExpired,
  hasSessionCookie,
  loadCookies,
  normalizeCookies,
  saveCookies,
} from '../src/auth/cookies.js';

test('normalizeCookies: массив и объект', () => {
  const fromArray = normalizeCookies([
    { name: 'a', value: '1', domain: '.yandex.ru' },
    { name: 'b', value: '2' },
  ]);
  assert.equal(fromArray.length, 2);
  assert.equal(fromArray[0]?.name, 'a');
  assert.equal(fromArray[0]?.domain, '.yandex.ru');

  const fromObject = normalizeCookies({ x: '1', y: '2', bad: 3, skip: null });
  assert.deepEqual(fromObject, [
    { name: 'x', value: '1' },
    { name: 'y', value: '2' },
  ]);

  assert.deepEqual(normalizeCookies(null), []);
});

test('hasSessionCookie: распознаёт сессионные имена', () => {
  assert.equal(hasSessionCookie([{ name: 'Session_id', value: 'x' }]), true);
  assert.equal(hasSessionCookie([{ name: 'yandexuid', value: 'x' }]), false);
});

test('save/load cookies: круговой прогон и права 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-cookie-'));
  try {
    const file = join(dir, 'cookies.json');
    saveCookies(file, [{ name: 'Session_id', value: 'secret' }]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const loaded = loadCookies(file);
    assert.equal(loaded?.[0]?.value, 'secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCookies: отсутствующий файл → null', () => {
  assert.equal(loadCookies('/tmp/yd-missing-cookies-file.json'), null);
});

test('cookiesExpired: срок, session-cookie и отсутствие сессии', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 3600;

  // Нет сессионных cookies → считаем просроченными
  assert.equal(cookiesExpired([{ name: 'yandexuid', value: 'x', expires: future }]), true);
  // Сессионная cookie без срока (-1) → валидна
  assert.equal(cookiesExpired([{ name: 'Session_id', value: 'x', expires: -1 }]), false);
  // Срок в будущем → валидна
  assert.equal(cookiesExpired([{ name: 'Session_id', value: 'x', expires: future }]), false);
  // Срок в прошлом → просрочена
  assert.equal(cookiesExpired([{ name: 'Session_id', value: 'x', expires: past }]), true);
  // Одна валидная из нескольких → не просрочена
  assert.equal(
    cookiesExpired([
      { name: 'Session_id', value: 'x', expires: past },
      { name: 'sessionid', value: 'y', expires: future },
    ]),
    false,
  );
});
