import './util/warnings.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runAuth } from './commands/auth.js';
import { runConfig } from './commands/config.js';
import { runDownload } from './commands/download.js';
import { runLs } from './commands/ls.js';
import { runPhotos } from './commands/photos.js';
import { runScan } from './commands/scan.js';
import { runStats } from './commands/stats.js';
import type { CommandContext, CommandInput, CommandRunner, GlobalFlags } from './commands/types.js';
import { runWhoami } from './commands/whoami.js';
import { loadDotEnv } from './config/env.js';
import { loadConfig } from './config/load.js';
import { AppError, UsageError } from './util/errors.js';
import { configureLogger, getLogger } from './util/logger.js';
import { findProjectRoot } from './util/paths.js';

interface CommandEntry {
  run: CommandRunner;
  summary: string;
}

const COMMANDS: Record<string, CommandEntry> = {
  auth: { run: runAuth, summary: 'авторизоваться и получить OAuth-токен' },
  whoami: { run: runWhoami, summary: 'проверить токен и показать информацию о диске' },
  ls: { run: runLs, summary: 'показать содержимое папки на Диске' },
  scan: { run: runScan, summary: 'просканировать диск и построить очередь' },
  photos: { run: runPhotos, summary: 'безлимитные фото: collect | auth | status | export' },
  stats: { run: runStats, summary: 'показать сводку по очереди из БД' },
  download: { run: runDownload, summary: 'скачать файлы из очереди' },
  config: { run: runConfig, summary: 'конфигурация: init | show | path' },
};

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, entry]) => {
    return `  ${name.padEnd(10)} ${entry.summary}`;
  });
  return [
    'yd — выгрузка файлов с Яндекс.Диска на локальный носитель',
    '',
    'Использование:',
    '  yd <команда> [аргументы] [флаги]',
    '',
    'Команды:',
    ...lines,
    '',
    'Глобальные флаги:',
    '  -c, --config <path>   путь к файлу конфига (по умолчанию data/config.json)',
    '  -p, --profile <name>  профиль нагрузки: gentle | normal | fast',
    '  -v, --verbose         подробное логирование (debug)',
    '      --quiet           без живого прогресса (только ошибки и итог)',
    '      --no-browser      не открывать браузер автоматически (для команды auth)',
    '  -h, --help            показать эту справку',
    '      --version         показать версию',
    '',
    'Флаги команды scan:',
    '      --deep            рекурсивный обход (полное дерево, вкл. пустые папки)',
    '      --path <dir>      ограничить поддеревом (например, /Документы)',
    '      --export <file>   выгрузить дерево в JSON',
    '      --concurrency <n> число одновременных запросов (1..64, по умолчанию из профиля)',
    '',
    'Флаги команды photos:',
    '      --refresh             заново получить cookies через браузер',
    '      --cookies <file>      путь к cookies.json (по умолчанию data/cookies.json)',
    '      --browser-profile <d> каталог профиля браузера для cookies',
    '      --browser <name>      chrome | msedge (использовать установленный браузер)',
    '',
    'Флаги команды download:',
    '      --files               только обычные файлы',
    '      --photos              только безлимитные фото',
    '      --path <dir>          ограничить файлы поддеревом',
    '      --concurrency <n>     воркеры для файлов и фото (по умолчанию из профиля)',
    '      --limit <n>           скачать не более N файлов/фото (отладка)',
    '      --retry-failed        вернуть упавшие в очередь',
    '      --recheck             пересчитать md5 скачанного и перекачать побитое',
    '      --dry-run             только показать, что будет скачано',
    '      --download-timeout <с> таймаут соединения при скачивании, сек (по умолчанию 30)',
    '',
  ].join('\n');
}

function getVersion(): string {
  try {
    const raw = readFileSync(join(findProjectRoot(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      verbose: { type: 'boolean', short: 'v' },
      profile: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      'no-browser': { type: 'boolean' },
      deep: { type: 'boolean' },
      path: { type: 'string' },
      export: { type: 'string' },
      concurrency: { type: 'string' },
      cookies: { type: 'string' },
      'browser-profile': { type: 'string' },
      browser: { type: 'string' },
      refresh: { type: 'boolean' },
      files: { type: 'boolean' },
      photos: { type: 'boolean' },
      limit: { type: 'string' },
      'retry-failed': { type: 'boolean' },
      recheck: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      quiet: { type: 'boolean' },
      'download-timeout': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  const values = parsed.values as Record<string, unknown>;
  const positionals = parsed.positionals;

  if (values.version === true) {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }

  const command = positionals[0];
  const commandArgs = positionals.slice(1);

  if (values.help === true || command === undefined || command === 'help') {
    process.stdout.write(usage());
    return values.help === true || command !== undefined ? 0 : 2;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    throw new UsageError(`Неизвестная команда: «${command}». Запустите «yd --help».`);
  }

  const flags: GlobalFlags = {
    verbose: values.verbose === true,
    quiet: values.quiet === true,
    profile: typeof values.profile === 'string' ? values.profile : undefined,
    config: typeof values.config === 'string' ? values.config : undefined,
    noBrowser: values['no-browser'] === true,
  };

  configureLogger(flags.verbose ? 'debug' : 'info');
  loadDotEnv(findProjectRoot());

  const loaded = loadConfig({
    configPath: flags.config,
    overrides: { profile: flags.profile },
  });

  const ctx: CommandContext = {
    config: loaded.config,
    paths: loaded.paths,
    projectRoot: loaded.projectRoot,
    configPath: loaded.configPath,
    configFileExists: loaded.configFileExists,
    flags,
  };

  const input: CommandInput = { args: commandArgs, options: values };
  return entry.run(input, ctx);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const logger = getLogger();
    if (error instanceof AppError) {
      logger.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    logger.error('Непредвиденная ошибка', error);
    process.exitCode = 1;
  });
