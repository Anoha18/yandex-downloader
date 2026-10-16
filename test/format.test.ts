import assert from 'node:assert/strict';
import { test } from 'node:test';

import { humanBytes, humanDuration, humanRate } from '../src/util/format.js';

test('humanBytes: базовые единицы', () => {
  assert.equal(humanBytes(0), '0 Б');
  assert.equal(humanBytes(1024), '1.00 КБ');
  assert.equal(humanBytes(1536), '1.50 КБ');
});

test('humanRate: скорость', () => {
  assert.match(humanRate(1048576), /\/с$/);
  assert.equal(humanRate(0), '—/с');
});

test('humanDuration: секунды/минуты/часы', () => {
  assert.equal(humanDuration(45), '45с');
  assert.equal(humanDuration(130), '2м 10с');
  assert.equal(humanDuration(3900), '1ч 05м');
});
