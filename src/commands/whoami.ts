import { humanBytes } from '../util/format.js';
import { createDiskApi } from './helpers.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

/** `yd whoami` — проверка токена и вывод информации о диске. */
export const runWhoami: CommandRunner = async (
  _input: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  if (!ctx.flags.quiet) process.stderr.write('… запрашиваю информацию о диске\n');
  const { api, refreshed } = await createDiskApi(ctx);
  const info = await api.getDiskInfo();

  const lines = [
    `Аккаунт: ${info.user?.display_name ?? '—'} (${info.user?.login ?? '—'})`,
    `UID: ${info.user?.uid ?? '—'}`,
    `Занято: ${humanBytes(info.used_space)} из ${humanBytes(info.total_space)}`,
    `Корзина: ${humanBytes(info.trash_size)}`,
  ];
  if (refreshed) lines.push('(токен был обновлён автоматически)');

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
};
