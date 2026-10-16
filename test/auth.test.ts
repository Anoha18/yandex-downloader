import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  type FetchLike,
  isConfirmationCode,
} from '../src/auth/oauth.js';
import { getAccessToken, toTokenData } from '../src/auth/tokenManager.js';
import { TokenStore } from '../src/auth/tokenStore.js';
import { ConfigError, HttpError } from '../src/util/errors.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('buildAuthorizeUrl: содержит нужные параметры', () => {
  const url = buildAuthorizeUrl('CID');
  assert.match(url, /^https:\/\/oauth\.yandex\.ru\/authorize\?/);
  assert.match(url, /response_type=code/);
  assert.match(url, /client_id=CID/);
  assert.match(url, /force_confirm=yes/);
});

test('isConfirmationCode: принимает 7 цифр и буквенно-цифровой код', () => {
  assert.equal(isConfirmationCode('1234567'), true);
  assert.equal(isConfirmationCode(' 1234567 '), true);
  assert.equal(isConfirmationCode('czlns3tvcfnsgbmp'), true);
  assert.equal(isConfirmationCode('abc'), false);
  assert.equal(isConfirmationCode(''), false);
  assert.equal(isConfirmationCode('   '), false);
  assert.equal(isConfirmationCode('has space'), false);
  assert.equal(isConfirmationCode('a'.repeat(300)), false);
});

test('exchangeCodeForToken: отправляет код и разбирает ответ', async () => {
  let capturedBody = '';
  const fake: FetchLike = async (_input, init) => {
    capturedBody = String(init?.body ?? '');
    return jsonResponse(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  };

  const result = await exchangeCodeForToken(
    { clientId: 'cid', clientSecret: 'sec' },
    '1234567',
    fake,
  );

  assert.equal(result.access_token, 'AT');
  assert.equal(result.refresh_token, 'RT');
  assert.match(capturedBody, /grant_type=authorization_code/);
  assert.match(capturedBody, /code=1234567/);
  assert.match(capturedBody, /client_id=cid/);
  assert.match(capturedBody, /client_secret=sec/);
});

test('exchangeCodeForToken: ошибка сервера -> HttpError', async () => {
  const fake: FetchLike = async () =>
    jsonResponse(400, { error: 'bad_verification_code', error_description: 'Неверный код' });

  await assert.rejects(
    exchangeCodeForToken({ clientId: 'cid', clientSecret: 'sec' }, '0000000', fake),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Неверный код/);
      return true;
    },
  );
});

test('toTokenData: вычисляет expiresAt из expires_in', () => {
  const before = Date.now();
  const data = toTokenData({ access_token: 'AT', expires_in: 3600, refresh_token: 'RT' });
  assert.equal(data.accessToken, 'AT');
  assert.equal(data.refreshToken, 'RT');
  assert.ok(data.expiresAt !== undefined);
  assert.ok(data.expiresAt >= before + 3_600_000 - 1000);
});

test('getAccessToken: нет токена -> ConfigError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-token-'));
  try {
    const store = new TokenStore(join(dir, 'token.json'));
    await assert.rejects(
      getAccessToken(store, { clientId: 'cid', clientSecret: 'sec' }),
      ConfigError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getAccessToken: действующий токен возвращается без обновления', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-token-'));
  try {
    const store = new TokenStore(join(dir, 'token.json'));
    store.save({ accessToken: 'valid', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 });
    const result = await getAccessToken(store, { clientId: 'cid', clientSecret: 'sec' });
    assert.equal(result.accessToken, 'valid');
    assert.equal(result.refreshed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getAccessToken: истёкший токен обновляется и сохраняется', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-token-'));
  try {
    const store = new TokenStore(join(dir, 'token.json'));
    store.save({ accessToken: 'old', refreshToken: 'RT', expiresAt: Date.now() - 1000 });

    const fake: FetchLike = async (_input, init) => {
      assert.match(String(init?.body ?? ''), /grant_type=refresh_token/);
      return jsonResponse(200, { access_token: 'new', expires_in: 3600 });
    };

    const result = await getAccessToken(store, { clientId: 'cid', clientSecret: 'sec' }, fake);
    assert.equal(result.accessToken, 'new');
    assert.equal(result.refreshed, true);
    assert.equal(store.load()?.accessToken, 'new');
    // старый refresh_token сохранён, т.к. сервер не вернул новый
    assert.equal(store.load()?.refreshToken, 'RT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
