import type { OAuthConfig } from '../config/schema.js';
import { ConfigError } from '../util/errors.js';
import { type FetchLike, type OAuthTokenResponse, refreshAccessToken } from './oauth.js';
import type { TokenData, TokenStore } from './tokenStore.js';

/** Запас времени до истечения, при котором токен уже обновляем, мс. */
const EXPIRY_SKEW_MS = 60_000;

/** Преобразует ответ OAuth в сохраняемую структуру токена. */
export function toTokenData(response: OAuthTokenResponse): TokenData {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: response.expires_in ? Date.now() + response.expires_in * 1000 : undefined,
    tokenType: response.token_type,
    scope: response.scope,
  };
}

export interface AccessTokenResult {
  accessToken: string;
  /** Был ли токен обновлён по refresh_token. */
  refreshed: boolean;
}

/**
 * Возвращает актуальный access_token, при необходимости обновляя его по refresh_token.
 *
 * Бросает ConfigError, если токена нет или он истёк без возможности обновления.
 */
export async function getAccessToken(
  store: TokenStore,
  oauth: OAuthConfig,
  fetchImpl: FetchLike = fetch,
): Promise<AccessTokenResult> {
  const token = store.load();
  if (!token) {
    throw new ConfigError('Нет сохранённого токена. Выполните авторизацию: yd auth');
  }

  const expiring = token.expiresAt !== undefined && Date.now() >= token.expiresAt - EXPIRY_SKEW_MS;
  if (!expiring) {
    return { accessToken: token.accessToken, refreshed: false };
  }

  if (!token.refreshToken) {
    throw new ConfigError(
      'Токен истёк и refresh_token отсутствует. Повторите авторизацию: yd auth',
    );
  }
  if (!oauth.clientId || !oauth.clientSecret) {
    throw new ConfigError(
      'Для обновления токена нужны YD_OAUTH_CLIENT_ID и YD_OAUTH_CLIENT_SECRET (см. .env.example)',
    );
  }

  const response = await refreshAccessToken(
    { clientId: oauth.clientId, clientSecret: oauth.clientSecret },
    token.refreshToken,
    fetchImpl,
  );
  const refreshed = toTokenData(response);
  // Сервер может не вернуть новый refresh_token — сохраняем прежний.
  refreshed.refreshToken ??= token.refreshToken;
  store.save(refreshed);
  return { accessToken: refreshed.accessToken, refreshed: true };
}
