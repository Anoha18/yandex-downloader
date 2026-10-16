/**
 * Простой уровне-зависимый логгер.
 *
 * Логи пишутся в stderr (чтобы stdout оставался чистым для результатов команд),
 * например для `config show` или будущего машинно-читаемого вывода.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

class StderrLogger implements Logger {
  constructor(private readonly level: LogLevel) {}

  private enabled(level: LogLevel): boolean {
    return ORDER[level] <= ORDER[this.level];
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.enabled(level)) return;
    const timestamp = new Date().toISOString();
    const suffix = args.length > 0 ? ` ${args.map(stringifyArg).join(' ')}` : '';
    process.stderr.write(`${timestamp} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }
}

let currentLogger: Logger = new StderrLogger('info');

export function configureLogger(level: LogLevel): void {
  currentLogger = new StderrLogger(level);
}

export function getLogger(): Logger {
  return currentLogger;
}
