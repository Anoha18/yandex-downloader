import { DiskApi } from '../api/diskApi.js';
import { HttpClient } from '../api/httpClient.js';
import { getAccessToken } from '../auth/tokenManager.js';
import { TokenStore } from '../auth/tokenStore.js';
import { PROFILE_PRESETS } from '../config/schema.js';
import { AdaptiveLimiter } from '../util/rateLimiter.js';
import type { CommandContext } from './types.js';

export interface Session {
  api: DiskApi;
  http: HttpClient;
  accessToken: string;
  limiter: AdaptiveLimiter;
  refreshed: boolean;
}

/**
 * Создаёт сессию: актуальный токен, адаптивный лимитер и HTTP-клиент.
 */
export async function createSession(ctx: CommandContext): Promise<Session> {
  const store = new TokenStore(ctx.config.tokenPath);
  const { accessToken, refreshed } = await getAccessToken(store, ctx.config.oauth);

  const qps = PROFILE_PRESETS[ctx.config.profile].qps;
  const limiter = new AdaptiveLimiter({
    qps,
    minQps: 1,
    cooldownMs: ctx.config.rateLimit.cooldownMs,
    errorThreshold: 8,
    windowMs: 60_000,
  });
  const http = new HttpClient(accessToken, { limiter, rateLimit: ctx.config.rateLimit });

  return { api: new DiskApi(http), http, accessToken, limiter, refreshed };
}

/** Диск-API с актуальным токеном (для команд без скачивания). */
export async function createDiskApi(
  ctx: CommandContext,
): Promise<{ api: DiskApi; refreshed: boolean }> {
  const session = await createSession(ctx);
  return { api: session.api, refreshed: session.refreshed };
}
