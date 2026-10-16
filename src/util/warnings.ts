/**
 * Подавление шумных экспериментальных предупреждений Node (в частности node:sqlite).
 *
 * Важно: этот модуль должен импортироваться в cli.ts ПЕРВЫМ, до модулей, которые
 * загружают node:sqlite, иначе предупреждение успеет напечататься.
 */
process.removeAllListeners('warning');
process.on('warning', (warning: Error & { name: string }) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
    return;
  }
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
