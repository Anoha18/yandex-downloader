/**
 * Типизированные ошибки приложения с кодами выхода.
 *
 * Коды выхода:
 *   0 — успех
 *   1 — прочие (непредвиденные) ошибки, сетевые/API ошибки
 *   2 — ошибки использования/конфигурации
 *   3 — функциональность ещё не реализована
 */
export class AppError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** Неверное использование CLI (неизвестная команда, плохие аргументы). */
export class UsageError extends AppError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** Ошибка конфигурации приложения. */
export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** Ошибка HTTP-запроса к API (не 2xx). */
export class HttpError extends AppError {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message, 1);
    this.status = status;
    this.body = body;
  }
}

/** Функциональность, запланированная на следующий этап. */
export class NotImplementedError extends AppError {
  constructor(what: string) {
    super(`«${what}» ещё не реализовано (появится на следующем этапе).`, 3);
  }
}
