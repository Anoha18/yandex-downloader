import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type FetchLike, PhotosliceClient } from '../src/api/photosliceClient.js';
import { ConfigError } from '../src/util/errors.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISK_HTML = '<html>{"sk":"SK-ab","uid":"12345"}</html>';

function fakeFetch(): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/client/disk')) return new Response(DISK_HTML, { status: 200 });
    if (url.includes('photo-init-snapshot')) return json({ photoslice_id: 'PS-1' });
    if (url.includes('photo-get-snapshot')) {
      return json({
        items: [
          { id: 'c1', size: 2 },
          { id: 'c2', size: 1 },
        ],
      });
    }
    if (url.includes('photo-get-clusters-with-resources')) {
      const body = JSON.parse(String(init?.body)) as {
        requestParams: { clusters: Record<string, unknown> };
      };
      const ids = Object.keys(body.requestParams.clusters);
      const fetched = ids.map((id) => ({
        id,
        items:
          id === 'c1'
            ? [
                { id: 'f1', name: 'a.jpg', size: 10, md5: 'm1', mimetype: 'image/jpeg' },
                { id: 'f2', name: 'b.jpg', size: 20, etag: 'm2', type: 'image/jpeg' },
              ]
            : [{ id: 'f3', name: 'c.mp4', size: 30 }],
      }));
      return json({ clusters: { fetched } });
    }
    return new Response('not found', { status: 404 });
  };
}

test('PhotosliceClient: initSnapshot / getSnapshot / getClustersWithResources', async () => {
  const client = new PhotosliceClient({
    cookies: [{ name: 'Session_id', value: 'x' }],
    fetchImpl: fakeFetch(),
  });

  const psid = await client.initSnapshot();
  assert.equal(psid, 'PS-1');

  const clusters = await client.getSnapshot(psid);
  assert.deepEqual(clusters, [
    { id: 'c1', size: 2 },
    { id: 'c2', size: 1 },
  ]);

  const items = await client.getClustersWithResources(psid, clusters);
  assert.equal(items.length, 3);
  assert.equal(items.find((i) => i.id === 'f1')?.mime, 'image/jpeg');
  const f2 = items.find((i) => i.id === 'f2');
  assert.equal(f2?.md5, 'm2'); // fallback etag
  assert.equal(f2?.mime, 'image/jpeg'); // fallback type
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
  await assert.rejects(client.initSnapshot(), ConfigError);
});

test('PhotosliceClient: 401 → обновление cookies и повтор', async () => {
  let modelsCalls = 0;
  let refreshes = 0;
  const fake: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes('/client/disk')) return new Response(DISK_HTML, { status: 200 });
    modelsCalls += 1;
    if (modelsCalls === 1) return new Response('{"error":"unauthorized"}', { status: 401 });
    return json({ photoslice_id: 'PS-REFRESHED' });
  };

  const client = new PhotosliceClient({
    cookies: [{ name: 'Session_id', value: 'old' }],
    fetchImpl: fake,
    onSessionExpired: async () => {
      refreshes += 1;
      return [{ name: 'Session_id', value: 'new' }];
    },
  });

  const psid = await client.initSnapshot();
  assert.equal(psid, 'PS-REFRESHED');
  assert.equal(refreshes, 1);
  assert.equal(modelsCalls, 2);
});
