import type { Hash } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Считает md5 файла потоково. */
export function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Докармливает существующий файл в хэш (для докачки). */
export function hashFileInto(hash: Hash, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
  });
}

export function createMd5(): Hash {
  return createHash('md5');
}
