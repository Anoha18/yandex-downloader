import { FileLog } from '../util/fileLog.js';
import { ProgressReporter } from '../util/progress.js';
import type { CommandContext } from './types.js';

export interface CommandProgress {
  reporter: ProgressReporter;
  stop: () => void;
}

/**
 * Создаёт отчётчик прогресса для команды: reporter + файловый лог
 * (data/logs/<name>.log) + таймеры heartbeat/snapshot. Обязательно вызвать stop().
 */
export function createProgress(
  ctx: CommandContext,
  name: string,
  options: { label?: string; rateMode?: 'bytes' | 'items' } = {},
): CommandProgress {
  const fileLog = new FileLog(ctx.config.logDir, `${name}.log`);
  const reporter = new ProgressReporter(options.label ?? name, {
    fileSink: (line) => fileLog.write(line),
    quiet: ctx.flags.quiet,
    rateMode: options.rateMode,
  });
  const heartbeat = setInterval(() => reporter.heartbeat(), 5_000);
  const snapshot = setInterval(() => reporter.snapshot(), 30_000);

  const stop = (): void => {
    clearInterval(heartbeat);
    clearInterval(snapshot);
    reporter.finish();
    fileLog.close();
  };

  return { reporter, stop };
}
