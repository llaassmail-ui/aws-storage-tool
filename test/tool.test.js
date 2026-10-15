import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWS, normalizeDomain, matchDistributions, invalidationPaths } from '../aws.js';
import { destination, validateSelection, validateTargets, newJob, runBatch } from '../jobs.js';
import { createServer } from '../server.js';

test('domain normalization, exact priority, wildcard and invalidation validation', () => {
  assert.equal(normalizeDomain('https://EXAMPLE.com/a?q=1'), 'example.com');
  const ds = [{ id: 'A', domain: 'a.cloudfront.net', aliases: ['*.example.com'] }, { id: 'B', domain: 'b.cloudfront.net', aliases: ['www.example.com'] }];
  assert.equal(matchDistributions(ds, 'www.example.com')[0].id, 'B');
  assert.equal(matchDistributions(ds, 'x.example.com')[0].id, 'A');
  assert.equal(matchDistributions(ds, 'example.com').length, 0);
  assert.deepEqual(invalidationPaths('/a\n/a\n/*'), ['/a', '/*']);
  for (const p of ['', 'abc', '/a#b', '/a*/b', '/**']) assert.throws(() => invalidationPaths(p));
});
test('recursive destination and source protection with unusual names', () => {
  const selected = validateSelection([{ key: 'a/中文 #"/', folder: true }, { key: 'a/中文 #"/nested/file', folder: false }]);
  assert.equal(selected.length, 1);
  assert.equal(destination({ key: 'a/中文 #"/nested/file' }, selected, 'out/'), 'out/中文 #"/nested/file');
  for (const prefix of ['a/', 'a/中文 #"/child/']) assert.throws(() => validateTargets({ action: 'copy', bucket: 'a', targetBucket: 'a', targetPrefix: prefix }, selected));
});
test('move only deletes after copy succeeds, reports source deletion failure and skips', async () => {
  const deleted = [];
  const aws = { snapshot: async () => ['bad', 'keep', 'skip', 'ok'].map(key => ({ key })), head: async (_, k) => k === 'skip' ? {} : null,
    copy: async (_, k) => { if (k === 'bad') throw new Error('copy denied'); }, remove: async (_, k) => { deleted.push(k); if (k === 'keep') throw new Error('delete denied'); } };
  const job = newJob('move'); await runBatch(aws, { action: 'move', bucket: 'source', targetBucket: 'target', targetPrefix: '', selected: ['bad', 'keep', 'skip', 'ok'].map(key => ({ key, folder: false })) }, job);
  assert.deepEqual(deleted, ['keep', 'ok']); assert.deepEqual(job.results.map(r => r.state), ['failed', 'copied_source_kept', 'skipped', 'success']); assert.equal(job.state, 'partial');
});
test('copy makes destination public-read and marks ACL failures as copied', async () => {
  const aws = new AWS({ accessKeyId: 'test', secretAccessKey: 'test' });
  aws.regions.set('source', 'us-east-1'); aws.regions.set('target', 'us-east-1');
  aws.head = async () => ({ ContentLength: 10, ETag: '"etag"', VersionId: 'v1' });
  const order = [];
  aws.send = async (_, command) => {
    const name = command.constructor.name; order.push(name);
    if (name === 'PutObjectAclCommand') assert.equal(command.input.ACL, 'public-read');
    return {};
  };
  await aws.copy('source', 'dir/a.txt', 'target', 'copy/a.txt');
  assert.deepEqual(order, ['CopyObjectCommand', 'PutObjectAclCommand']);
  await aws.close();

  const failed = new AWS({ accessKeyId: 'test', secretAccessKey: 'test' });
  failed.regions.set('source', 'us-east-1'); failed.regions.set('target', 'us-east-1'); failed.head = async () => ({ ContentLength: 1, ETag: 'e' });
  failed.send = async (_, command) => { if (command.constructor.name === 'PutObjectAclCommand') throw Object.assign(new Error('ACL disabled'), { name: 'AccessControlListNotSupported' }); return {}; };
  await assert.rejects(failed.copy('source', 'a', 'target', 'b'), error => error.copyCompleted === true);
  await failed.close();
});
test('createFolder writes a directory marker and rejects unsafe keys', async () => {
  const aws = new AWS({ accessKeyId: 'test', secretAccessKey: 'test' }); aws.regions.set('demo', 'ap-south-1');
  let input; aws.send = async (_, command) => { input = command.input; return {}; };
  await aws.createFolder('demo', '中文/new folder/');
  assert.deepEqual(input, { Bucket: 'demo', Key: '中文/new folder/', Body: '', ContentLength: 0, ContentType: 'application/x-directory' });
  for (const key of ['', '/root/', 'a//b/', 'x'.repeat(1024) + '/']) await assert.rejects(aws.createFolder('demo', key));
  await aws.close();
});
test('move never deletes source when ACL application failed after destination copy', async () => {
  let deleted = false;
  const job = newJob('move'); await runBatch({ snapshot: async () => [{ key: 'a' }], head: async () => null,
    copy: async () => { throw Object.assign(new Error('ACL disabled'), { copyCompleted: true }); }, remove: async () => { deleted = true; } },
  { action: 'move', bucket: 'source', targetBucket: 'target', targetPrefix: '', selected: [{ key: 'a', folder: false }] }, job);
  assert.equal(deleted, false); assert.equal(job.results[0].state, 'copied_source_kept'); assert.equal(job.state, 'partial');
});
test('cancellation after copy keeps source', async () => {
  const job = newJob('move'); let deleted = false;
  await runBatch({ snapshot: async () => [{ key: 'x' }], head: async () => null, copy: async () => job.controller.abort(), remove: async () => { deleted = true; } }, { action: 'move', bucket: 'a', targetBucket: 'b', targetPrefix: '', selected: [{ key: 'x', folder: false }] }, job);
  assert.equal(deleted, false); assert.equal(job.state, 'cancelled');
});
test('SDK pagination covers buckets, recursive objects and CloudFront', async () => {
  const aws = new AWS({ accessKeyId: 'test', secretAccessKey: 'test' }); const counts = {};
  aws.send = async (_, cmd) => {
    const name = cmd.constructor.name; counts[name] = (counts[name] || 0) + 1;
    if (name === 'ListBucketsCommand') return { Buckets: [{ Name: `b${counts[name]}`, BucketRegion: 'ap-south-1' }], ContinuationToken: counts[name] === 1 ? 'next' : undefined };
    if (name === 'ListObjectsV2Command') return { Contents: Array.from({ length: counts[name] === 1 ? 1000 : 2 }, (_, n) => ({ Key: `dir/${counts[name]}/${n}` })), IsTruncated: counts[name] === 1, NextContinuationToken: counts[name] === 1 ? 'next' : undefined };
    if (name === 'ListDistributionsCommand') return { DistributionList: { Items: [{ Id: String(counts[name]), DomainName: 'a', Aliases: {} }], IsTruncated: counts[name] === 1, NextMarker: counts[name] === 1 ? 'next' : undefined } };
    throw new Error(name);
  };
  assert.equal((await aws.buckets()).length, 2); assert.equal(await aws.region('b1'), 'ap-south-1');
  assert.equal((await aws.snapshot('b1', [{ key: 'dir/', folder: true }])).length, 1002); assert.equal((await aws.distributionList()).length, 2); await aws.close();
});
test('HTTP security, independent permissions, upload failures and invalidation reference', async t => {
  let creds, reference;
  const fake = { buckets: async () => [{ name: 'demo' }], distributionList: async () => { throw Object.assign(new Error('not allowed'), { name: 'AccessDenied' }); }, close: async () => {}, head: async () => null,
    upload: async () => { throw Object.assign(new Error('ACL disabled'), { name: 'AccessControlListNotSupported' }); }, invalidate: async (_, paths, ref) => { reference = ref; return { Invalidation: { Id: 'I1', Status: 'InProgress' } }; } };
  const server = createServer(c => { creds = c; return fake; }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`; let cookie = '';
  const request = (path, data, headers = {}) => fetch(origin + path, { method: data ? 'POST' : 'GET', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await request('/api/session')).status, 401);
  const module = await request('/task-groups.js');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.match(await module.text(), /export function folderTaskKey/);
  assert.equal((await request('/api/connect', {}, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('/api/connect', {})).status, 400);
  const connected = await request('/api/connect', { accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'T' }); cookie = connected.headers.get('set-cookie').split(';')[0];
  assert.match(connected.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); assert.equal(creds.sessionToken, 'T');
  await new Promise(r => setTimeout(r, 10)); const session = await (await request('/api/session')).json();
  assert.equal(session.checks.s3.state, 'available'); assert.equal(session.checks.cf.state, 'denied'); assert.equal(session.buckets[0].name, 'demo');
  const upload = await (await request('/api/uploads', { bucket: 'demo', key: 'a', size: 3 })).json();
  const outcome = await (await fetch(`${origin}/api/uploads/${upload.id}`, { method: 'PUT', headers: { Origin: origin, Cookie: cookie }, body: 'abc' })).json();
  assert.equal(outcome.state, 'failed'); assert.equal(outcome.error.code, 'AccessControlListNotSupported');
  const result = await (await request('/api/invalidations', { id: 'D1', paths: '/*', reference: 'stable-reference-123' })).json();
  assert.equal(result.Status, 'InProgress'); assert.equal(reference, 'stable-reference-123');
  await request('/api/disconnect', {}); assert.equal((await request('/api/session')).status, 401);
});

test('folder HTTP route creates the exact marker and preserves AWS errors', async t => {
  const calls = [];
  const server = createServer(() => ({
    buckets: async () => [], distributionList: async () => [], close: async () => {},
    createFolder: async (bucket, key) => {
      calls.push({ bucket, key });
      if (key === 'denied/') throw Object.assign(new Error('Write denied'), { name: 'AccessDenied', $metadata: { requestId: 'folder-request' } });
    }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const post = (path, value) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const login = await post('/api/connect', { accessKeyId: 'mock', secretAccessKey: 'mock' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const marker = { bucket: 'test-bucket', key: 'server/packagep/02/' };
  const response = await post('/api/folders', marker);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), marker);
  assert.deepEqual(calls, [marker]);
  const invalid = await post('/api/folders', { bucket: 'test-bucket' });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 1);
  const denied = await post('/api/folders', { bucket: 'test-bucket', key: 'denied/' });
  assert.equal(denied.status, 400);
  const failure = await denied.json();
  assert.equal(failure.error.code, 'AccessDenied');
  assert.equal(failure.error.requestId, 'folder-request');
});
