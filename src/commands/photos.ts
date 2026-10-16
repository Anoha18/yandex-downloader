import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PhotosService } from '../scan/photosService.js';
import { StateDb } from '../state/db.js';
import { UsageError } from '../util/errors.js';
import { humanBytes } from '../util/format.js';
import { getLogger } from '../util/logger.js';
import { ensureDir } from '../util/paths.js';
import { createPhotosliceClient, ensureCookies } from './photosCookies.js';
import { createProgress } from './progressFactory.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

/**
 * `yd photos <collect | auth | status | export>`
 *
 *   collect — собрать каталог безлимитного фото-хранилища в БД (cookies подтянутся сами);
 *   auth    — только получить/обновить cookies через браузер;
 *   status  — показать сводку по собранным фото;
 *   export  — выгрузить список фото в JSON.
 */
export const runPhotos: CommandRunner = async (
  input: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const sub = input.args[0] ?? 'collect';
  switch (sub) {
    case 'auth':
      return authOnly(ctx, input.options);
    case 'collect':
      return collect(ctx, input.options);
    case 'status':
      return status(ctx);
    case 'export':
      return exportPhotos(ctx, input.args[1]);
    default:
      throw new UsageError(
        `Неизвестная подкоманда photos: «${sub}». Доступно: collect, auth, status, export`,
      );
  }
};

async function authOnly(ctx: CommandContext, options: Record<string, unknown>): Promise<number> {
  process.stdout.write('Обновляю cookies через браузер…\n');
  const cookies = await ensureCookies(ctx, { ...options, refresh: true });
  process.stdout.write(
    `✓ Cookies обновлены: получено ${cookies.length} → ${ctx.config.cookiesPath}\n`,
  );
  return 0;
}

async function collect(ctx: CommandContext, options: Record<string, unknown>): Promise<number> {
  const log = getLogger();
  const { reporter, stop } = createProgress(ctx, 'photos', { label: 'photos', rateMode: 'items' });
  try {
    const cookies = await ensureCookies(ctx, options);
    const client = createPhotosliceClient(ctx, cookies, () =>
      ensureCookies(ctx, { ...options, refresh: true }),
    );

    const db = StateDb.open(ctx.config.statePath);
    try {
      const service = new PhotosService(client, db, log, {}, reporter);
      const result = await service.collect();
      const lines = [
        '',
        'Каталог безлимитных фото собран.',
        `Кластеров (дней): ${result.clusters}`,
        `Фото: ${result.photos} (${humanBytes(result.totalSize)})`,
        `Длительность: ${(result.durationMs / 1000).toFixed(1)} с`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    } finally {
      db.close();
    }
  } finally {
    stop();
  }
}

async function status(ctx: CommandContext): Promise<number> {
  const db = StateDb.open(ctx.config.statePath);
  try {
    const summary = db.summarizePhotos();
    const meta = db.getAllMeta();
    const lines = [
      `Фото в каталоге: ${summary.total}`,
      `Общий размер: ${humanBytes(summary.totalSize)}`,
    ];
    for (const [name, count] of Object.entries(summary.byStatus)) {
      lines.push(`  ${name.padEnd(12)} ${count}`);
    }
    if (meta.photos_finished_at) lines.push(`Последний сбор: ${meta.photos_finished_at}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function exportPhotos(ctx: CommandContext, file: string | undefined): Promise<number> {
  if (!file) throw new UsageError('Укажите файл: yd photos export <file>');
  const db = StateDb.open(ctx.config.statePath);
  try {
    const photos = db.allPhotos();
    ensureDir(dirname(file));
    writeFileSync(file, `${JSON.stringify(photos, null, 2)}\n`, 'utf8');
    process.stdout.write(`Выгружено фото: ${photos.length} → ${file}\n`);
    return 0;
  } finally {
    db.close();
  }
}
