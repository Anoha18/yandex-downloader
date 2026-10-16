import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ConfigError } from '../util/errors.js';
import { ensureDir } from '../util/paths.js';

/**
 * Шаблон конфига, который создаётся командой `config init`.
 *
 * Учётные данные OAuth здесь намеренно отсутствуют: они задаются в .env
 * (см. .env.example).
 */
export function configTemplate(): string {
  return `${JSON.stringify(
    {
      downloadDir: 'downloads',
      profile: 'normal',
      rateLimit: {
        maxAttempts: 7,
        baseDelayMs: 2000,
        maxDelayMs: 120000,
        cooldownMs: 300000,
      },
    },
    null,
    2,
  )}\n`;
}

export interface WriteConfigResult {
  path: string;
  created: boolean;
}

/** Создаёт файл конфига с шаблоном. По умолчанию не перезаписывает существующий. */
export function writeConfigTemplate(
  path: string,
  options: { force?: boolean } = {},
): WriteConfigResult {
  if (existsSync(path) && !options.force) {
    throw new ConfigError(`Конфиг уже существует: ${path}. Используйте --force для перезаписи.`);
  }
  ensureDir(dirname(path));
  writeFileSync(path, configTemplate(), 'utf8');
  return { path, created: true };
}
