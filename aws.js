import * as S3 from '@aws-sdk/client-s3';
import * as CF from '@aws-sdk/client-cloudfront';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export function errorInfo(error, operation = '', object = '') {
  return { operation, object, code: error.name || 'Error', message: error.message || '请求失败', requestId: error.$metadata?.requestId || '' };
}
export function normalizeDomain(input) {
  try { return new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { throw new Error('域名格式无效'); }
}
export function matchDistributions(items, input) {
  const host = normalizeDomain(input);
  const exact = items.filter(d => [d.domain, ...d.aliases].some(a => a.toLowerCase() === host));
  return exact.length ? exact : items.filter(d => d.aliases.some(a => a.startsWith('*.') && host.endsWith(a.slice(1).toLowerCase())));
}
export function invalidationPaths(text) {
  const paths = [...new Set(text.split(/\r?\n/).map(p => p.trim()).filter(Boolean))];
  if (!paths.length || paths.length > 3000 || paths.some(p => !p.startsWith('/') || p.length > 4000 || p.includes('#') || (p.includes('*') && p.indexOf('*') !== p.length - 1))) throw new Error('填写 1–3000 条路径，以 / 开头；* 只能在末尾，路径不能含 #');
  return paths;
}
const encoded = key => key.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join('/');

export class AWS {
  constructor(credentials) {
    this.credentials = credentials;
    this.clients = new Map();
    this.regions = new Map();
    this.controller = new AbortController();
    this.cf = new CF.CloudFrontClient(this.options('us-east-1'));
    this.distributions = [];
  }
  options(region) {
    return { region, credentials: this.credentials, maxAttempts: 3,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 10000, socketTimeout: 60000 }) };
  }
  s3(region = 'us-east-1') {
    if (!this.clients.has(region)) this.clients.set(region, new S3.S3Client({ ...this.options(region), followRegionRedirects: true }));
    return this.clients.get(region);
  }
  send(client, command) { return client.send(command, { abortSignal: this.controller.signal }); }
  async buckets() {
    const result = []; let token;
    do {
      const page = await this.send(this.s3(), new S3.ListBucketsCommand({ MaxBuckets: 1000, ContinuationToken: token }));
      for (const b of page.Buckets || []) {
        if (b.BucketRegion) this.regions.set(b.Name, b.BucketRegion);
        result.push({ name: b.Name, region: b.BucketRegion || '', created: b.CreationDate });
      }
      token = page.ContinuationToken;
    } while (token);
    return result;
  }
  async region(bucket, override) {
    if (override) this.regions.set(bucket, override);
    if (this.regions.has(bucket)) return this.regions.get(bucket);
    try {
      const r = await this.send(this.s3(), new S3.GetBucketLocationCommand({ Bucket: bucket }));
      const region = r.LocationConstraint === 'EU' ? 'eu-west-1' : r.LocationConstraint || 'us-east-1';
      this.regions.set(bucket, region); return region;
    } catch (e) { e.message = `无法自动确定 ${bucket} 区域，请手动指定。${e.message}`; throw e; }
  }
  async list(bucket, prefix = '', token, override, recursive = false) {
    const region = await this.region(bucket, override);
    const p = await this.send(this.s3(region), new S3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, Delimiter: recursive ? undefined : '/', MaxKeys: 1000 }));
    if (p.IsTruncated && !p.NextContinuationToken) throw new Error('S3 分页响应缺少 token');
    return { region, token: p.IsTruncated ? p.NextContinuationToken : null,
      folders: (p.CommonPrefixes || []).map(x => ({ key: x.Prefix, folder: true })),
      files: (p.Contents || []).map(x => ({ key: x.Key, size: x.Size, modified: x.LastModified, etag: x.ETag })) };
  }
  async snapshot(bucket, selected) {
    const objects = new Map();
    for (const item of selected) {
      if (!item.folder) { objects.set(item.key, { ...item }); continue; }
      let token;
      do {
        const page = await this.list(bucket, item.key, token, undefined, true);
        page.files.forEach(obj => objects.set(obj.key, obj)); token = page.token;
      } while (token);
    }
    return [...objects.values()];
  }
  async head(bucket, key) {
    try { return await this.send(this.s3(await this.region(bucket)), new S3.HeadObjectCommand({ Bucket: bucket, Key: key })); }
    catch (e) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async remove(bucket, key) {
    return this.send(this.s3(await this.region(bucket)), new S3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  async createFolder(bucket, key) {
    if (typeof key !== 'string' || !key || !key.endsWith('/') || key.startsWith('/') || key.includes('//') || Buffer.byteLength(key) > 1024) throw new Error('文件夹名称无效');
    return this.send(this.s3(await this.region(bucket)), new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: '', ContentLength: 0, ContentType: 'application/x-directory' }));
  }
  async setPublicReadAcl(bucket, key) {
    await this.send(this.s3(await this.region(bucket)), new S3.PutObjectAclCommand({ Bucket: bucket, Key: key, ACL: 'public-read' }));
  }
  async copy(from, key, to, target) {
    const client = this.s3(await this.region(to));
    const source = await this.head(from, key);
    if (!source) throw new Error('源对象已不存在');
    const CopySource = `${from}/${encoded(key)}${source.VersionId ? `?versionId=${encodeURIComponent(source.VersionId)}` : ''}`;
    if (source.ContentLength <= 5 * 1024 ** 3) {
      await this.send(client, new S3.CopyObjectCommand({ Bucket: to, Key: target, CopySource, CopySourceIfMatch: source.ETag, MetadataDirective: 'COPY', TaggingDirective: 'COPY' }));
      try { await this.setPublicReadAcl(to, target); }
      catch (error) { error.copyCompleted = true; throw error; }
      return;
    }
    const tags = await this.send(this.s3(await this.region(from)), new S3.GetObjectTaggingCommand({ Bucket: from, Key: key, VersionId: source.VersionId }));
    const metadata = Object.fromEntries(['Metadata', 'ContentType', 'CacheControl', 'ContentDisposition', 'ContentEncoding', 'ContentLanguage', 'Expires', 'WebsiteRedirectLocation'].filter(k => source[k] !== undefined).map(k => [k, source[k]]));
    const upload = await this.send(client, new S3.CreateMultipartUploadCommand({ Bucket: to, Key: target, ...metadata,
      Tagging: new URLSearchParams((tags.TagSet || []).map(t => [t.Key, t.Value])).toString() || undefined }));
    try {
      const parts = []; const size = Math.max(128 * 1024 ** 2, Math.ceil(source.ContentLength / 10000));
      for (let start = 0, number = 1; start < source.ContentLength; start += size, number++) {
        const part = await this.send(client, new S3.UploadPartCopyCommand({ Bucket: to, Key: target, UploadId: upload.UploadId, PartNumber: number, CopySource,
          CopySourceIfMatch: source.ETag, CopySourceRange: `bytes=${start}-${Math.min(start + size, source.ContentLength) - 1}` }));
        parts.push({ ETag: part.CopyPartResult.ETag, PartNumber: number });
      }
      await this.send(client, new S3.CompleteMultipartUploadCommand({ Bucket: to, Key: target, UploadId: upload.UploadId, MultipartUpload: { Parts: parts } }));
      try { await this.setPublicReadAcl(to, target); }
      catch (error) { error.copyCompleted = true; throw error; }
    } catch (error) {
      try { await client.send(new S3.AbortMultipartUploadCommand({ Bucket: to, Key: target, UploadId: upload.UploadId })); } catch { error.message += '；分段清理失败，请检查桶中未完成上传'; }
      throw error;
    }
  }
  async upload(bucket, key, stream, size, type, progress, signal) {
    const transfer = new Upload({ client: this.s3(await this.region(bucket)), queueSize: 2, partSize: Math.max(8 * 1024 ** 2, Math.ceil(size / 10000)), leavePartsOnError: false,
      params: { Bucket: bucket, Key: key, Body: stream, ContentLength: size, ContentType: type || 'application/octet-stream', ACL: 'public-read' } });
    transfer.on('httpUploadProgress', p => progress(p.loaded || 0));
    const abort = () => { transfer.abort().catch(() => {}); stream.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    this.controller.signal.addEventListener('abort', abort, { once: true });
    try { if (signal.aborted || this.controller.signal.aborted) abort(); await transfer.done(); }
    finally { signal.removeEventListener('abort', abort); this.controller.signal.removeEventListener('abort', abort); }
  }
  async distributionList() {
    const all = []; let marker;
    do {
      const p = await this.send(this.cf, new CF.ListDistributionsCommand({ Marker: marker }));
      all.push(...(p.DistributionList?.Items || []).map(d => ({ id: d.Id, domain: d.DomainName, aliases: d.Aliases?.Items || [], enabled: d.Enabled })));
      marker = p.DistributionList?.IsTruncated ? p.DistributionList.NextMarker : undefined;
      if (p.DistributionList?.IsTruncated && !marker) throw new Error('CloudFront 分页缺少 marker');
    } while (marker);
    this.distributions = all; return all;
  }
  invalidate(id, paths, reference) {
    return this.send(this.cf, new CF.CreateInvalidationCommand({ DistributionId: id, InvalidationBatch: { CallerReference: reference, Paths: { Quantity: paths.length, Items: paths } } }));
  }
  invalidation(id, request) { return this.send(this.cf, new CF.GetInvalidationCommand({ DistributionId: id, Id: request })); }
  async close() {
    this.controller.abort();
    this.credentials = null;
    this.clients.forEach(c => c.destroy()); this.cf.destroy(); this.clients.clear();
  }
}
