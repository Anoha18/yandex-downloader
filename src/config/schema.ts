import { ConfigError } from '../util/errors.js';

/** Профиль нагрузки: влияет на QPS метаданных и конкурентность загрузок. */
export type Profile = 'gentle' | 'normal' | 'fast';

export const PROFILES: readonly Profile[] = ['gentle', 'normal', 'fast'];

/** Параметры профиля, применяемые во время работы (Этапы 2–3). */
export interface ProfileConfig {
  /** Лимит запросов к metadata API (cloud-api.yandex.net) в секунду. */
  qps: number;
  /** Число одновременных загрузок файлов. */
  concurrency: number;
}

export const PROFILE_PRESETS: Record<Profile, ProfileConfig> = {
  gentle: { qps: 2, concurrency: 1 },
  normal: { qps: 4, concurrency: 3 },
  fast: { qps: 8, concurrency: 6 },
};

/** Настройки повторных попыток и предохранителя против троттлинга. */
export interface RateLimitConfig {
  /** Сколько раз пробовать скачать файл, прежде чем пометить как failed. */
  maxAttempts: number;
  /** Базовая задержка экспоненциального backoff, мс. */
  baseDelayMs: number;
  /** Верхняя граница задержки backoff, мс. */
  maxDelayMs: number;
  /** Пауза всей системы при срабатывании предохранителя (серия 429/5xx), мс. */
  cooldownMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 7,
  baseDelayMs: 2_000,
  maxDelayMs: 120_000,
  cooldownMs: 300_000,
};

/**
 * Учётные данные OAuth-приложения.
 *
 * Вариант A: эти значения берутся ТОЛЬКО из переменных окружения (.env) и не
 * хранятся в config.json.
 */
export interface OAuthConfig {
  /** ClientID приложения Яндекс ID (YD_OAUTH_CLIENT_ID). */
  clientId: string;
  /** Секретный ключ приложения (YD_OAUTH_CLIENT_SECRET). */
  clientSecret: string;
}

/** Полностью разрешённая (со всеми дефолтами) конфигурация приложения. */
export interface AppConfig {
  downloadDir: string;
  photosDir: string;
  oauth: OAuthConfig;
  tokenPath: string;
  statePath: string;
  cookiesPath: string;
  browserProfileDir: string;
  logDir: string;
  profile: Profile;
  /** Явное число воркеров скачивания (перекрывает значение профиля). */
  concurrency?: number;
  rateLimit: RateLimitConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Проверяет «сырой» объект конфига вручную и накладывает его на значения по умолчанию.
 * Бросает ConfigError со списком всех найденных проблем.
 *
 * Блок oauth сюда намеренно не входит: учётные данные приходят из окружения.
 */
export function validateConfig(raw: unknown, defaults: AppConfig): AppConfig {
  if (raw === undefined || raw === null) return structuredClone(defaults);
  if (!isPlainObject(raw)) {
    throw new ConfigError('Конфиг должен быть JSON-объектом.');
  }

  const errors: string[] = [];
  const config: AppConfig = structuredClone(defaults);

  if ('downloadDir' in raw) {
    if (isNonEmptyString(raw.downloadDir)) {
      config.downloadDir = raw.downloadDir;
    } else {
      errors.push('downloadDir: ожидается непустая строка');
    }
  }

  if ('profile' in raw) {
    if (typeof raw.profile === 'string' && (PROFILES as readonly string[]).includes(raw.profile)) {
      config.profile = raw.profile as Profile;
    } else {
      errors.push(`profile: ожидается одно из значений ${PROFILES.join(' | ')}`);
    }
  }

  if ('concurrency' in raw) {
    if (isIntegerInRange(raw.concurrency, 1, 64)) {
      config.concurrency = raw.concurrency;
    } else {
      errors.push('concurrency: ожидается целое число 1..64');
    }
  }

  if ('tokenPath' in raw) {
    if (isNonEmptyString(raw.tokenPath)) config.tokenPath = raw.tokenPath;
    else errors.push('tokenPath: ожидается непустая строка');
  }

  if ('statePath' in raw) {
    if (isNonEmptyString(raw.statePath)) config.statePath = raw.statePath;
    else errors.push('statePath: ожидается непустая строка');
  }

  if ('logDir' in raw) {
    if (isNonEmptyString(raw.logDir)) config.logDir = raw.logDir;
    else errors.push('logDir: ожидается непустая строка');
  }

  if ('photosDir' in raw) {
    if (isNonEmptyString(raw.photosDir)) config.photosDir = raw.photosDir;
    else errors.push('photosDir: ожидается непустая строка');
  }

  if ('cookiesPath' in raw) {
    if (isNonEmptyString(raw.cookiesPath)) config.cookiesPath = raw.cookiesPath;
    else errors.push('cookiesPath: ожидается непустая строка');
  }

  if ('browserProfileDir' in raw) {
    if (isNonEmptyString(raw.browserProfileDir)) config.browserProfileDir = raw.browserProfileDir;
    else errors.push('browserProfileDir: ожидается непустая строка');
  }

  if ('rateLimit' in raw) {
    if (!isPlainObject(raw.rateLimit)) {
      errors.push('rateLimit: ожидается объект');
    } else {
      const rl = raw.rateLimit;
      if ('maxAttempts' in rl) {
        if (isIntegerInRange(rl.maxAttempts, 1, 1000))
          config.rateLimit.maxAttempts = rl.maxAttempts;
        else errors.push('rateLimit.maxAttempts: ожидается целое число 1..1000');
      }
      if ('baseDelayMs' in rl) {
        if (isIntegerInRange(rl.baseDelayMs, 0, 3_600_000))
          config.rateLimit.baseDelayMs = rl.baseDelayMs;
        else errors.push('rateLimit.baseDelayMs: ожидается целое число 0..3600000');
      }
      if ('maxDelayMs' in rl) {
        if (isIntegerInRange(rl.maxDelayMs, 0, 3_600_000))
          config.rateLimit.maxDelayMs = rl.maxDelayMs;
        else errors.push('rateLimit.maxDelayMs: ожидается целое число 0..3600000');
      }
      if ('cooldownMs' in rl) {
        if (isIntegerInRange(rl.cooldownMs, 0, 86_400_000))
          config.rateLimit.cooldownMs = rl.cooldownMs;
        else errors.push('rateLimit.cooldownMs: ожидается целое число 0..86400000');
      }
    }
  }

  if (config.rateLimit.maxDelayMs < config.rateLimit.baseDelayMs) {
    errors.push('rateLimit.maxDelayMs не может быть меньше rateLimit.baseDelayMs');
  }

  if (errors.length > 0) {
    throw new ConfigError(`Ошибки в конфиге:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
