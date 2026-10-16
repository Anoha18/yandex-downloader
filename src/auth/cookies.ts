import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDir } from '../util/paths.js';

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** Имена cookies, наличие которых считаем признаком активной сессии Яндекса. */
export const SESSION_COOKIE_NAMES = ['Session_id', 'sessionid', 'yandex_login', 'L', 'Session_id1'];

function isCookieLike(
  value: unknown,
): value is { name: unknown; value: unknown } & Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'name' in value && 'value' in value;
}

/** Приводит произвольный JSON cookies (массив Cookie-Editor или объект name→value) к списку. */
export function normalizeCookies(data: unknown): Cookie[] {
  if (Array.isArray(data)) {
    return data.filter(isCookieLike).map((item) => ({
      name: String(item.name),
      value: String(item.value),
      domain: typeof item.domain === 'string' ? item.domain : undefined,
      path: typeof item.path === 'string' ? item.path : undefined,
    }));
  }
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => ({ name, value: value as string }));
  }
  return [];
}

export function loadCookies(file: string): Cookie[] | null {
  if (!existsSync(file)) return null;
  try {
    const cookies = normalizeCookies(JSON.parse(readFileSync(file, 'utf8')));
    return cookies.length > 0 ? cookies : null;
  } catch {
    return null;
  }
}

export function saveCookies(file: string, cookies: Cookie[]): void {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(cookies, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // права могли не примениться — не критично
  }
}

export function hasSessionCookie(cookies: Cookie[]): boolean {
  return cookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
}

/**
 * Считает cookies просроченными, если все сессионные куки имеют срок и он истёк.
 * Куки без срока (session cookies, expires = -1) считаются валидными.
 */
export function cookiesExpired(cookies: Cookie[], skewMs = 5 * 60_000): boolean {
  const session = cookies.filter((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
  if (session.length === 0) return true;
  if (session.some((cookie) => cookie.expires === undefined || cookie.expires === -1)) {
    return false;
  }
  const now = Date.now();
  return session.every((cookie) => (cookie.expires ?? 0) * 1000 < now + skewMs);
}

export function cookiesToRecord(cookies: Cookie[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const cookie of cookies) record[cookie.name] = cookie.value;
  return record;
}
