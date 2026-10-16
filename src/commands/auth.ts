import { createInterface } from 'node:readline/promises';

import { buildAuthorizeUrl, exchangeCodeForToken, isConfirmationCode } from '../auth/oauth.js';
import { toTokenData } from '../auth/tokenManager.js';
import { TokenStore } from '../auth/tokenStore.js';
import { openBrowser } from '../util/browser.js';
import { ConfigError, UsageError } from '../util/errors.js';
import type { CommandContext, CommandInput, CommandRunner } from './types.js';

async function readCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('Код подтверждения: ');
  } finally {
    rl.close();
  }
}

/**
 * `yd auth [код]` — авторизация через код подтверждения.
 *
 * Открывает браузер (если не задан --no-browser), принимает код (аргументом или
 * из stdin) и обменивает его на access_token + refresh_token, сохраняя их в token.json.
 */
export const runAuth: CommandRunner = async (
  { args }: CommandInput,
  ctx: CommandContext,
): Promise<number> => {
  const { clientId, clientSecret } = ctx.config.oauth;
  if (!clientId) {
    throw new ConfigError('Не задан YD_OAUTH_CLIENT_ID. Укажите его в .env (см. .env.example).');
  }
  if (!clientSecret) {
    throw new ConfigError(
      'Не задан YD_OAUTH_CLIENT_SECRET. Укажите его в .env (см. .env.example).',
    );
  }

  const url = buildAuthorizeUrl(clientId);
  process.stdout.write(
    [
      'Откройте ссылку в браузере и разрешите доступ приложению:',
      '',
      `  ${url}`,
      '',
      'Яндекс покажет код подтверждения — введите его ниже.',
      '',
    ].join('\n'),
  );

  if (ctx.flags.noBrowser) {
    process.stdout.write('(авто-открытие браузера отключено)\n');
  } else {
    const opened = await openBrowser(url);
    process.stdout.write(
      opened ? '✓ Браузер открыт\n' : '— Не удалось открыть браузер, откройте ссылку вручную\n',
    );
  }

  if (!args[0] && !process.stdin.isTTY) {
    throw new UsageError('Нет интерактивного ввода. Передайте код аргументом: yd auth <код>.');
  }

  if (!args[0]) process.stdout.write('… ожидаю код подтверждения\n');

  const rawCode = (args[0] ?? (await readCode())).trim();
  if (!isConfirmationCode(rawCode)) {
    throw new UsageError(
      'Не удалось распознать код подтверждения (пустая строка или лишние пробелы).',
    );
  }

  const response = await exchangeCodeForToken({ clientId, clientSecret }, rawCode);
  const store = new TokenStore(ctx.config.tokenPath);
  store.save(toTokenData(response));

  process.stdout.write(`\n✓ Токен получен и сохранён: ${ctx.config.tokenPath}\n`);
  return 0;
};
