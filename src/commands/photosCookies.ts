import { PhotosliceClient } from '../api/photosliceClient.js';
import { harvestYandexCookies } from '../auth/browserCookies.js';
import { type Cookie, cookiesExpired, hasSessionCookie, loadCookies } from '../auth/cookies.js';
import type { CommandContext } from './types.js';

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Возвращает валидные cookies Яндекс-сессии, при необходимости подтягивая их через браузер. */
export async function ensureCookies(
  ctx: CommandContext,
  options: Record<string, unknown>,
): Promise<Cookie[]> {
  const cookiesPath = optionalString(options.cookies) ?? ctx.config.cookiesPath;
  const refresh = options.refresh === true;

  if (!refresh) {
    const cached = loadCookies(cookiesPath);
    if (cached && hasSessionCookie(cached) && !cookiesExpired(cached)) return cached;
  }

  const profileDir = optionalString(options['browser-profile']) ?? ctx.config.browserProfileDir;
  const browserName = optionalString(options.browser);

  return harvestYandexCookies({ profileDir, cookiesFile: cookiesPath, browserName });
}

/** Создаёт клиент photoslice с параметрами ретраев и авто-обновлением cookies при 401/403. */
export function createPhotosliceClient(
  ctx: CommandContext,
  cookies: Cookie[],
  onSessionExpired?: () => Promise<Cookie[]>,
): PhotosliceClient {
  return new PhotosliceClient({
    cookies,
    maxAttempts: ctx.config.rateLimit.maxAttempts,
    baseDelayMs: ctx.config.rateLimit.baseDelayMs,
    maxDelayMs: ctx.config.rateLimit.maxDelayMs,
    onSessionExpired,
  });
}
