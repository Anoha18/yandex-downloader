import { PROFILE_PRESETS } from '../config/schema.js';
import { configTemplate, writeConfigTemplate } from '../config/write.js';
import { UsageError } from '../util/errors.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Визуализация эффективного конфига (без утечки токена/секретов). */
function renderConfig(ctx: CommandContext): string {
  const { config } = ctx;
  const view = {
    configPath: ctx.configPath,
    configFileExists: ctx.configFileExists,
    downloadDir: config.downloadDir,
    oauth: {
      source: '.env (YD_OAUTH_CLIENT_ID / YD_OAUTH_CLIENT_SECRET)',
      clientId: maskSecret(config.oauth.clientId),
      clientSecret: config.oauth.clientSecret ? '***' : '',
    },
    tokenPath: config.tokenPath,
    statePath: config.statePath,
    logDir: config.logDir,
    profile: config.profile,
    profileSettings: PROFILE_PRESETS[config.profile],
    rateLimit: config.rateLimit,
  };
  return JSON.stringify(view, null, 2);
}

/**
 * `yd config <init | show | path | template>`
 *   init — создать файл конфига с шаблоном;
 *   show — показать эффективную конфигурацию;
 *   path — показать путь к файлу конфига;
 *   template — напечатать шаблон.
 */
export const runConfig: CommandRunner = async (
  { args }: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const sub = args[0] ?? 'show';
  switch (sub) {
    case 'init': {
      const result = writeConfigTemplate(ctx.configPath);
      process.stdout.write(`Создан конфиг: ${result.path}\n`);
      return 0;
    }
    case 'show': {
      process.stdout.write(`${renderConfig(ctx)}\n`);
      return 0;
    }
    case 'path': {
      process.stdout.write(`${ctx.configPath}\n`);
      return 0;
    }
    case 'template': {
      process.stdout.write(configTemplate());
      return 0;
    }
    default:
      throw new UsageError(
        `Неизвестная подкоманда config: «${sub}». Доступно: init, show, path, template`,
      );
  }
};
