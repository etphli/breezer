import test from 'node:test';
import assert from 'node:assert/strict';
import { validateItem } from '../../features/ai/host/organato.mjs';

test('invalid calendar deadlines show the validation message on create and update', () => {
  for (const item of [{ kind: 'todo', displayName: 'Study' }, { id: 'item', version: 1 }]) {
    for (const dueDateLocal of ['2026-13-01', '2026-00-01', '2026-01-00', '2026-01-32', '2026-02-30', '2026-02-29', '2026-2-01']) {
      assert.throws(() => validateItem({ ...item, dueDateLocal }, 'id' in item), {
        name: 'Error',
        message: 'Use a valid YYYY-MM-DD deadline.',
      });
    }
  }
});

test('a valid leap-day deadline is preserved as a date string', () => {
  const item = { kind: 'todo', displayName: 'Study', dueDateLocal: '2028-02-29' };
  assert.deepEqual(validateItem(item), item);
});
