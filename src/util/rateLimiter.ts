import { sleep } from './async.js';

/** Общий интерфейс ограничителя частоты, используемый HttpClient. */
export interface Limiter {
  acquire(): Promise<void>;
  /** Сигнал об ошибке (429/5xx) — для адаптивного лимитера. */
  recordError?(status: number): void;
  /** Сигнал об успехе — для восстановления после просадки. */
  recordSuccess?(): void;
}

/**
 * Простейший ограничитель частоты: минимальный интервал между acquire().
 * Времена берутся через Date.now.
 */
export class RateLimiter implements Limiter {
  private lastAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      const now = Date.now();
      const wait = this.lastAt + this.minIntervalMs - now;
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export interface AdaptiveLimiterOptions {
  /** Стартовое число запросов в секунду. */
  qps: number;
  /** Нижняя граница QPS при просадке. */
  minQps?: number;
  /** Длительность полной паузы предохранителя, мс. */
  cooldownMs?: number;
  /** Порог числа ошибок в окне для срабатывания предохранителя. */
  errorThreshold?: number;
  /** Ширина окна подсчёта ошибок, мс. */
  windowMs?: number;
}

/**
 * Адаптивный лимитер: держит минимальный интервал между запросами и
 * реагирует на 429/5xx.
 *
 * При 429 — снижает QPS (AIMD, увеличивая интервал вдвое) и уходит в короткую
 * паузу. При серии ошибок в окне — общий предохранитель (полная пауза).
 * При успехах интервал постепенно возвращается к базовому.
 */
export class AdaptiveLimiter implements Limiter {
  private readonly baseIntervalMs: number;
  private readonly minIntervalMsLimit: number;
  private readonly cooldownMs: number;
  private readonly errorThreshold: number;
  private readonly windowMs: number;

  private intervalMs: number;
  private lastAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private pauseUntil = 0;
  private errors: number[] = [];

  constructor(options: AdaptiveLimiterOptions) {
    this.baseIntervalMs = Math.ceil(1000 / Math.max(options.qps, 1));
    this.minIntervalMsLimit = Math.ceil(1000 / Math.max(options.minQps ?? 1, 1));
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.errorThreshold = options.errorThreshold ?? 8;
    this.windowMs = options.windowMs ?? 60_000;
    this.intervalMs = this.baseIntervalMs;
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  get isPaused(): boolean {
    return Date.now() < this.pauseUntil;
  }

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        const wait = Math.max(this.pauseUntil - now, this.lastAt + this.intervalMs - now);
        if (wait <= 0) break;
        await sleep(wait);
      }
      this.lastAt = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  recordError(status: number): void {
    const now = Date.now();
    this.errors = this.errors.filter((time) => now - time < this.windowMs);
    this.errors.push(now);

    if (status === 429) {
      // AIMD: снижаем QPS (увеличиваем интервал) и делаем короткую паузу
      this.intervalMs = Math.min(this.intervalMs * 2, this.minIntervalMsLimit);
      this.pauseUntil = Math.max(this.pauseUntil, now + Math.min(this.intervalMs, 30_000));
    }

    if (this.errors.length >= this.errorThreshold) {
      // предохранитель: полная пауза
      this.pauseUntil = Math.max(this.pauseUntil, now + this.cooldownMs);
      this.errors = [];
    }
  }

  recordSuccess(): void {
    if (this.intervalMs > this.baseIntervalMs) {
      this.intervalMs = Math.max(this.baseIntervalMs, Math.floor(this.intervalMs * 0.9));
    }
  }
}
