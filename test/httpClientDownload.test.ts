import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HttpClient } from '../src/api/httpClient.js';

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

test('downloadToFile: пишет файл и считает md5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-dl-'));
  try {
    const dest = join(dir, 'f.bin');
    const data = Buffer.from('hello world');
    const http = new HttpClient('tok', { fetchImpl: async () => new Response(data) });
    const result = await http.downloadToFile('https://x/f', dest);
    assert.equal(result.bytes, data.length);
    assert.equal(result.md5, md5(data));
    assert.equal(readFileSync(dest, 'utf8'), 'hello world');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToFile: докачка по Range (206)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-dl-'));
  try {
    const dest = join(dir, 'f.bin');
    const prefix = Buffer.from('hello ');
    const rest = Buffer.from('world');
    writeFileSync(dest, prefix);
    const full = Buffer.concat([prefix, rest]);

    let sentRange = '';
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentRange = headers.Range ?? '';
      return new Response(rest, { status: 206 });
    };
    const result = await new HttpClient('tok', { fetchImpl }).downloadToFile('https://x/f', dest, {
      rangeFrom: prefix.length,
    });

    assert.equal(sentRange, `bytes=${prefix.length}-`);
    assert.equal(readFileSync(dest, 'utf8'), 'hello world');
    assert.equal(result.md5, md5(full));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToFile: 200 при Range → перезапись с нуля', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-dl-'));
  try {
    const dest = join(dir, 'f.bin');
    writeFileSync(dest, Buffer.from('OLD-PART'));
    const full = Buffer.from('FRESH');
    const http = new HttpClient('tok', {
      fetchImpl: async () => new Response(full, { status: 200 }),
    });
    const result = await http.downloadToFile('https://x/f', dest, { rangeFrom: 5 });
    assert.equal(readFileSync(dest, 'utf8'), 'FRESH');
    assert.equal(result.md5, md5(full));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToFile: обрыв потока не роняет процесс, промис отклоняется', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-dl-'));
  try {
    const dest = join(dir, 'f.bin');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new Error('boom'));
      },
    });
    const http = new HttpClient('tok', { fetchImpl: async () => new Response(stream) });
    await assert.rejects(http.downloadToFile('https://x/f', dest));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
