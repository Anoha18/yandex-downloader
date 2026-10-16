import { StateDb } from '../state/db.js';
import { humanBytes } from '../util/format.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

/** `yd stats` — сводка по очереди из локальной БД (без обращения к API). */
export const runStats: CommandRunner = async (
  _input: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const db = StateDb.open(ctx.config.statePath);
  try {
    const summary = db.summarize();
    const meta = db.getAllMeta();

    const lines: string[] = [];
    lines.push(`Файлов в очереди: ${summary.total}`);
    lines.push(`Общий размер: ${humanBytes(summary.totalSize)}`);

    const statuses: string[] = [];
    for (const status of ['pending', 'in_progress', 'downloaded', 'skipped', 'failed', 'missing']) {
      const count = summary.byStatus[status];
      if (count) {
        const size = summary.byStatusSize[status] ?? 0;
        statuses.push(`  ${status.padEnd(12)} ${String(count).padStart(8)}  ${humanBytes(size)}`);
      }
    }
    if (statuses.length > 0) {
      lines.push('По статусам:', ...statuses);
    }

    if (meta.scan_finished_at) {
      lines.push(
        `Последний скан: ${meta.scan_finished_at} (режим: ${meta.scan_mode ?? '—'}, корень: ${meta.scan_root ?? '/'})`,
      );
    }

    const photos = db.summarizePhotos();
    if (photos.total > 0 || meta.photos_finished_at) {
      lines.push('', `Фото (безлимит): ${photos.total} (${humanBytes(photos.totalSize)})`);
      for (const [name, count] of Object.entries(photos.byStatus)) {
        lines.push(`  ${name.padEnd(12)} ${String(count).padStart(8)}`);
      }
      if (meta.photos_finished_at) lines.push(`Последний сбор фото: ${meta.photos_finished_at}`);
    }

    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    db.close();
  }
};
