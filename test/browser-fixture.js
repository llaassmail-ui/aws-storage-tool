// Explicit mock for browser validation; production does not load this module.
import { createServer } from '../server.js';
const server = createServer(() => ({
  buckets: async () => [{ name: 'browser-test-bucket', region: 'ap-south-1' }],
  distributionList: async () => [{ id: 'DEMO123', domain: 'demo.cloudfront.net', aliases: ['demo.example.com'], enabled: true }],
  list: async (_, prefix = '') => ({ region: 'ap-south-1', token: null, folders: prefix ? [] : [{ key: '目录/', folder: true }], files: [{ key: prefix + '中文 空格"#.txt', size: 1024, modified: new Date().toISOString() }] }),
  snapshot: async (_, selected) => selected.flatMap(x => x.folder ? [{ key: x.key + 'file.txt' }, { key: x.key + 'denied.txt' }] : [{ key: x.key }]),
  head: async () => null,
  copy: async (_, key) => { if (key.endsWith('denied.txt')) throw Object.assign(new Error('Simulated copy permission denied'), { name: 'AccessDenied', $metadata: { requestId: 'mock-request-1' } }); },
  remove: async () => {}, close: async () => {},
  upload: async (_, key, stream, size, type, progress) => { let n = 0; for await (const chunk of stream) { n += chunk.length; progress(n); } },
  invalidate: async () => ({ Invalidation: { Id: 'TEST-INVALIDATION', Status: 'InProgress' } }),
  invalidation: async () => ({ Invalidation: { Id: 'TEST-INVALIDATION', Status: 'Completed' } })
}));
server.listen(8789, '127.0.0.1', () => console.log('SIMULATED AWS ONLY http://127.0.0.1:8789'));
