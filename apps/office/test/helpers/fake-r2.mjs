// 엄격 가짜 R2(S3 호환) — node:http. 서명을 aws4fetch가 아니라 이 파일의 SigV4 계산(node:crypto)으로 따로 검증한다(같은 라이브러리로 검증하면 결함이 서로 가려진다).
// 실제 R2 실측(scripts/r2-smoke.mjs, 2026-10-02)과 같게 동작한다: 서명된 헤더 값이 다르면 403 SignatureDoesNotMatch(content-length·content-type 포함),
// 만료 주소 403 ExpiredRequest, if-none-match: *인데 키가 있으면 412 PreconditionFailed, 없는 키 DELETE 204, HEAD는 Content-Length·ETag.
// CORS는 origins에 넣은 출처만 허용(사전 요청 204, 아니면 403 — 지금 버킷처럼 설정이 없으면 모두 403).
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const xmlError = (res, status, code, extra = {}) => { res.writeHead(status, { 'content-type': 'application/xml', ...extra }); res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`); };

export async function startFakeR2({ accessKeyId = 'AKFAKER2', secretAccessKey = 'fake-r2-secret', bucket = 'argo-office', origins = [] } = {}) {
  const objects = new Map(), log = [];
  const verify = (req, url) => {
    const q = url.searchParams, presigned = q.has('X-Amz-Signature');
    let cred, signedHeaders, signature, amzDate, payload;
    if (presigned) {
      cred = q.get('X-Amz-Credential'); signedHeaders = q.get('X-Amz-SignedHeaders'); signature = q.get('X-Amz-Signature'); amzDate = q.get('X-Amz-Date'); payload = 'UNSIGNED-PAYLOAD';
      const t = Date.UTC(+amzDate.slice(0, 4), +amzDate.slice(4, 6) - 1, +amzDate.slice(6, 8), +amzDate.slice(9, 11), +amzDate.slice(11, 13), +amzDate.slice(13, 15));
      if (!(Date.now() <= t + Number(q.get('X-Amz-Expires')) * 1000)) return 'ExpiredRequest';
    } else {
      const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(req.headers.authorization ?? '');
      if (!m) return 'AccessDenied';
      [, cred, signedHeaders, signature] = m; amzDate = req.headers['x-amz-date']; payload = req.headers['x-amz-content-sha256'] ?? '';
    }
    const [ak, date, region, service] = String(cred).split('/');
    if (ak !== accessKeyId || service !== 's3') return 'InvalidAccessKeyId';
    const names = String(signedHeaders).split(';');
    if (!names.includes('host')) return 'SignatureDoesNotMatch';
    const path = url.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
    const query = [...q].filter(([k]) => k !== 'X-Amz-Signature').map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map((p) => p.join('=')).join('&');
    const headers = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}`).join('\n');
    const canonical = [req.method, path, query, `${headers}\n`, signedHeaders, payload].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), 's3'), 'aws4_request');
    const want = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n')).digest('hex');
    return want === signature ? null : 'SignatureDoesNotMatch';
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const origin = req.headers.origin, allowed = origin && origins.includes(origin);
    const cors = allowed ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'ETag, Content-Length', vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      const okMethod = ['GET', 'PUT', 'HEAD'].includes(req.headers['access-control-request-method']);
      if (!allowed || !okMethod) return xmlError(res, 403, 'CORSForbidden');
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, PUT, HEAD', 'access-control-allow-headers': 'content-type, if-none-match', 'access-control-max-age': '3600' });
      return res.end();
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const [, b, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const bad = verify(req, url);
    log.push({ method: req.method, key, auth: url.searchParams.has('X-Amz-Signature') ? 'query' : 'header', status: bad ?? 'ok' });
    if (bad) return xmlError(res, 403, bad, cors);
    if (b !== bucket) return xmlError(res, 404, 'NoSuchBucket', cors);
    if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      res.writeHead(200, { 'content-type': 'application/xml', ...cors });
      return res.end(`<?xml version="1.0"?><ListBucketResult>${keys.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Key></Contents>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && objects.has(key)) return xmlError(res, 412, 'PreconditionFailed', cors);
      const etag = createHash('md5').update(body).digest('hex');
      objects.set(key, { bytes: body, type: req.headers['content-type'] ?? 'application/octet-stream', etag });
      res.writeHead(200, { etag: `"${etag}"`, ...cors }); return res.end();
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204, cors); return res.end(); }
    const o = objects.get(key);
    if (!o) return req.method === 'HEAD' ? (res.writeHead(404, cors), res.end()) : xmlError(res, 404, 'NoSuchKey', cors);
    const q = url.searchParams; // 실제 R2처럼 응답 헤더 덮어쓰기 쿼리를 따른다(실측 10/2: response-content-disposition·response-content-type)
    res.writeHead(200, { 'content-type': q.get('response-content-type') ?? o.type, 'content-length': String(o.bytes.length), etag: `"${o.etag}"`,
      ...(q.get('response-content-disposition') ? { 'content-disposition': q.get('response-content-disposition') } : {}), ...cors });
    return res.end(req.method === 'HEAD' ? undefined : o.bytes);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint, bucket, objects, log,
    env: { R2_ENDPOINT: endpoint, R2_OFFICE_BUCKET: bucket, R2_OFFICE_ACCESS_KEY_ID: accessKeyId, R2_OFFICE_SECRET_ACCESS_KEY: secretAccessKey },
    config: { endpoint, bucket, accessKeyId, secretAccessKey },
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  };
}
