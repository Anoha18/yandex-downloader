import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDir } from '../util/paths.js';

/** Сохранённые OAuth-данные. */
export interface TokenData {
  accessToken: string;
  refreshToken?: string;
  /** Unix-время (мс) истечения access-токена, если известно. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

/**
 * Хранилище OAuth-токена в локальном JSON-файле с правами 0600.
 *
 * Этап 0: реализованы чтение/запись/очистка. Получение токена (OAuth) — Этап 1.
 */
export class TokenStore {
  constructor(private readonly file: string) {}

  load(): TokenData | null {
    if (!existsSync(this.file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = parsed as Partial<TokenData>;
    if (typeof data.accessToken !== 'string' || data.accessToken.length === 0) return null;
    return data as TokenData;
  }

  save(token: TokenData): void {
    ensureDir(dirname(this.file));
    writeFileSync(this.file, `${JSON.stringify(token, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // права могли не примениться (например, на некоторых ФС) — не критично
    }
  }

  clear(): void {
    if (existsSync(this.file)) rmSync(this.file, { force: true });
  }
}
