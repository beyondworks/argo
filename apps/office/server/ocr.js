// 서버 OCR(문서함·사업자등록증) — PaddleOCR 사이드카만 쓴다(유건 10/2: 문서를 구글 등 외부 OCR로 보내지 않는다. 인트라넷 scripts/ocr_server.py와 같은 엔진).
// 사이드카 원본·배포 안내: apps/office/ocr-sidecar/ (POST /ocr-bytes — 원본 바이트를 받아 PDF는 모든 쪽, 그림은 한 장을 읽고 파일을 남기지 않는다).
// env: OFFICE_OCR_URL(https, 또는 같은 기계의 http://127.0.0.1·localhost·[::1]) + OFFICE_OCR_KEY(16자 이상, Authorization: Bearer로 보낸다).
// 둘 중 하나라도 없거나 규칙에 안 맞으면 서버 OCR은 꺼진다(not_configured 503) — 화면은 브라우저 OCR로 넘어가고 올리기는 실패하지 않는다.
// 문서 원문은 로그에 남기지 않는다. 규칙은 test/files-server.test.mjs(가짜 사이드카).
export const OCR_MAX = 20 * 1024 * 1024;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 사이드카 /ocr-bytes 주소 — 규칙(https 또는 루프백 http, 계정 정보 없음, 키 16자 이상)에 맞을 때만, 아니면 null */
export function sidecarUrl(env) {
  const raw = String(env.OFFICE_OCR_URL ?? '').trim(), key = String(env.OFFICE_OCR_KEY ?? '');
  if (!raw || key.length < 16) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/ocr-bytes`;
}

export const ocrProvider = (env) => (sidecarUrl(env) ? 'sidecar' : null);

/** bytes(Buffer) → 글. mime이 pdf·image가 아니면 unsupported */
export async function ocrBytes({ bytes, mime = '', name = '' }, env, fetchImpl = fetch) {
  const url = sidecarUrl(env);
  if (!url) throw fail(503, 'not_configured');
  const pdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
  if (!pdf && !/^image\//.test(mime) && !/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name)) throw fail(415, 'unsupported');
  if (bytes.length > OCR_MAX) throw fail(413, 'too_big');
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OFFICE_OCR_KEY}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name || (pdf ? 'file.pdf' : 'image')), 'x-file-kind': pdf ? 'pdf' : 'image' },
    body: Buffer.from(bytes), signal: AbortSignal.timeout(280_000), // 쪽 많은 PDF는 모델 로드 포함 수 분(인트라넷 lib/ocr.ts와 같은 넉넉함)
  });
  if (!r.ok) throw fail(502, 'ocr');
  const d = await r.json().catch(() => ({}));
  if (typeof d.text !== 'string') throw fail(502, 'ocr');
  return d.text;
}
