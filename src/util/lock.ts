import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { UsageError } from './errors.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс существует, но принадлежит другому пользователю.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeLock(path: string): void {
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
}

function readPid(path: string): number {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * Берёт эксклюзивный файловый лок (защита от параллельного запуска команды).
 *
 * Если лок уже занят живым процессом — бросает UsageError. Устаревший лок
 * (процесс завершился) перезаписывается. Возвращает функцию освобождения.
 */
export function acquireLock(path: string, label = 'скачивание'): () => void {
  try {
    writeLock(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = readPid(path);
    if (pid > 0 && isProcessAlive(pid)) {
      throw new UsageError(
        `Уже запущено: ${label} (pid ${pid}). Дождитесь завершения или остановите процесс.`,
      );
    }
    try {
      unlinkSync(path);
    } catch {
      // лок мог исчезнуть между проверкой и удалением — не критично
    }
    writeLock(path);
  }

  return () => {
    try {
      unlinkSync(path);
    } catch {
      // уже освобождён
    }
  };
}
