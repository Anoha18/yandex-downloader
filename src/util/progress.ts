import { humanBytes, humanDuration, humanRate } from './format.js';

export interface ProgressOptions {
  /** Куда писать (по умолчанию stderr). */
  write?: (text: string) => void;
  isTTY?: boolean;
  now?: () => number;
  /** Дублирование строк в файл лога. */
  fileSink?: (line: string) => void;
  /** Только ошибки и итог (без живого прогресса). */
  quiet?: boolean;
  /** Чем измерять скорость: байтами (по умолчанию) или элементами. */
  rateMode?: 'bytes' | 'items';
  /** Окно усреднения скорости, мс (по умолчанию 60с). */
  rateWindowMs?: number;
  ttyIntervalMs?: number;
  plainIntervalMs?: number;
  heartbeatMs?: number;
}

const CURRENT_NAME_MAX = 60;
const MIN_RATE_SPAN_MS = 1000;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `…${value.slice(-(max - 1))}`;
}

interface Sample {
  t: number;
  value: number;
}

/**
 * Отчётчик прогресса для длительных команд.
 *
 * В TTY рисует одну обновляемую строку, вне TTY — периодические строки. Каждый
 * апдейт пишется ОДНИМ вызовом write (очистка + сообщение/строка), поэтому при
 * нескольких воркерах строки не склеиваются. Скорость считается по скользящему
 * окну (recent throughput), поэтому долгие ретраи/простои не «размазывают» её в
 * ноль; ETA показывается только при непустом окне.
 */
export class ProgressReporter {
  private bytes = 0;
  private items = 0;
  private totalBytes: number | undefined;
  private totalItems: number | undefined;

  private currentName: string | undefined;
  private currentWritten = 0;
  private currentTotal: number | undefined;
  private activity: string | undefined;
  private activeCount: number | undefined;
  /** Мульти-режим: прогресс активных файлов по ключам воркеров. */
  private readonly activeFiles = new Map<
    string,
    { name: string; written: number; total?: number }
  >();

  private readonly rateWindowMs: number;
  private samples: Sample[] = [];
  private lastRenderAt = 0;
  private lastProgressAt: number;
  private lastLineLength = 0;
  private live = false;

  constructor(
    private readonly label: string,
    private readonly options: ProgressOptions = {},
  ) {
    this.lastProgressAt = this.now();
    this.rateWindowMs = options.rateWindowMs ?? 60_000;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private write(text: string): void {
    if (text.length === 0) return;
    (this.options.write ?? ((chunk: string) => process.stderr.write(chunk)))(text);
  }

  private get tty(): boolean {
    return this.options.isTTY ?? Boolean(process.stderr.isTTY);
  }

  private get quiet(): boolean {
    return this.options.quiet ?? false;
  }

  private get itemsMode(): boolean {
    return (this.options.rateMode ?? 'bytes') === 'items';
  }

  setTotals(totals: { bytes?: number; items?: number }): void {
    if (totals.bytes !== undefined) this.totalBytes = totals.bytes;
    if (totals.items !== undefined) this.totalItems = totals.items;
  }

  /** Сбрасывает счётчики (например, при переходе от файлов к фото). */
  resetTotals(): void {
    this.bytes = 0;
    this.items = 0;
    this.totalBytes = undefined;
    this.totalItems = undefined;
    this.activity = undefined;
    this.activeCount = undefined;
    this.activeFiles.clear();
    this.samples = [];
    this.clearCurrent();
  }

  /** Число активных задач (для агрегатной строки при конкурентности). */
  setActive(count: number | undefined): void {
    this.activeCount = count;
    this.touch();
    this.maybeRender();
  }

  /** Мульти-режим: воркер начал файл. */
  beginFile(key: string, name: string, total?: number): void {
    this.activeFiles.set(key, { name, written: 0, total });
    this.touch();
    this.recordSample();
    this.maybeRender();
  }

  /** Мульти-режим: сколько байт записано в файле воркера. */
  updateFile(key: string, written: number): void {
    const file = this.activeFiles.get(key);
    if (!file) return;
    file.written = written;
    this.touch();
    this.recordSample();
    this.maybeRender();
  }

  /** Мульти-режим: воркер закончил файл. */
  endFile(key: string): void {
    this.activeFiles.delete(key);
  }

  setCurrent(name: string, total?: number): void {
    this.currentName = name;
    this.currentWritten = 0;
    this.currentTotal = total;
    this.touch();
    this.maybeRender();
  }

  currentProgress(written: number): void {
    this.currentWritten = written;
    this.touch();
    this.recordSample();
    this.maybeRender();
  }

  clearCurrent(): void {
    this.currentName = undefined;
    this.currentWritten = 0;
    this.currentTotal = undefined;
  }

  /** Текущее «занятие» (например, сканируемая папка) без процентов. */
  setActivity(text: string): void {
    this.activity = text;
    this.touch();
    this.maybeRender();
  }

  clearActivity(): void {
    this.activity = undefined;
  }

  addBytes(n: number): void {
    if (n > 0) this.bytes += n;
    this.recordSample();
  }

  incItems(n = 1): void {
    this.items += n;
    this.touch();
    this.recordSample();
    this.maybeRender();
  }

  /** Постоянная строка (не перетирается прогрессом). В quiet подавляется. */
  info(message: string): void {
    if (!this.quiet) {
      const tail = this.tty ? this.liveSeq() : '';
      this.write(`${this.clearSeq()}${message}\n${tail}`);
    }
    this.options.fileSink?.(message);
  }

  warn(message: string): void {
    const tail = this.tty ? this.liveSeq() : '';
    this.write(`${this.clearSeq()}⚠ ${message}\n${tail}`);
    this.options.fileSink?.(`⚠ ${message}`);
  }

  /** Записать текущую строку прогресса только в файл лога. */
  snapshot(): void {
    this.options.fileSink?.(this.line());
  }

  /** Сообщить о простое, если давно не было прогресса. */
  heartbeat(): void {
    const idleMs = this.now() - this.lastProgressAt;
    const threshold = this.options.heartbeatMs ?? 15_000;
    if (idleMs >= threshold) {
      this.info(`… ожидание данных (${humanDuration(idleMs / 1000)})`);
    }
  }

  finish(): void {
    this.write(this.clearSeq());
    this.live = false;
  }

  private touch(): void {
    this.lastProgressAt = this.now();
  }

  /** Текущее «прошедшее» значение для расчёта скорости (учитывает активные файлы). */
  private currentValue(): number {
    if (this.itemsMode) return this.items;
    if (this.currentName !== undefined) return this.bytes + this.currentWritten;
    let active = 0;
    for (const file of this.activeFiles.values()) active += file.written;
    return this.bytes + active;
  }

  private recordSample(): void {
    const now = this.now();
    this.samples.push({ t: now, value: this.currentValue() });
    const cutoff = now - this.rateWindowMs;
    // Оставляем один «якорный» сэмпл чуть старше окна, чтобы измерять на границе.
    while (this.samples.length > 2 && (this.samples[1]?.t ?? 0) < cutoff) {
      this.samples.shift();
    }
  }

  /** Недавняя скорость (за окно), 0 — если потока не было. */
  private recentRate(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0] as Sample;
    const last = this.samples[this.samples.length - 1] as Sample;
    const spanMs = last.t - first.t;
    if (spanMs < MIN_RATE_SPAN_MS) return 0;
    const delta = last.value - first.value;
    if (delta <= 0) return 0;
    return delta / (spanMs / 1000);
  }

