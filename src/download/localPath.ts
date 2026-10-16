import { join } from 'node:path';

/** Символы, недопустимые в именах файлов (в основном Windows). */
const ILLEGAL_CHARS = /[<>:"|?*\p{Cc}]/gu;

/** Зарезервированные имена Windows. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Санитизирует один сегмент пути (имя файла/папки). */
export function sanitizeSegment(segment: string): string {
  let value = segment.replace(ILLEGAL_CHARS, '_');
  value = value.replace(/[. ]+$/g, ''); // Windows не любит точку/пробел в конце
  value = value.replace(/^\.+$/, '_'); // '.', '..' и подобное
  if (value.length === 0) value = '_';
  if (RESERVED_NAMES.test(value)) value = `_${value}`;
  return value;
}

/** Разбивает путь Диска на безопасные сегменты (без '' , '.', '..'). */
export function segmentsFromRemote(remotePath: string): string[] {
  return remotePath
    .replace(/^disk:\/*/, '')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map(sanitizeSegment);
}

/** Полный локальный путь для файла Диска (структура сохраняется). */
export function resolveLocalPath(downloadDir: string, remotePath: string): string {
  return join(downloadDir, ...segmentsFromRemote(remotePath));
}

/** Добавляет суффикс ` (n)` перед расширением файла. */
export function withSuffix(path: string, n: number): string {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot > slash) return `${path.slice(0, dot)} (${n})${path.slice(dot)}`;
  return `${path} (${n})`;
}

/**
 * Выдаёт уникальные локальные пути, добавляя суффикс ` (n)` при коллизии
 * РАЗНЫХ путей Диска (в т.ч. без учёта регистра). Один и тот же путь Диска
 * всегда отображается в один и тот же локальный путь, чтобы повторные попытки
 * докачивали тот же `.part`, а не создавали `(1)`, `(2)`, … заново.
 */
export class PathAllocator {
  private readonly used = new Set<string>();
  private readonly byRemote = new Map<string, string>();

  constructor(private readonly downloadDir: string) {}

  allocate(remotePath: string): string {
    const memo = this.byRemote.get(remotePath);
    if (memo !== undefined) return memo;

    const base = resolveLocalPath(this.downloadDir, remotePath);
    let candidate = base;
    let counter = 1;
    while (this.used.has(candidate.toLowerCase())) {
      candidate = withSuffix(base, counter++);
    }
    this.used.add(candidate.toLowerCase());
    this.byRemote.set(remotePath, candidate);
    return candidate;
  }
}
