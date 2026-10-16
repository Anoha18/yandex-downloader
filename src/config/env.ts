import { existsSync, readFileSync } from 'node:fs';

import { getLogger } from '../util/logger.js';

/**
 * Загружает переменные окружения из файла .env в process.env.
 *
 * Использует встроенный process.loadEnvFile (Node >= 20.12), без внешних зависимостей.
 * Реальные переменные окружения имеют приоритет: значения из .env не перезаписывают
 * уже установленные (это поведение загрузчика Node).
 *
 * @returns путь к загруженному файлу или null, если файла нет/не удалось загрузить.
 */
export function loadDotEnv(projectRoot: string, fileName = '.env'): string | null {
  const file = `${projectRoot}/${fileName}`;
  if (!existsSync(file)) return null;
  try {
    process.loadEnvFile(file);
    getLogger().debug(`Загружены переменные окружения из ${file}`);
    return file;
  } catch (error) {
    getLogger().warn(`Не удалось загрузить ${file}: ${(error as Error).message}`);
    return null;
  }
}

/** Проверяет, что файл читается (для тестов и диагностики). */
export function readEnvFile(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
