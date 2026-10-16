import { spawn } from 'node:child_process';
import { getLogger } from './logger.js';

interface BrowserCommand {
  command: string;
  args: string[];
}

/** Команды открытия URL для текущей платформы (по порядку попыток). */
function candidates(url: string): BrowserCommand[] {
  const fromEnv = process.env.BROWSER;
  if (fromEnv?.trim()) {
    return [{ command: fromEnv.trim(), args: [url] }];
  }

  switch (process.platform) {
    case 'darwin':
      return [{ command: 'open', args: [url] }];
    case 'win32':
      return [{ command: 'cmd', args: ['/c', 'start', '', url] }];
    default:
      return [
        { command: 'xdg-open', args: [url] },
        { command: 'sensible-browser', args: [url] },
        { command: 'x-www-browser', args: [url] },
      ];
  }
}

/**
 * Пытается открыть URL в браузере. Кроссплатформенно, best-effort:
 * пробует команды по очереди и НИКОГДА не бросает ошибку. Возвращает true,
 * если удалось запустить хотя бы одну команду.
 */
export function openBrowser(url: string): Promise<boolean> {
  const list = candidates(url);

  return new Promise((resolve) => {
    let index = 0;

    const tryNext = (): void => {
      const candidate = list[index++];
      if (!candidate) {
        resolve(false);
        return;
      }

      let settled = false;
      try {
        const child = spawn(candidate.command, candidate.args, {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          getLogger().debug(
            `Не удалось открыть браузер через «${candidate.command}»: ${error.message}`,
          );
          tryNext();
        });
        child.on('spawn', () => {
          if (settled) return;
          settled = true;
          child.unref();
          resolve(true);
        });
      } catch (error) {
        getLogger().debug(`Ошибка запуска «${candidate.command}»: ${(error as Error).message}`);
        tryNext();
      }
    };

    tryNext();
  });
}
