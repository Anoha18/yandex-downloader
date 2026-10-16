import type { AppConfig } from '../config/schema.js';
import type { AppPaths } from '../util/paths.js';

/** Глобальные флаги CLI, разобранные в cli.ts. */
export interface GlobalFlags {
  verbose: boolean;
  quiet: boolean;
  profile?: string;
  config?: string;
  /** Не открывать браузер автоматически (флаг --no-browser). */
  noBrowser: boolean;
}

/** Вход команды: позиционные аргументы и разобранные опции. */
export interface CommandInput {
  /** Позиционные аргументы после имени команды. */
  args: string[];
  /** Все разобранные опции (включая командно-специфичные). */
  options: Record<string, unknown>;
}

/** Контекст, передаваемый каждой команде. */
export interface CommandContext {
  config: AppConfig;
  paths: AppPaths;
  projectRoot: string;
  configPath: string;
  /** Существует ли файл конфига на диске. */
  configFileExists: boolean;
  flags: GlobalFlags;
}

/** Функция-обработчик команды. Возвращает код выхода. */
export type CommandRunner = (input: CommandInput, ctx: CommandContext) => Promise<number>;
