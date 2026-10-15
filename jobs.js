import { randomUUID } from 'node:crypto';
import { errorInfo } from './aws.js';

export function validateSelection(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10000) throw new Error('请选择 1–10000 个项目');
  for (const x of input) if (typeof x.key !== 'string' || !x.key || Buffer.byteLength(x.key) > 1024 || typeof x.folder !== 'boolean' || (x.folder && !x.key.endsWith('/'))) throw new Error('无效的对象路径');
  return input.filter((x, i) => !input.some((p, j) => j !== i && p.folder && x.key.startsWith(p.key) && (p.key !== x.key || j < i)));
}
export function destination(item, selected, targetPrefix) {
  const root = selected.find(x => x.folder && item.key.startsWith(x.key)) || selected.find(x => x.key === item.key);
  if (!root) throw new Error('对象不属于选中清单');
  const trimmed = root.folder ? root.key.slice(0, -1) : root.key;
  const parent = trimmed.lastIndexOf('/') + 1;
  return targetPrefix + item.key.slice(parent);
}
export function validateTargets(body, selected) {
  if (!['copy', 'move', 'delete'].includes(body.action)) throw new Error('无效操作');
  if (body.action === 'delete') return;
  if (!body.targetBucket || typeof body.targetPrefix !== 'string' || (body.targetPrefix && !body.targetPrefix.endsWith('/'))) throw new Error('目标目录必须以 / 结尾');
  if (body.bucket === body.targetBucket) for (const root of selected) {
    const target = destination(root, selected, body.targetPrefix);
    if (target === root.key || (root.folder && target.startsWith(root.key))) throw new Error('不能操作到原路径或源文件夹的子目录');
  }
}
export function newJob(type) {
  return { id: randomUUID(), type, state: 'preparing', total: 0, done: 0, results: [], created: Date.now(), controller: new AbortController() };
}
export function publicJob(job) { const { controller, ...data } = job; return data; }
export async function runBatch(aws, body, job) {
  try {
    const selected = validateSelection(body.selected); validateTargets(body, selected);
    const objects = await aws.snapshot(body.bucket, selected);
    job.total = objects.length;
    const targets = new Set();
    if (body.action !== 'delete') for (const item of objects) {
      const target = destination(item, selected, body.targetPrefix);
      if (targets.has(target)) throw new Error('选中项目在目标目录产生重名，请分开操作');
      targets.add(target);
      if (body.bucket === body.targetBucket && objects.some(o => o.key === target)) throw new Error('目标覆盖源清单中的对象，请选择其他目录');
    }
    job.state = 'running';
    for (const item of objects) {
      if (job.controller.signal.aborted) break;
      let copied = false; let target;
      job.current = item.key;
      try {
        if (body.action !== 'delete') {
          target = destination(item, selected, body.targetPrefix);
          if (!body.overwrite && await aws.head(body.targetBucket, target)) {
            job.results.push({ key: item.key, target, state: 'skipped' }); job.done++; continue;
          }
          await aws.copy(body.bucket, item.key, body.targetBucket, target); copied = true;
        }
        if (job.controller.signal.aborted) {
          job.results.push({ key: item.key, target, state: copied ? 'copied_source_kept' : 'cancelled' }); job.done++; break;
        }
        if (body.action !== 'copy') await aws.remove(body.bucket, item.key);
        job.results.push({ key: item.key, target, state: 'success' });
      } catch (e) {
        const completed = copied || e.copyCompleted === true;
        job.results.push({ key: item.key, target, state: completed ? 'copied_source_kept' : 'failed', error: errorInfo(e, body.action, item.key) });
      }
      job.done++;
    }
    job.state = job.controller.signal.aborted ? 'cancelled' : job.results.some(x => x.error) ? 'partial' : 'completed';
  } catch (error) { job.state = 'failed'; job.error = errorInfo(error, body.action, body.bucket); }
}