  private maybeRender(): void {
    const interval = this.tty
      ? (this.options.ttyIntervalMs ?? 200)
      : (this.options.plainIntervalMs ?? 5000);
    if (this.now() - this.lastRenderAt < interval) return;
    this.write(this.liveSeq());
  }

  /** Последовательность очистки текущей живой строки (одним куском). */
  private clearSeq(): string {
    if (!this.tty || !this.live || this.lastLineLength === 0) return '';
    return `\r${' '.repeat(this.lastLineLength)}\r`;
  }

  /** Последовательность отрисовки живой строки (или '' вне TTY/в quiet). */
  private liveSeq(): string {
    if (this.quiet) return '';
    const line = this.line();
    this.lastRenderAt = this.now();
    if (this.tty) {
      const pad = ' '.repeat(Math.max(0, this.lastLineLength - line.length));
      this.lastLineLength = line.length;
      this.live = true;
      return `\r${line}${pad}`;
    }
    this.live = false;
    return `${line}\n`;
  }

  private line(): string {
    const parts: string[] = [];

    if (this.activity) parts.push(this.activity);

    if (this.currentName) {
      const name = truncate(this.currentName, CURRENT_NAME_MAX);
      const written = humanBytes(this.currentWritten);
      const total = this.currentTotal !== undefined ? humanBytes(this.currentTotal) : '?';
      const percent =
        this.currentTotal && this.currentTotal > 0
          ? ` (${Math.floor((this.currentWritten / this.currentTotal) * 100)}%)`
          : '';
      parts.push(`↓ ${name} ${written}/${total}${percent}`);
    }

    if (this.activeFiles.size > 0) {
      let written = 0;
      let total = 0;
      let unknownTotal = false;
      for (const file of this.activeFiles.values()) {
        written += file.written;
        if (file.total !== undefined) total += file.total;
        else unknownTotal = true;
      }
      const totalText = unknownTotal || total <= 0 ? '' : `/${humanBytes(total)}`;
      parts.push(`активных ${this.activeFiles.size} | ${humanBytes(written)}${totalText}`);
    } else if (this.activeCount !== undefined && this.activeCount > 0) {
      parts.push(`активных ${this.activeCount}`);
    }

    const rate = this.recentRate();
    const rateText = this.itemsMode ? `${rate.toFixed(1)} шт/с` : humanRate(rate);

    const itemsPart =
      this.totalItems !== undefined ? `${this.items}/${this.totalItems}` : String(this.items);
    const doneBytes = this.itemsMode ? this.bytes : this.currentValue();
    const bytesPart =
      this.totalBytes !== undefined
        ? `${humanBytes(doneBytes)}/${humanBytes(this.totalBytes)}`
        : humanBytes(doneBytes);
    parts.push(`Всего: ${itemsPart}, ${bytesPart}, ${rateText}`);

    const remaining = this.totalBytes !== undefined ? this.totalBytes - doneBytes : undefined;
    if (remaining !== undefined && remaining > 0 && rate > 0) {
      parts.push(`ETA ${humanDuration(remaining / rate)}`);
    }

    return `${this.label}: ${parts.join(' | ')}`;
  }
}
