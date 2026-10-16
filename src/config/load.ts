import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { ConfigError } from '../util/errors.js';
import { type AppPaths, findProjectRoot, resolveAppPaths } from '../util/paths.js';
import {
  type AppConfig,
  DEFAULT_RATE_LIMIT,
  PROFILES,
  type Profile,
  validateConfig,
} from './schema.js';

/** Значения по умолчанию (до наложения файла/окружения/флагов). */
export function defaultConfig(paths: AppPaths, projectRoot: string): AppConfig {
  return {
    downloadDir: join(projectRoot, 'downloads'),
    photosDir: join(projectRoot, '_unlimited_photos'),
    oauth: { clientId: '', clientSecret: '' },
    tokenPath: paths.tokenFile,
    statePath: paths.stateDb,
    cookiesPath: paths.cookiesFile,
    browserProfileDir: paths.browserProfileDir,
    logDir: paths.logDir,
    profile: 'normal',
    rateLimit: { ...DEFAULT_RATE_LIMIT },
  };
}

export interface ConfigOverrides {
  profile?: string;
}

export interface LoadConfigOptions {
  /** Путь к файлу конфига (флаг --config). По умолчанию — <base>/config.json. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: ConfigOverrides;
}

export interface LoadedConfig {
  config: AppConfig;
  paths: AppPaths;
  projectRoot: string;
  configPath: string;
  configFileExists: boolean;
}

function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Не удалось прочитать конфиг ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Некорректный JSON в конфиге ${path}: ${(error as Error).message}`);
  }
}

/** Накладывает переменные окружения (в т.ч. загруженные из .env). */
function applyEnv(config: AppConfig, env: NodeJS.ProcessEnv): AppConfig {
  const next = structuredClone(config);

  const downloadDir = env.YD_DOWNLOAD_DIR;
  if (downloadDir?.trim()) next.downloadDir = downloadDir;

  const photosDir = env.YD_PHOTOS_DIR;
  if (photosDir?.trim()) next.photosDir = photosDir;

  if (env.YD_OAUTH_CLIENT_ID !== undefined) next.oauth.clientId = env.YD_OAUTH_CLIENT_ID;
  if (env.YD_OAUTH_CLIENT_SECRET !== undefined)
    next.oauth.clientSecret = env.YD_OAUTH_CLIENT_SECRET;

  const profile = env.YD_PROFILE;
  if (profile?.trim()) {
    if (!(PROFILES as readonly string[]).includes(profile)) {
      throw new ConfigError(`YD_PROFILE: ожидается одно из значений ${PROFILES.join(' | ')}`);
    }
    next.profile = profile as Profile;
  }

  const logDir = env.YD_LOG_DIR;
  if (logDir?.trim()) next.logDir = logDir;

  return next;
}

function applyOverrides(config: AppConfig, overrides: ConfigOverrides | undefined): AppConfig {
  if (!overrides?.profile) return config;
  const next = structuredClone(config);
  if (!(PROFILES as readonly string[]).includes(overrides.profile)) {
    throw new ConfigError(`--profile: ожидается одно из значений ${PROFILES.join(' | ')}`);
  }
  next.profile = overrides.profile as Profile;
  return next;
}

/** Приводит относительные пути к абсолютным относительно projectRoot/baseDir. */
function normalizePaths(config: AppConfig, paths: AppPaths, projectRoot: string): AppConfig {
  const next = structuredClone(config);
  next.downloadDir = isAbsolute(next.downloadDir)
    ? next.downloadDir
    : resolve(projectRoot, next.downloadDir);
  next.photosDir = isAbsolute(next.photosDir)
    ? next.photosDir
    : resolve(projectRoot, next.photosDir);
  next.tokenPath = isAbsolute(next.tokenPath)
    ? next.tokenPath
    : resolve(paths.baseDir, next.tokenPath);
  next.statePath = isAbsolute(next.statePath)
    ? next.statePath
    : resolve(paths.baseDir, next.statePath);
  next.cookiesPath = isAbsolute(next.cookiesPath)
    ? next.cookiesPath
    : resolve(paths.baseDir, next.cookiesPath);
  next.browserProfileDir = isAbsolute(next.browserProfileDir)
    ? next.browserProfileDir
    : resolve(paths.baseDir, next.browserProfileDir);
  next.logDir = isAbsolute(next.logDir) ? next.logDir : resolve(projectRoot, next.logDir);
  return next;
}

/**
 * Загружает конфигурацию: defaults < config.json < env < CLI-флаги.
 *
 * Загрузка файла .env выполняется отдельно (см. config/env.ts) до вызова этой функции.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const projectRoot = findProjectRoot();
  const paths = resolveAppPaths();
  const configPath = options.configPath ? resolve(options.configPath) : paths.configFile;

  const defaults = defaultConfig(paths, projectRoot);
  const configFileExists = existsSync(configPath);
  const raw = configFileExists ? readConfigFile(configPath) : undefined;

  let config = validateConfig(raw, defaults);
  config = applyEnv(config, options.env ?? process.env);
  config = applyOverrides(config, options.overrides);
  config = normalizePaths(config, paths, projectRoot);

  return { config, paths, projectRoot, configPath, configFileExists };
}
