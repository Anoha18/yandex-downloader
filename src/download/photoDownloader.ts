import { createWriteStream, existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import yauzl from 'yauzl';

import type { HttpClient } from '../api/httpClient.js';
import type { PhotosliceClient } from '../api/photosliceClient.js';
import type { PhotoJob } from '../state/db.js';
import { md5File } from '../util/hash.js';
import { ensureDir } from '../util/paths.js';
import { sanitizeSegment, withSuffix } from './localPath.js';

export interface PhotoDownloadResult {
  id: string;
  status: 'downloaded' | 'skipped' | 'failed';
  localPath?: string;
  error?: string;
}

export interface PhotoDownloaderOptions {
  photosDir: string;
  tempDir?: string;
  /** Множество md5 уже скачанных фото (для дедупликации). */
  seenMd5?: Set<string>;
}

/**
 * Скачивание фото безлимитного хранилища пачками через bulk ZIP.
 *
 * Готовит ZIP для пачки (`mpfs/bulk-download-prepare`), скачивает его и
 * потоково распаковывает в плоскую папку с защитой zip-slip, разрешением
 * коллизий имён и дедупликацией по md5.
 */
export class PhotoDownloader {
  constructor(
    private readonly client: PhotosliceClient,
    private readonly http: HttpClient,
    private readonly options: PhotoDownloaderOptions,
  ) {}

  async downloadBatch(jobs: PhotoJob[]): Promise<PhotoDownloadResult[]> {
    if (jobs.length === 0) return [];
    const refs = jobs.map((job) => job.remote_ref ?? job.id);
    const url = await this.client.bulkDownloadPrepare(refs);

    const tempDir = this.options.tempDir ?? this.options.photosDir;
    ensureDir(tempDir);
    const zipPath = join(tempDir, `.bulk-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);

    try {
      await this.http.downloadToFile(url, zipPath, {});
      return await this.extract(zipPath, jobs);
    } finally {
      rmSync(zipPath, { force: true });
    }
  }

  private extract(zipPath: string, jobs: PhotoJob[]): Promise<PhotoDownloadResult[]> {
    const byName = new Map<string, PhotoJob>();
    for (const job of jobs) {
      if (job.name) byName.set(basename(job.name), job);
    }
    const seen = this.options.seenMd5 ?? new Set<string>();
    const results = new Map<string, PhotoDownloadResult>();

    return new Promise<PhotoDownloadResult[]>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
        if (err || !zipfile) {
          reject(err ?? new Error('не удалось открыть ZIP'));
          return;
        }

        zipfile.on('error', reject);
        zipfile.on('end', () => {
          for (const job of jobs) {
            if (!results.has(job.id)) {
              results.set(job.id, { id: job.id, status: 'failed', error: 'не найден в архиве' });
            }
          }
          resolve([...results.values()]);
        });

        zipfile.on('entry', (entry) => {
          if (entry.fileName.endsWith('/')) {
            zipfile.readEntry();
            return;
          }
          const base = basename(entry.fileName);
          const job = byName.get(base);
          if (!job) {
            // Запись без соответствующего фото (или попытка выхода за папку) — пропускаем.
            zipfile.readEntry();
            return;
          }
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              if (job) {
                results.set(job.id, {
                  id: job.id,
                  status: 'failed',
                  error: streamErr?.message ?? 'ошибка чтения записи',
                });
              }
              zipfile.readEntry();
              return;
            }

            const tmp = join(
              this.options.tempDir ?? this.options.photosDir,
              `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            );
            ensureDir(dirname(tmp));
            const out = createWriteStream(tmp);
            stream.on('error', (error) => {
              rmSync(tmp, { force: true });
              if (job) results.set(job.id, { id: job.id, status: 'failed', error: error.message });
              zipfile.readEntry();
            });
            stream.pipe(out);
            out.on('error', (error) => {
              rmSync(tmp, { force: true });
              if (job) results.set(job.id, { id: job.id, status: 'failed', error: error.message });
              zipfile.readEntry();
            });
            out.on('finish', () => {
              void finalizeEntry(this.options.photosDir, tmp, base, job, seen, results).finally(
                () => zipfile.readEntry(),
              );
            });
          });
        });

        zipfile.readEntry();
      });
    });
  }
}

async function finalizeEntry(
  photosDir: string,
  tmp: string,
  base: string,
  job: PhotoJob | undefined,
  seen: Set<string>,
  results: Map<string, PhotoDownloadResult>,
): Promise<void> {
  try {
    const md5 = await md5File(tmp);
    if (job?.md5 && md5 !== job.md5) {
      rmSync(tmp, { force: true });
      results.set(job.id, { id: job.id, status: 'failed', error: `несовпадение md5: ${md5}` });
      return;
    }
    if (seen.has(md5)) {
      rmSync(tmp, { force: true });
      if (job) results.set(job.id, { id: job.id, status: 'skipped' });
      return;
    }

    const dest = uniqueName(photosDir, sanitizeSegment(base));
    renameSync(tmp, dest);
    seen.add(md5);
    if (job) results.set(job.id, { id: job.id, status: 'downloaded', localPath: dest });
  } catch (error) {
    rmSync(tmp, { force: true });
    if (job) results.set(job.id, { id: job.id, status: 'failed', error: (error as Error).message });
  }
}

function uniqueName(dir: string, name: string): string {
  let candidate = join(dir, name);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = withSuffix(join(dir, name), counter++);
  }
  return candidate;
}
