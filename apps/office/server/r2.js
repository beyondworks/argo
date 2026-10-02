// Cloudflare R2 접근(S3 호환 API) — 서명 주소(브라우저가 R2와 직접 주고받는 길)와 서버 전용 읽기·쓰기·지우기.
// 서명은 aws4fetch 1.0.20(MIT, 의존성 0, Web Crypto)의 AwsV4Signer로 한다 — Node 18+·Deno·Workers 공통이라 메신저·본체가 그대로 가져다 쓸 수 있다.
// 이 모듈은 process.env를 읽지 않는다(키는 인자로만). 키를 환경에서 꺼내는 일은 r2FromEnv 한 곳 — 부르는 곳은 api/·scripts/ 서버 코드뿐이다.
// 규칙(설계안 r2-design.md 3장): 서버는 DB 함수가 허락한 키만 서명한다 — 이 모듈은 받은 키를 그대로 서명하므로, 키를 고르는 일은 부르는 쪽(DB 결과)이 한다.
// 서명 주소·키 값은 로그에 남기지 않는다(서명 주소는 만료까지 쓸 수 있는 bearer 토큰이다).
import { AwsV4Signer } from 'aws4fetch';

const fail = (status, code) => Object.assign(new Error(code), { status, code });
export const PUT_TTL = 300, GET_TTL = 600; // 서명 주소 만료(총괄 승인 10/2): 올리기 5분, 열기 10분
const MAX_TTL = 3600;                      // R2 상한은 7일 — 앱이 쓰는 서명 주소는 실수로 길어지지 않게 1시간에서 막는다(r2Client.presign)

/** R2 객체 키 검사 — 앞 '/'·'..'·빈 칸·제어 문자·1024바이트 초과 거절(R2 키 길이 상한 1024바이트) */
export function checkKey(key) {
  const k = String(key ?? '');
  if (!k || k.startsWith('/') || k.includes('..') || k.includes('//') || /[\u0000-\u001f\u007f\\]/.test(k) || new TextEncoder().encode(k).length > 1024) throw fail(400, 'key');
  return k;
}
const encodeKey = (key) => checkKey(key).split('/').map(encodeURIComponent).join('/');

/** 환경 변수에서 R2 설정 — 하나라도 없으면 503 r2_not_configured(Preview 배포에는 일부러 넣지 않는다 — 총괄 결정 7) */
export function r2FromEnv(env, fetchImpl = fetch) {
  const endpoint = String(env.R2_ENDPOINT ?? '').replace(/\/+$/, ''), bucket = env.R2_OFFICE_BUCKET, accessKeyId = env.R2_OFFICE_ACCESS_KEY_ID, secretAccessKey = env.R2_OFFICE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw fail(503, 'r2_not_configured');
  return r2Client({ endpoint, bucket, accessKeyId, secretAccessKey }, fetchImpl);
}

/** SigV4 쿼리 서명 주소 한 개(낮은 단계 — AWS 문서 예시 값으로 잠근다). headers의 이름·값이 모두 서명에 들어간다 */
export async function presignUrl({ url, method, headers = {}, expires, accessKeyId, secretAccessKey, region = 'auto', datetime }) {
  const ttl = Number(expires);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800) throw fail(400, 'expires'); // S3·R2 서명 주소 범위(1초~7일)
  const u = new URL(url);
  u.searchParams.set('X-Amz-Expires', String(ttl));
  const signed = await new AwsV4Signer({ url: u.toString(), method, headers, accessKeyId, secretAccessKey, service: 's3', region, signQuery: true, allHeaders: true, ...(datetime ? { datetime } : {}) }).sign();
  return signed.url.toString();
}

