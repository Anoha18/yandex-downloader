import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Определяет корень проекта, поднимаясь от расположения модуля до ближайшего package.json.
 * Работает и из src/util/, и из dist/util/.
 */
export function findProjectRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Пути локальных данных приложения. Всё хранится внутри проекта в каталоге data/. */
export interface AppPaths {
  /** Базовый каталог локальных данных. */
  baseDir: string;
  /** Файл конфигурации. */
  configFile: string;
  /** Файл с OAuth-токеном (права 0600). */
  tokenFile: string;
  /** Файл SQLite с очередью и статусами. */
  stateDb: string;
  /** Файл с cookies для web-сессии (photoslice), права 0600. */
  cookiesFile: string;
  /** Каталог персистентного профиля браузера Playwright. */
  browserProfileDir: string;
  /** Каталог логов. */
  logDir: string;
}

export function resolveAppPaths(baseDir?: string): AppPaths {
  const base = resolve(baseDir ?? join(findProjectRoot(), 'data'));
  return {
    baseDir: base,
    configFile: join(base, 'config.json'),
    tokenFile: join(base, 'token.json'),
    stateDb: join(base, 'state.db'),
    cookiesFile: join(base, 'cookies.json'),
    browserProfileDir: join(base, 'browser-profile'),
    logDir: join(base, 'logs'),
  };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
