import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { findProjectRoot } from '../src/util/paths.js';

const root = findProjectRoot();
const cliPath = join(root, 'src', 'cli.ts');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('cli: --help показывает список команд и завершается с кодом 0', () => {
  const { status, stdout } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /auth/);
  assert.match(stdout, /config/);
});

test('cli: --version печатает версию', () => {
  const { status, stdout } = runCli(['--version']);
  assert.equal(status, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('cli: config path печатает путь к конфигу', () => {
  const { status, stdout } = runCli(['config', 'path']);
  assert.equal(status, 0);
  assert.match(stdout.trim(), /data\/config\.json$/);
});

test('cli: config show печатает валидный JSON', () => {
  const { status, stdout } = runCli(['config', 'show']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as { downloadDir: string; profile: string };
  assert.ok(parsed.downloadDir.length > 0);
  assert.ok(['gentle', 'normal', 'fast'].includes(parsed.profile));
});

test('cli: неизвестная команда завершается с кодом 2 и понятной ошибкой', () => {
  const { status, stderr } = runCli(['definitely-not-a-command']);
  assert.equal(status, 2);
  assert.match(stderr, /Неизвестная команда/);
});

test('cli: auth с некорректным кодом завершается с кодом 2', () => {
  const { status, stderr } = runCli(['auth', '123']);
  assert.equal(status, 2);
  assert.ok(stderr.trim().length > 0);
});
