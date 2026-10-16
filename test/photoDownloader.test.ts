import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import yazl from 'yazl';

import { HttpClient } from '../src/api/httpClient.js';
import type { PhotosliceClient } from '../src/api/photosliceClient.js';
import { PhotoDownloader } from '../src/download/photoDownloader.js';
import type { PhotoJob } from '../src/state/db.js';

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

function makeZip(entries: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) zip.addBuffer(entry.content, entry.name);
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.end();
  });
}

function job(id: string, name: string, md5Value: string, size: number): PhotoJob {
  return { id, name, size, md5: md5Value, remote_ref: id };
}

test('PhotoDownloader: распаковка, коллизии, дедуп, защита от traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yd-pd-'));
  try {
    const A = Buffer.from('AAAAAAAA');
    const B = Buffer.from('BBBBBBBB');
    writeFileSync(join(dir, 'a.jpg'), 'preexisting-different-content');

    const zip = await makeZip([
      { name: 'a.jpg', content: A },
      { name: 'sub/b.jpg', content: B },
      { name: 'c.jpg', content: A }, // дубликат по md5 с a.jpg
      { name: 'xx/evil.txt', content: Buffer.from('EVIL') }, // потом подменим на ../evil.txt
    ]);
    // yazl не пропускает «../», подменяем имя в байтах ZIP на ту же длину
    const patched = Buffer.from(
      zip.toString('latin1').replace('xx/evil.txt', '../evil.txt'),
      'latin1',
    );

    const http = new HttpClient('tok', { fetchImpl: async () => new Response(patched) });
    const client = {
      async bulkDownloadPrepare() {
        return 'https://x/bulk.zip';
      },
    } as unknown as PhotosliceClient;

    const downloader = new PhotoDownloader(client, http, { photosDir: dir });
    const jobs = [
      job('1', 'a.jpg', md5(A), A.length),
      job('2', 'b.jpg', md5(B), B.length),
      job('3', 'c.jpg', md5(A), A.length),
    ];

    const results = await downloader.downloadBatch(jobs);
    const byId = new Map(results.map((result) => [result.id, result]));

    assert.equal(byId.get('1')?.status, 'downloaded');
    assert.equal(byId.get('2')?.status, 'downloaded');
    assert.equal(byId.get('3')?.status, 'skipped'); // дедуп по md5

    // коллизия имён разрешена суффиксом
    assert.ok(existsSync(join(dir, 'a (1).jpg')));
    assert.ok(existsSync(join(dir, 'b.jpg')));
    // запись с попыткой выхода за папку проигнорирована
    assert.ok(!existsSync(join(dir, '..', 'evil.txt')));
    assert.ok(!existsSync(join(dir, 'evil.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
