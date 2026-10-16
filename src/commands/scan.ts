import { PROFILE_PRESETS } from '../config/schema.js';
import { ScanService } from '../scan/scanService.js';
import { StateDb } from '../state/db.js';
import { UsageError } from '../util/errors.js';
import { humanBytes } from '../util/format.js';
import { getLogger } from '../util/logger.js';
import { createDiskApi } from './helpers.js';
import { createProgress } from './progressFactory.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveConcurrency(raw: unknown, profileDefault: number): number {
  if (raw === undefined) return profileDefault;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new UsageError('--concurrency: ожидается целое число 1..64');
  }
  return value;
}

/**
 * `yd scan` — обход Диска и наполнение очереди.
 *
 *   --deep               рекурсивный обход (полное дерево, включая пустые папки)
 *   --path <dir>         ограничить поддеревом
 *   --export <file>      выгрузить дерево в JSON
 *   --concurrency <n>    число одновременных запросов (по умолчанию из профиля)
 */
export const runScan: CommandRunner = async (
  { options }: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const deep = options.deep === true;
  const path = optionalString(options.path);
  const exportFile = optionalString(options.export);
  const concurrency = resolveConcurrency(
    options.concurrency,
    ctx.config.concurrency ?? PROFILE_PRESETS[ctx.config.profile].concurrency,
  );

  if (path !== undefined && !path.startsWith('/') && !path.startsWith('disk:')) {
    throw new UsageError('--path: путь должен начинаться с «/» (например, /Документы).');
  }

  const log = getLogger();
  const { reporter, stop } = createProgress(ctx, 'scan', { label: 'scan', rateMode: 'items' });

  try {
    const { api } = await createDiskApi(ctx);
    const db = StateDb.open(ctx.config.statePath);
    try {
      const service = new ScanService(api, db, log, { concurrency }, reporter);
      const result = await service.run({ deep, path, export: exportFile });

      const summary = db.summarize();
      const lines = [
        '',
        `Скан завершён (режим: ${result.mode === 'deep' ? 'рекурсивный' : 'плоский'}, воркеров: ${concurrency}).`,
        `Найдено файлов: ${result.files} (${humanBytes(result.totalSize)})`,
        result.mode === 'deep' ? `Найдено папок: ${result.dirs}` : undefined,
        `В очереди всего: ${summary.total} (${humanBytes(summary.totalSize)})`,
        `По статусам: ${formatStatuses(summary.byStatus)}`,
        `Длительность: ${(result.durationMs / 1000).toFixed(1)} с`,
      ].filter((line): line is string => line !== undefined);

      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    } finally {
      db.close();
    }
  } finally {
    stop();
  }
};

function formatStatuses(byStatus: Record<string, number>): string {
  const entries = Object.entries(byStatus);
  if (entries.length === 0) return '—';
  return entries.map(([status, count]) => `${status}=${count}`).join(', ');
}