/** { endpoint: 'https://<계정>.r2.cloudflarestorage.com', bucket, accessKeyId, secretAccessKey } → 객체 하나씩 다루는 함수들 */
export function r2Client({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' }, fetchImpl = fetch) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw fail(503, 'r2_not_configured');
  const base = `${String(endpoint).replace(/\/+$/, '')}/${encodeURIComponent(bucket)}`;
  const objectUrl = (key) => `${base}/${encodeKey(key)}`;
  /** 서버가 직접 부르는 요청 — Authorization 헤더 서명 */
  const call = async (method, url, { headers = {}, body } = {}) => {
    const signed = await new AwsV4Signer({ url, method, headers, body, accessKeyId, secretAccessKey, service: 's3', region }).sign();
    return fetchImpl(signed.url.toString(), { method, headers: signed.headers, body });
  };
  return {
    bucket,
    /** 브라우저용 서명 주소. PUT은 content-type·content-length·if-none-match: *를 서명에 넣는다 — 다른 형식·크기·덮어쓰기는 R2가 거절한다.
     *  돌려주는 headers는 브라우저가 그대로 보낼 것(content-length는 브라우저가 몸체 길이로 직접 채운다) */
    async presign({ method, key, expires, contentType, contentLength, attachment = false }) {
      if (expires != null && (!Number.isInteger(expires) || expires < 1 || expires > MAX_TTL)) throw fail(400, 'expires');
      if (method === 'PUT') {
        if (!contentType || !Number.isSafeInteger(contentLength) || contentLength < 0) throw fail(400, 'put_headers');
        const headers = { 'content-type': contentType, 'content-length': String(contentLength), 'if-none-match': '*' };
        const url = await presignUrl({ url: objectUrl(key), method, headers, expires: expires ?? PUT_TTL, accessKeyId, secretAccessKey, region });
        return { url, headers: { 'content-type': contentType, 'if-none-match': '*' }, expiresIn: expires ?? PUT_TTL };
      }
      if (method !== 'GET') throw fail(400, 'method');
      // attachment: 응답을 내려받기로(response-content-disposition — 쿼리도 서명에 들어간다. R2 실측 10/2: 지원). html·svg 같은 활성 형식이 주소를 직접 열었을 때 그 형식으로 열리지 않게
      const url = attachment ? `${objectUrl(key)}?response-content-disposition=attachment` : objectUrl(key);
      return { url: await presignUrl({ url, method, expires: expires ?? GET_TTL, accessKeyId, secretAccessKey, region }), expiresIn: expires ?? GET_TTL };
    },
    /** 크기·etag·형식 — 없으면 null */
    async head(key) {
      // accept-encoding: identity — Node fetch 기본값(gzip)이면 R2가 text/*·json을 gzip으로 답하며 Content-Length를 빼서 크기를 알 수 없다(운영 결함 10/3)
      const r = await call('HEAD', objectUrl(key), { headers: { 'accept-encoding': 'identity' } });
      if (r.status === 404) return null;
      if (!r.ok) throw fail(502, 'r2');
      return { bytes: Number(r.headers.get('content-length') ?? NaN), etag: String(r.headers.get('etag') ?? '').replace(/"/g, ''), mime: r.headers.get('content-type') ?? '' };
    },
    /** 객체 전체(서버 전용 — 서명본 합성·드라이브 보내기·OCR) */
    async get(key) {
      const r = await call('GET', objectUrl(key));
      if (r.status === 404) throw fail(404, 'missing_file');
      if (!r.ok) throw fail(502, 'r2');
      return new Uint8Array(await r.arrayBuffer());
    },
    /** 올리기(서버 전용). ifNoneMatch면 이미 있는 키에는 쓰지 않는다(412 → 409 file_conflict) */
    async put(key, bytes, { contentType = 'application/octet-stream', ifNoneMatch = false } = {}) {
      const r = await call('PUT', objectUrl(key), { headers: { 'content-type': contentType, ...(ifNoneMatch ? { 'if-none-match': '*' } : {}) }, body: bytes });
      if (r.status === 412) throw fail(409, 'file_conflict');
      if (!r.ok) throw fail(502, 'r2');
      return { etag: String(r.headers.get('etag') ?? '').replace(/"/g, '') };
    },
    /** 지우기 — 없는 키도 성공으로 본다(이중 삭제 안전) */
    async del(key) {
      const r = await call('DELETE', objectUrl(key));
      if (!r.ok && r.status !== 404) throw fail(502, 'r2');
      return true;
    },
    /** 접두로 키 목록(실측·점검 스크립트 전용 — 화면 흐름에서는 쓰지 않는다. Class A 요청) */
    async list(prefix, max = 1000) {
      const u = new URL(base);
      u.searchParams.set('list-type', '2'); u.searchParams.set('prefix', prefix); u.searchParams.set('max-keys', String(max));
      const r = await call('GET', u.toString());
      if (!r.ok) throw fail(502, 'r2');
      const xml = await r.text();
      return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
    },
  };
}

/** 여러 키를 동시에 n개씩 — 결과는 키마다 true(성공) | false */
export async function eachLimited(keys, n, fn) {
  const out = new Map(), list = [...keys];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = list[i++]; try { await fn(k); out.set(k, true); } catch { out.set(k, false); } }
  }));
  return out;
}
