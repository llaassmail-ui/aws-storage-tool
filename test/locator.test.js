import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateURL, resourceURL, resolveConfig, s3Endpoint } from '../locator.js';
import { AWS } from '../aws.js';
import { createServer } from '../server.js';

const distribution = { id: 'D1', domain: 'demo.cloudfront.net', aliases: ['cdn.example.com'], enabled: true };
const config = () => ({
  DefaultRootObject: 'index.html',
  DefaultCacheBehavior: { TargetOriginId: 'default' },
  CacheBehaviors: { Items: [{ PathPattern: '/assets/private/*', TargetOriginId: 'private' }, { PathPattern: 'assets/*', TargetOriginId: 'assets' }] },
  Origins: { Items: [
    { Id: 'default', DomainName: 'site.s3.amazonaws.com', OriginPath: '/production' },
    { Id: 'assets', DomainName: 'static.s3.ap-south-1.amazonaws.com', OriginPath: '/v2' },
    { Id: 'private', DomainName: 'private.s3.amazonaws.com', OriginPath: '' }
  ] }
});
const resolve = (path, value = config()) => resolveConfig(resourceURL(`https://cdn.example.com${path}`), distribution, value);

test('CloudFront ordered behaviors, origin path and default root resolve exact keys', () => {
  assert.equal(resolve('/assets/private/a.txt').items[0].bucket, 'private');
  const asset = resolve('/assets/images/logo.png?v=123#x').items[0];
  assert.equal(asset.key, 'v2/assets/images/logo.png');
  assert.equal(asset.prefix, 'v2/assets/images/');
  assert.equal(asset.behavior, 'assets/*');
  assert.equal(asset.warnings.length, 1);
  assert.equal(resolve('/').items[0].key, 'production/index.html');
  assert.equal(resolve('/sub/').items[0].key, 'production/sub/');
  assert.equal(resolve('/sub/').items[0].folder, true);
  assert.equal(resolve('/a//b').items[0].key, 'production/a//b');
  const value = config(); value.CacheBehaviors.Items.unshift({ PathPattern: 'assets/?.txt', TargetOriginId: 'private' });
  assert.equal(resolve('/assets/a.txt', value).items[0].bucket, 'private');
  assert.equal(resolve('/assets/ab.txt', value).items[0].bucket, 'static');
  assert.equal(resolve('/ASSETS/a.txt').items[0].bucket, 'site');
});

test('paths decode once, retain unusual characters, reject ambiguous or invalid inputs', () => {
  const key = '中文 空格"#%2F.txt';
  assert.equal(resolve('/' + encodeURIComponent(key)).items[0].key, 'production/' + key);
  assert.equal(resolve('/a%2Fb').items[0].key, 'production/a/b');
  assert.throws(() => resolve('/bad%ZZ'));
  for (const input of ['', null, 'ftp://cdn.example.com/a', 'https://user:password@cdn.example.com/a', 'https://cdn.example.com:8443/a', 'https://cdn.example.com/a/../b', 'https://cdn.example.com/%2e%2e/b', 'https://cdn.example.com/a\\b']) assert.throws(() => resourceURL(input));
  assert.equal(resourceURL('CDN.EXAMPLE.COM./a').hostname, 'cdn.example.com');
});

test('origin groups expose candidates; rewrites, website and custom origins are explicit', () => {
  const value = config();
  value.DefaultCacheBehavior = { TargetOriginId: 'failover', FunctionAssociations: { Items: [{ EventType: 'viewer-request' }] } };
  value.OriginGroups = { Items: [{ Id: 'failover', Members: { Items: [{ OriginId: 'default' }, { OriginId: 'website' }, { OriginId: 'api' }] } }] };
  value.Origins.Items.push({ Id: 'website', DomainName: 'backup.s3-website.ap-south-1.amazonaws.com' }, { Id: 'api', DomainName: 'api.example.com' });
  const r = resolve('/doc/', value);
  assert.deepEqual(r.items.map(x => x.bucket), ['site', 'backup']);
  assert.match(r.items[0].warnings.join(' '), /故障转移.*请求函数/);
  assert.match(r.items[1].warnings.join(' '), /网站源/);
  assert.equal(r.issues.length, 1); assert.match(r.issues[0].message, /不是可识别的 S3/);
});

test('direct S3 links resolve without CloudFront access; AWS endpoint recognition is bounded', async () => {
  for (const host of ['my.bucket.s3.amazonaws.com', 'my.bucket.s3-ap-south-1.amazonaws.com', 'my.bucket.s3.dualstack.ap-south-1.amazonaws.com', 'my.bucket.s3.cn-north-1.amazonaws.com.cn', 'my.bucket.s3-accelerate.amazonaws.com']) assert.equal(s3Endpoint(host).bucket, 'my.bucket');
  for (const host of ['bucket.s3.amazonaws.com.evil.test', 'bucket.s3-accesspoint.us-east-1.amazonaws.com', 'api.example.com']) assert.equal(s3Endpoint(host), null);
  const r = await locateURL({}, 'https://s3.ap-south-1.amazonaws.com/my.bucket/a%20b/%252F.txt');
  assert.equal(r.items[0].bucket, 'my.bucket'); assert.equal(r.items[0].key, 'a b/%2F.txt');
  assert.equal((await locateURL({}, 'https://my.bucket.s3.amazonaws.com/')).items[0].prefix, '');
});

test('multiple distributions preserve partial errors and only query matched configurations', async () => {
  const queried = [];
  const aws = { distributionList: async () => [distribution, { ...distribution, id: 'D2' }, { ...distribution, id: 'W', aliases: ['*.example.com'] }],
    distributionConfig: async id => { queried.push(id); if (id === 'D2') throw Object.assign(new Error('Requires cloudfront:GetDistributionConfig'), { name: 'AccessDenied', $metadata: { requestId: 'request-2' } }); return config(); } };
  const r = await locateURL(aws, 'cdn.example.com/assets/logo.png');
  assert.deepEqual(queried, ['D1', 'D2']); assert.equal(r.items.length, 1);
  assert.equal(r.issues[0].code, 'AccessDenied'); assert.equal(r.issues[0].requestId, 'request-2');
  assert.equal((await locateURL(aws, 'unknown.test/file')).items.length, 0);
});

test('configuration wrapper uses GetDistributionConfig and preserves errors', async () => {
  const aws = new AWS({ accessKeyId: 'mock', secretAccessKey: 'mock' });
  aws.send = async (_, command) => { assert.equal(command.constructor.name, 'GetDistributionConfigCommand'); assert.equal(command.input.Id, 'D1'); return { DistributionConfig: config() }; };
  assert.deepEqual(await aws.distributionConfig('D1'), config()); await aws.close();
});

test('locate HTTP endpoint is session protected and returns path candidates without writes', async t => {
  const server = createServer(() => ({ buckets: async () => [], distributionList: async () => [distribution], distributionConfig: async () => config(), close: async () => {} }));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`; let cookie = '';
  const post = (path, data) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post('/api/locate', { url: 'cdn.example.com/a' })).status, 401);
  const login = await post('/api/connect', { accessKeyId: 'mock', secretAccessKey: 'mock' }); cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await post('/api/locate', { url: 'cdn.example.com/assets/a.png' });
  assert.equal(response.status, 200); assert.equal((await response.json()).items[0].key, 'v2/assets/a.png');
  assert.equal((await post('/api/locate', { url: 'file:///etc/passwd' })).status, 400);
});
