import { type Dirent, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { resolveLocalPath } from '../download/localPath.js';
import { StateDb } from '../state/db.js';
import { humanBytes } from '../util/format.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function collectParts(dir: string, out: Set<string>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectParts(full, out);
    else if (entry.isFile() && entry.name.endsWith('.part')) out.add(full);
  }
}

/**
 * `yd cleanup` — уборка частичных загрузок `.part`.
 *
 *   --parts       удалить только «осиротевшие» и устаревшие `.part` (по умолчанию);
 *   --all-parts   удалить все `.part` (кроме файлов, которые так и называются);
 *   --path <dir>  ограничить поддеревом;
 *   --dry-run     только показать, ничего не удалять.
 */
export const runCleanup: CommandRunner = async (
  { options }: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const allParts = options['all-parts'] === true;
  const dryRun = options['dry-run'] === true;
  const customPath =
    typeof options.path === 'string' && options.path.length > 0 ? options.path : undefined;

  const db = StateDb.open(ctx.config.statePath);
  try {
    const downloadDir = resolve(ctx.config.downloadDir);
    const photosDir = resolve(ctx.config.photosDir);

    // Локальные пути, которые заняты реальными файлами, и пути, которые ещё
    // будут докачаны (их `.part` трогать нельзя).
    const downloadedLocal = new Set<string>();
    const resumableLocal = new Set<string>();
    const resumableNames = new Set<string>();

    for (const file of db.filesForCleanup()) {
      const local = file.local_path
        ? resolve(file.local_path)
        : resolveLocalPath(downloadDir, file.path);
      if (file.status === 'downloaded' || file.status === 'skipped') {
        downloadedLocal.add(local);
      } else if (
        file.status === 'pending' ||
        file.status === 'in_progress' ||
        file.status === 'failed'
      ) {
        resumableLocal.add(local);
        resumableNames.add(basename(local));
      }
    }
    for (const photo of db.downloadedPhotos()) {
      if (photo.local_path) downloadedLocal.add(resolve(photo.local_path));
    }

    const roots = customPath ? [resolve(customPath)] : [downloadDir, photosDir];
    const parts = new Set<string>();
    for (const root of roots) collectParts(root, parts);

    let deleted = 0;
    let kept = 0;
    let freed = 0;
    const examples: string[] = [];

    for (const partPath of parts) {
      // Файл, который на Диске реально называется `*.part` — не трогаем.
      if (downloadedLocal.has(partPath)) {
        kept += 1;
        continue;
      }

      const finalPath = partPath.slice(0, -'.part'.length);
      const resumable = resumableLocal.has(finalPath) || resumableNames.has(basename(finalPath));

      let shouldDelete: boolean;
      if (allParts) shouldDelete = true;
      else if (existsSync(finalPath))
        shouldDelete = true; // финал уже есть — хвост stale
      else if (resumable)
        shouldDelete = false; // докачается через --retry-failed
      else shouldDelete = true; // осиротевший

      if (!shouldDelete) {
        kept += 1;
        continue;
      }

      freed += statSize(partPath);
      if (!dryRun) rmSync(partPath, { force: true });
      deleted += 1;
      if (examples.length < 5) examples.push(partPath);
    }

    const lines = [
      dryRun ? 'Очистка .part (dry-run):' : 'Очистка .part:',
      `Удалено: ${deleted} (${humanBytes(freed)})`,
      `Оставлено на докачку: ${kept}`,
    ];
    if (examples.length > 0) {
      lines.push('Примеры:');
      for (const path of examples) lines.push(`  ${path}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    db.close();
  }
};
