import { HttpError } from '../util/errors.js';

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';

/** Инъекция fetch для тестируемости. */
export type FetchLike = typeof fetch;

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/** Ответ OAuth-сервера на обмен кода/refresh-токена. */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Ссылка для запроса кода подтверждения.
 *
 * Redirect URI приложения — https://oauth.yandex.ru/verification_code: Яндекс покажет
 * 7-значный код прямо на странице, который затем обменивается на токен.
 */
export function buildAuthorizeUrl(clientId: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    force_confirm: 'yes',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Проверяет, что строка похожа на код подтверждения.
 *
 * Формат не навязываем: Яндекс может выдать как 7-значный код, так и
 * буквенно-цифровую строку (например, `czlns3tvcfnsgbmp`). Отсекаем только
 * очевидно некорректный ввод (пустое, пробелы, неразумная длина) — корректность
 * в конечном счёте проверяет сервер при обмене кода на токен.
 */
export function isConfirmationCode(value: string): boolean {
  return /^\S{4,256}$/.test(value.trim());
}

async function requestToken(
  body: URLSearchParams,
  fetchImpl: FetchLike,
): Promise<OAuthTokenResponse> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const record = data as Record<string, unknown> | undefined;
    const detail = record?.error_description ?? record?.error ?? text ?? '';
    throw new HttpError(
      response.status,
      `OAuth: не удалось получить токен (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      data,
    );
  }

  const token = data as OAuthTokenResponse | undefined;
  if (!token || typeof token.access_token !== 'string' || token.access_token.length === 0) {
    throw new HttpError(response.status, 'OAuth: сервер не вернул access_token', data);
  }
  return token;
}

/** Обмен кода подтверждения на access_token (+ refresh_token). */
export function exchangeCodeForToken(
  credentials: OAuthCredentials,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code.trim(),
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  return requestToken(body, fetchImpl);
}

/** Продление access_token по refresh_token. */
export function refreshAccessToken(
  credentials: OAuthCredentials,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  return requestToken(body, fetchImpl);
}
