import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProgressReporter } from '../src/util/progress.js';

test('ProgressReporter (TTY): строка прогресса и постоянные строки', () => {
  const out: string[] = [];
  let t = 0;
  const reporter = new ProgressReporter('dl', {
    write: (text) => out.push(text),
    isTTY: true,
    now: () => t,
  });
  reporter.setTotals({ items: 2, bytes: 200 });
  reporter.info('↓ a.txt');
  reporter.setCurrent('a.txt', 100);
  t = 1000;
  reporter.currentProgress(50);
  reporter.addBytes(50);
  reporter.incItems(1);
  reporter.clearCurrent();
  reporter.finish();

  const all = out.join('');
  assert.match(all, /↓ a\.txt/);
  assert.match(all, /Всего:/);
  assert.ok(all.includes('\r'));
});

test('ProgressReporter (quiet): info подавляется, warn пишется', () => {
  const out: string[] = [];
  const reporter = new ProgressReporter('dl', {
    write: (text) => out.push(text),
    isTTY: false,
    quiet: true,
  });
  reporter.info('скрыто');
  reporter.setCurrent('x', 1);
  reporter.warn('ошибка');
  const all = out.join('');
  assert.ok(!all.includes('скрыто'));
  assert.ok(all.includes('ошибка'));
});

test('ProgressReporter: fileSink получает строки', () => {
  const file: string[] = [];
  const reporter = new ProgressReporter('dl', {
    write: () => {},
    isTTY: false,
    fileSink: (line) => file.push(line),
  });
  reporter.info('hello');
  reporter.snapshot();
  assert.ok(file.some((line) => line.includes('hello')));
  assert.ok(file.some((line) => line.includes('Всего:')));
});

test('ProgressReporter: heartbeat при простое', () => {
  const out: string[] = [];
  let t = 0;
  const reporter = new ProgressReporter('dl', {
    write: (text) => out.push(text),
    isTTY: false,
    now: () => t,
  });
  t = 20_000;
  reporter.heartbeat();
  assert.ok(out.join('').includes('ожидание данных'));
});

test('ProgressReporter: rateMode=items показывает шт/с и activity', () => {
  const out: string[] = [];
  let t = 0;
  const reporter = new ProgressReporter('scan', {
    write: (text) => out.push(text),
    isTTY: false,
    now: () => t,
    rateMode: 'items',
  });
  reporter.setTotals({ items: 10 });
  reporter.setActivity('сканирую disk:/foo');
  t = 6000;
  reporter.incItems(5);
  const all = out.join('');
  assert.ok(all.includes('шт/с'));
  assert.ok(all.includes('сканирую disk:/foo'));
});

test('ProgressReporter: агрегатный режим (активных N)', () => {
  const out: string[] = [];
  let t = 0;
  const reporter = new ProgressReporter('download', {
    write: (text) => out.push(text),
    isTTY: false,
    now: () => t,
  });
  reporter.setActive(3);
  t = 6000;
  reporter.incItems(1);
  assert.ok(out.join('').includes('активных 3'));
});

test('ProgressReporter: ETA появляется только при реальном потоке', () => {
  const out: string[] = [];
  let t = 0;
  const reporter = new ProgressReporter('download', {
    write: (text) => out.push(text),
    isTTY: false,
    now: () => t,
    plainIntervalMs: 1,
    rateWindowMs: 60_000,
  });
  reporter.setTotals({ bytes: 2000, items: 2 });
  reporter.setCurrent('f.bin', 2000);
  reporter.currentProgress(0);
  t = 2000;
  reporter.currentProgress(500);
  t = 4000;
  reporter.currentProgress(1000);
  assert.ok(out.join('').includes('ETA'));

  // Без потока (все сэмплы равны) ETA не показывается.
  const out2: string[] = [];
  let t2 = 0;
  const reporter2 = new ProgressReporter('download', {
    write: (text) => out2.push(text),
    isTTY: false,
    now: () => t2,
    plainIntervalMs: 1,
  });
  reporter2.setTotals({ bytes: 1000 });
  reporter2.setCurrent('f.bin', 1000);
  t2 = 1000;
  reporter2.currentProgress(0);
  t2 = 2000;
  reporter2.currentProgress(0);
  assert.ok(!out2.join('').includes('ETA'));
});
