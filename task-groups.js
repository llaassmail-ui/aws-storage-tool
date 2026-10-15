export function folderTaskKey({ operation, bucket, prefix = '', targetBucket = '', targetPrefix = '' }) {
  return [operation, bucket, prefix, targetBucket, targetPrefix].map(value => String(value || '')).join('\u0000');
}

export function resultStats(results = []) {
  const stats = { total: results.length, completed: 0, skipped: 0, failed: 0, pending: 0 };
  for (const result of results) {
    if (result.state === 'skipped') stats.skipped++;
    else if (result.error || ['failed', 'copied_source_kept', 'cancelled'].includes(result.state)) stats.failed++;
    else if (['success', 'completed'].includes(result.state)) stats.completed++;
    else stats.pending++;
  }
  return stats;
}

export function failureItem(result) {
  if (!result || (!result.error && !['failed', 'copied_source_kept', 'cancelled'].includes(result.state))) return null;
  return {
    object: result.key || result.object || '',
    target: result.target || '',
    state: result.state || 'failed',
    error: result.error || { message: '操作未完成' }
  };
}
