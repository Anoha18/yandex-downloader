import type { BrowserContext, Cookie as PlaywrightCookie } from 'playwright';
import { sleep } from '../util/async.js';
import { ConfigError } from '../util/errors.js';
import { getLogger, type Logger } from '../util/logger.js';
import { type Cookie, hasSessionCookie, saveCookies } from './cookies.js';

export interface HarvestOptions {
  /** Каталог персистентного профиля браузера. */
  profileDir: string;
  /** Куда сохранить cookies. */
  cookiesFile: string;
  /** Открывать страницу Диска/Фото. */
  url?: string;
  /** 'chromium' | 'chrome' | 'msedge' — использовать установленный браузер вместо встроенного. */
  browserName?: string;
  headless?: boolean;
  /** Сколько ждать ручного логина, мс. */
  loginTimeoutMs?: number;
}

const DEFAULT_URL = 'https://disk.yandex.ru/client/photo';
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

/**
 * Забирает cookies Яндекс-сессии через браузер Playwright.
 *
 * Значения cookies в браузере зашифрованы под ОС, поэтому не разбираем их сами —
 * браузер отдаёт уже расшифрованные cookies. Профиль персистентный: логин
 * сохраняется между запусками.
 */
export async function harvestYandexCookies(options: HarvestOptions): Promise<Cookie[]> {
  const log = getLogger();
  const playwright = await importPlaywright();
  const url = options.url ?? DEFAULT_URL;
  const headless = options.headless ?? false;
  const channel =
    options.browserName && options.browserName !== 'chromium' ? options.browserName : undefined;

  log.info('Открываю браузер для получения cookies...');
  let context: BrowserContext;
  try {
    context = await playwright.chromium.launchPersistentContext(options.profileDir, {
      headless,
      channel,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  } catch (error) {
    throw new ConfigError(
      `Не удалось запустить браузер: ${(error as Error).message}\n` +
        'Если браузер не установлен, выполните: pnpm exec playwright install chromium',
    );
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

    await waitForLogin(context, options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, log);

    const cookies = toCookies(
      await context.cookies(['https://disk.yandex.ru', 'https://yandex.ru']),
    ).filter((cookie) => cookie.name && cookie.value);

    if (!hasSessionCookie(cookies)) {
      throw new ConfigError(
        'Не удалось получить cookies сессии Яндекса. Убедитесь, что вы вошли в аккаунт, и повторите.',
      );
    }

    saveCookies(options.cookiesFile, cookies);
    log.info(`Cookies сохранены: ${options.cookiesFile}`);
    return cookies;
  } finally {
    await context.close().catch(() => {});
  }
}

async function importPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new ConfigError(
      'Модуль playwright не установлен. Выполните: pnpm add playwright && pnpm exec playwright install chromium',
    );
  }
}

async function waitForLogin(
  context: BrowserContext,
  timeoutMs: number,
  log: Logger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  for (;;) {
    const cookies = await context.cookies(['https://disk.yandex.ru']);
    if (
      cookies.some((cookie) =>
        ['Session_id', 'sessionid', 'yandex_login', 'L'].includes(cookie.name),
      )
    ) {
      log.info('Авторизация обнаружена.');
      return;
    }
    if (Date.now() > deadline) {
      throw new ConfigError('Истекло время ожидания авторизации. Войдите в аккаунт и повторите.');
    }
    if (!announced) {
      log.info('Если вы не авторизованы — войдите в аккаунт в открывшемся окне браузера.');
      announced = true;
    }
    await sleep(2000);
  }
}

function toCookies(cookies: PlaywrightCookie[]): Cookie[] {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }));
}
