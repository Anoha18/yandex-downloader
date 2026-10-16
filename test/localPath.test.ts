import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PathAllocator,
  resolveLocalPath,
  sanitizeSegment,
  withSuffix,
} from '../src/download/localPath.js';

test('sanitizeSegment: недопустимые символы и зарезервированные имена', () => {
  assert.equal(sanitizeSegment('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(sanitizeSegment('trailing. '), 'trailing');
  assert.equal(sanitizeSegment('..'), '_');
  assert.equal(sanitizeSegment('CON.txt'), '_CON.txt');
  assert.equal(sanitizeSegment(''), '_');
});

test('resolveLocalPath: сохраняет структуру и не выпускает за папку', () => {
  assert.equal(resolveLocalPath('/dl', 'disk:/foo/../../bar.txt'), '/dl/foo/bar.txt');
  assert.equal(resolveLocalPath('/dl', 'disk:/Год/файл.txt'), '/dl/Год/файл.txt');
});

test('withSuffix: суффикс перед расширением', () => {
  assert.equal(withSuffix('/dl/file.txt', 2), '/dl/file (2).txt');
  assert.equal(withSuffix('/dl/dir', 1), '/dl/dir (1)');
});

test('PathAllocator: один путь → один результат, разные коллизии → суффикс', () => {
  const allocator = new PathAllocator('/dl');
  // Повторная выдача того же пути Диска идемпотентна (чтобы докачивать тот же .part).
  assert.equal(allocator.allocate('disk:/x/y.txt'), '/dl/x/y.txt');
  assert.equal(allocator.allocate('disk:/x/y.txt'), '/dl/x/y.txt');
  // Разные пути, санитайзинг которых совпал, получают суффикс.
  assert.equal(allocator.allocate('disk:/x/co:n.txt'), '/dl/x/co_n.txt');
  assert.equal(allocator.allocate('disk:/x/co_n.txt'), '/dl/x/co_n (1).txt');
});
