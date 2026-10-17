import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type FetchLike, PhotosliceClient } from '../src/api/photosliceClient.js';
import { ConfigError, HttpError } from '../src/util/errors.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISK_HTML = '<html>{"sk":"SK-ab","uid":"12345"}</html>';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/client/disk')) return new Response(DISK_HTML, { status: 200 });
    return handler(url, init);
  };
}

test('PhotosliceClient: listDir парсит файлы, папки и метаданные', async () => {
  const client = new PhotosliceClient({
    cookies: [{ name: 'Session_id', value: 'x' }],
    fetchImpl: fakeFetch(() =>
      json([
        { type: 'dir', path: '/photounlim', name: 'photounlim' },
        {
          type: 'file',
          path: '/photounlim/a.jpg',
          name: 'a.jpg',
          meta: { size: '10', md5: 'm1', mimetype: 'image/jpeg' },
        },
        {
          type: 'file',
          path: '/photounlim/b.mp4',
          name: 'b.mp4',
          meta: { size: 20, etag: 'm2', type: 'video/mp4' },
        },
        { type: 'dir', path: '/photounlim/2017', name: '2017' },
        { type: 'file', path: '/trash/deleted.jpg', name: 'deleted.jpg' },
      ]),
    ),
  });

  const page = await client.listDir('/photounlim', 0, 100);
  assert.equal(page.children, 3);
  assert.deepEqual(page.dirs, ['/photounlim/2017']);
  assert.equal(page.files.length, 2);

  const a = page.files.find((item) => item.id === '/photounlim/a.jpg');
  assert.equal(a?.size, 10);
  assert.equal(a?.md5, 'm1');
  assert.equal(a?.mime, 'image/jpeg');
  assert.equal(a?.remoteRef, '/photounlim/a.jpg');

  const b = page.files.find((item) => item.id === '/photounlim/b.mp4');
  assert.equal(b?.size, 20);
  assert.equal(b?.md5, 'm2'); // fallback etag
  assert.equal(b?.mime, 'video/mp4'); // fallback type
});

test('PhotosliceClient: getFileUrl возвращает https-ссылку', async () => {
  const client = new PhotosliceClient({
    cookies: [{ name: 'Session_id', value: 'x' }],
    fetchImpl: fakeFetch(() =>
      json({ file: '//3.downloader.disk.yandex.ru/disk/abc', digest: 'https://x/digest' }),
    ),
  });

  const result = await client.getFileUrl('/photounlim/a.jpg');
  assert.equal(result.url, 'https://3.downloader.disk.yandex.ru/disk/abc');
});

test('PhotosliceClient: без sk/uid бросает ConfigError', async () => {
  const fake: FetchLike = async (input) => {
    if (String(input).includes('/client/disk'))
      return new Response('<html></html>', { status: 200 });
    return new Response('', { status: 404 });
  };
  const client = new PhotosliceClient({
    cookies: [{ name: 'x', value: 'y' }],
    fetchImpl: fake,
  });
  await assert.rejects(client.listDir(), ConfigError);
});

test('PhotosliceClient: 401 → обновление cookies и повтор', async () => {
  let modelsCalls = 0;
  let refreshes = 0;
  const fake: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes('/client/disk')) return new Response(DISK_HTML, { status: 200 });
    modelsCalls += 1;
    if (modelsCalls === 1) return new Response('{"error":"unauthorized"}', { status: 401 });
    return json({ file: 'https://x/file', digest: 'd' });
  };

  const client = new PhotosliceClient({
    cookies: [{ name: 'Session_id', value: 'old' }],
    fetchImpl: fake,
    onSessionExpired: async () => {
      refreshes += 1;
      return [{ name: 'Session_id', value: 'new' }];
    },
  });

  const result = await client.getFileUrl('/photounlim/a.jpg');
  assert.equal(result.url, 'https://x/file');
  assert.equal(refreshes, 1);
  assert.equal(modelsCalls, 2);
});

test('PhotosliceClient: 429 «Archive downloads are temporarily disabled» не повторяется', async () => {
  let modelsCalls = 0;
  const client = new PhotosliceClient({
    cookies: [{ name: 'Session_id', value: 'x' }],
    maxAttempts: 5,
    baseDelayMs: 1,
    fetchImpl: fakeFetch(() => {
      modelsCalls += 1;
      return new Response(
        JSON.stringify({
          error: {
            type: 'mpfs',
            statusCode: 429,
            code: 394,
            title: 'Archive downloads are temporarily disabled.',
          },
        }),
        { status: 429 },
      );
    }),
  });

  await assert.rejects(client.getFileUrl('/photounlim/a.jpg'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.match(error.message, /temporarily disabled/);
    return true;
  });
  assert.equal(modelsCalls, 1); // без бессмысленных повторов
});
