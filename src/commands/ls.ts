import { humanBytes } from '../util/format.js';
import { createDiskApi } from './helpers.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

/** `yd ls [path]` — список содержимого папки на Диске. */
export const runLs: CommandRunner = async (
  { args }: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const path = args[0] ?? '/';
  if (!ctx.flags.quiet) process.stderr.write(`… читаю ${path}\n`);
  const { api } = await createDiskApi(ctx);
  const items = await api.listDir(path);

  if (items.length === 0) {
    process.stdout.write(`(пусто) ${path}\n`);
    return 0;
  }

  const lines: string[] = [`${path}:`];
  for (const item of items) {
    if (item.type === 'dir') {
      lines.push(`  [папка]            ${item.name}`);
    } else {
      lines.push(`  ${humanBytes(item.size ?? 0).padStart(10)}  ${item.name}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
};
