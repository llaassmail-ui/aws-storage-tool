import { matchDistributions } from './aws.js';

export function resourceURL(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 16384) throw new Error('请输入有效的资源链接');
  const text = input.trim();
  // URL parsers normalize dot segments and backslashes, which can change an S3 key.
  if (text.includes('\\') || /(?:\/|%2f)(?:\.|%2e){1,2}(?=\/|%2f|[?#]|$)/i.test(text)) throw new Error('链接含有歧义路径（点目录或反斜杠），请在 S3 中手动定位');
  let url;
  try { url = new URL(text.includes('://') ? text : `https://${text}`); }
  catch { throw new Error('资源链接格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('仅支持不含账号信息和自定义端口的 HTTP/HTTPS 链接');
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return url;
}

function decodePath(path) {
  try { return decodeURIComponent(path); }
  catch { throw new Error('链接路径包含无效的百分号编码'); }
}

// Only recognized AWS S3 endpoints are accepted; custom origins are never fetched.
export function s3Endpoint(host) {
  const suffix = '\\.amazonaws\\.com(?:\\.cn)?';
  const service = 's3(?:[.-](?:[a-z]{2}(?:-gov)?-[a-z]+-\\d|external-1)|\\.dualstack\\.[a-z]{2}(?:-gov)?-[a-z]+-\\d|-website[.-][a-z]{2}(?:-gov)?-[a-z]+-\\d|-accelerate(?:\\.dualstack)?)?';
  const virtual = new RegExp(`^(.+)\\.${service}${suffix}$`).exec(host.toLowerCase());
  if (virtual) return { bucket: virtual[1], website: host.includes('s3-website') };
  if (new RegExp(`^${service}${suffix}$`).test(host.toLowerCase())) return { bucket: '', website: false };
  return null;
}

function destination(endpoint, path) {
  let key = path.replace(/^\//, '');
  let bucket = endpoint.bucket;
  if (!bucket) {
    const slash = key.indexOf('/');
    bucket = slash < 0 ? key : key.slice(0, slash);
    key = slash < 0 ? '' : key.slice(slash + 1);
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('无法识别源配置中的 S3 Bucket');
  if (Buffer.byteLength(key) > 1024) throw new Error('解析后的 S3 对象键超过 1024 字节');
  return { bucket, key, prefix: key.endsWith('/') ? key : key.slice(0, key.lastIndexOf('/') + 1), folder: !key || key.endsWith('/') };
}

function pathMatches(pattern, pathname) {
  const expression = pattern.replace(/^\//, '').split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${expression}$`).test(pathname.replace(/^\//, ''));
}

export function resolveConfig(url, distribution, config) {
  const pathname = url.pathname;
  const behavior = (config.CacheBehaviors?.Items || []).find(b => pathMatches(b.PathPattern, pathname)) || config.DefaultCacheBehavior;
  if (!behavior?.TargetOriginId) throw new Error('分配缺少默认行为或目标源');
  const group = config.OriginGroups?.Items?.find(g => g.Id === behavior.TargetOriginId);
  const originIds = group ? (group.Members?.Items || []).map(m => m.OriginId) : [behavior.TargetOriginId];
  const warnings = [];
  if (url.search || url.hash) warnings.push('查询参数和片段未计入 S3 对象键。');
  if (group) warnings.push('目标为故障转移源组，请选择主源或备用源；配置无法确定实际命中的源。');
  const associations = [...(behavior.FunctionAssociations?.Items || []), ...(behavior.LambdaFunctionAssociations?.Items || [])];
  if (associations.some(a => /^(viewer|origin)-request$/.test(a.EventType))) warnings.push('此行为关联请求函数，可能改写路径或源；以下为配置推算结果，请核对。');
  if (config.ContinuousDeploymentPolicyId) warnings.push('分配启用了持续部署，部分请求可能使用暂存分配。');
  let objectPath = decodePath(pathname);
  if (pathname === '/' && config.DefaultRootObject) objectPath = `/${config.DefaultRootObject}`;
  const items = [], issues = [];
  for (const originId of originIds) {
    const origin = config.Origins?.Items?.find(o => o.Id === originId);
    const endpoint = origin && s3Endpoint(origin.DomainName);
    if (!endpoint) { issues.push({ distribution: distribution.id, origin: originId, message: `源 ${origin?.DomainName || originId} 不是可识别的 S3 源，无法自动定位。` }); continue; }
    const notes = [...warnings];
    if (endpoint.website) notes.push('S3 网站源可能使用索引文档或重定向；这里只定位 URL 对应的路径。');
    try {
      const target = destination(endpoint, (origin.OriginPath || '') + objectPath);
      items.push({ ...target, distribution: distribution.id, enabled: distribution.enabled, origin: originId, originDomain: origin.DomainName, behavior: behavior.PathPattern || '默认行为', warnings: notes });
    } catch (error) { issues.push({ distribution: distribution.id, origin: originId, message: error.message }); }
  }
  return { items, issues };
}

export async function locateURL(aws, input) {
  const url = resourceURL(input);
  const endpoint = s3Endpoint(url.hostname);
  if (endpoint) {
    const warnings = [];
    if (url.search || url.hash) warnings.push('查询参数和片段未计入 S3 对象键。');
    if (endpoint.website) warnings.push('网站索引文档和重定向可能改变实际对象。');
    return { items: [{ ...destination(endpoint, decodePath(url.pathname)), originDomain: url.hostname, warnings }], issues: [] };
  }
  const distributions = matchDistributions(await aws.distributionList(), url.hostname);
  if (!distributions.length) return { items: [], issues: [{ message: '未找到匹配域名的 CloudFront 分配。请确认账号和域名，或使用 S3 原始链接。' }] };
  const items = [], issues = [];
  for (const distribution of distributions) {
    try {
      const resolved = resolveConfig(url, distribution, await aws.distributionConfig(distribution.id));
      items.push(...resolved.items); issues.push(...resolved.issues);
    } catch (error) {
      issues.push({ distribution: distribution.id, code: error.name, message: error.message, requestId: error.$metadata?.requestId || '' });
    }
  }
  return { items, issues };
}
