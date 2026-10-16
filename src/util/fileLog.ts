import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';

import { ensureDir } from './paths.js';

/** Простой append-лог в файл (для сохранения истории прогресса). */
export class FileLog {
  private readonly stream: WriteStream;

  constructor(dir: string, name: string) {
    ensureDir(dir);
    this.stream = createWriteStream(join(dir, name), { flags: 'a' });
  }

  write(line: string): void {
    this.stream.write(`${new Date().toISOString()} ${line}\n`);
  }

  close(): void {
    this.stream.end();
  }
}
