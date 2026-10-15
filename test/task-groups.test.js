import test from 'node:test';
import assert from 'node:assert/strict';
import { failureItem, folderTaskKey, resultStats } from '../task-groups.js';

test('folder task keys keep different destinations separate', () => {
  const base = { operation: 'copy', bucket: 'source', prefix: 'release/' };
  assert.equal(folderTaskKey({ ...base, targetBucket: 'target-a', targetPrefix: 'site/' }) !== folderTaskKey({ ...base, targetBucket: 'target-b', targetPrefix: 'site/' }), true);
  assert.equal(folderTaskKey({ ...base, targetBucket: 'target-a', targetPrefix: 'site/' }), folderTaskKey({ ...base, targetBucket: 'target-a', targetPrefix: 'site/' }));
});

test('result stats and failure details include partial move failures', () => {
  const results = [
    { key: 'ok.txt', state: 'success' },
    { key: 'same.txt', state: 'skipped' },
    { key: 'kept.txt', target: 'copy/kept.txt', state: 'copied_source_kept', error: { code: 'AccessDenied', message: 'delete denied', requestId: 'req-1' } },
    { key: 'waiting.txt', state: 'running' }
  ];
  assert.deepEqual(resultStats(results), { total: 4, completed: 1, skipped: 1, failed: 1, pending: 1 });
  assert.deepEqual(failureItem(results[2]), { object: 'kept.txt', target: 'copy/kept.txt', state: 'copied_source_kept', error: results[2].error });
  assert.equal(failureItem(results[0]), null);
});
