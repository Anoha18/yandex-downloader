import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpClient } from '../src/api/httpClient.js';
import { HttpError } from '../src/util/errors.js';
import type { RateLimiter } from '../src/util/rateLimiter.js';

const fastLimit = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, cooldownMs: 0 };

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('getJson: повторяет запрос при 429 и возвращает результат', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    return jsonResponse(200, { ok: true });
  };
  const client = new HttpClient('token', { fetchImpl, rateLimit: fastLimit });
  const data = await client.getJson<{ ok: boolean }>('/disk');
  assert.equal(data.ok, true);
  assert.equal(calls, 2);
});

test('getJson: повторяет сетевую ошибку', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls < 3) throw new Error('ECONNRESET');
    return jsonResponse(200, { ok: true });
  };
  const client = new HttpClient('token', {
    fetchImpl,
    rateLimit: { ...fastLimit, maxAttempts: 5 },
  });
  const data = await client.getJson<{ ok: boolean }>('/disk');
  assert.equal(data.ok, true);
  assert.equal(calls, 3);
});

test('getJson: 404 не повторяется и бросает HttpError', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(404, { message: 'Путь не найден' });
  };
  const client = new HttpClient('token', { fetchImpl, rateLimit: fastLimit });
  await assert.rejects(client.getJson('/disk'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.match(error.message, /Путь не найден/);
    return true;
  });
  assert.equal(calls, 1);
});

test('getJson: исчерпание попыток при 500 -> HttpError', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(500, { message: 'boom' });
  };
  const client = new HttpClient('token', {
    fetchImpl,
    rateLimit: { ...fastLimit, maxAttempts: 2 },
  });
  await assert.rejects(client.getJson('/disk'), HttpError);
  assert.equal(calls, 2);
});

test('getJson: вызывает limiter.acquire перед запросом', async () => {
  let acquired = 0;
  const limiter = {
    acquire: async () => {
      acquired += 1;
    },
  } as unknown as RateLimiter;
  const fetchImpl: typeof fetch = async () => jsonResponse(200, { ok: true });
  const client = new HttpClient('token', { fetchImpl, limiter });
  await client.getJson('/disk');
  assert.equal(acquired, 1);
});
