// 서버 OCR(문서함·사업자등록증) — 둘 중 설정된 것을 쓴다. 규칙은 test/files-server.test.mjs(가짜 서버).
// · OFFICE_OCR_URL: PaddleOCR 사이드카(인트라넷 scripts/ocr_server.py와 같은 엔진). 오피스는 파일 경로를 줄 수 없으므로 바이트 끝점이 필요하다:
//   POST <OFFICE_OCR_URL>/ocr-bytes { data: base64, name } → { text }   (OFFICE_OCR_KEY가 있으면 x-ocr-key 헤더로 보낸다)
// · OFFICE_VISION_API_KEY: Google Cloud Vision DOCUMENT_TEXT_DETECTION(그림 images:annotate, PDF files:annotate 앞 5쪽)
// 둘 다 없으면 not_configured(503) — 화면은 브라우저 OCR로 넘어간다. 문서 원문은 로그에 남기지 않는다.
export const OCR_MAX = 20 * 1024 * 1024;
const fail = (status, code) => Object.assign(new Error(code), { status, code });

export const ocrProvider = (env) => (env.OFFICE_OCR_URL ? 'sidecar' : env.OFFICE_VISION_API_KEY ? 'vision' : null);

/** Vision 응답 → 글. files:annotate는 쪽마다 responses가 한 겹 더 있다 */
export function visionText(body) {
  const outer = body?.responses ?? [];
  const pages = outer.flatMap((r) => (r.responses ? r.responses : [r]));
  const err = pages.find((p) => p.error)?.error;
  if (err && !pages.some((p) => p.fullTextAnnotation)) throw fail(502, 'ocr');
  return pages.map((p) => p.fullTextAnnotation?.text ?? '').filter(Boolean).join('\n\n').trim();
}

/** bytes(Buffer) → 글. mime이 pdf·image가 아니면 unsupported */
export async function ocrBytes({ bytes, mime = '', name = '' }, env, fetchImpl = fetch) {
  const provider = ocrProvider(env);
  if (!provider) throw fail(503, 'not_configured');
  const pdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
  if (!pdf && !/^image\//.test(mime) && !/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name)) throw fail(415, 'unsupported');
  if (bytes.length > OCR_MAX) throw fail(413, 'too_big');
  const data = Buffer.from(bytes).toString('base64');
  if (provider === 'sidecar') {
    const r = await fetchImpl(`${env.OFFICE_OCR_URL.replace(/\/$/, '')}/ocr-bytes`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(env.OFFICE_OCR_KEY ? { 'x-ocr-key': env.OFFICE_OCR_KEY } : {}) },
      body: JSON.stringify({ data, name }), signal: AbortSignal.timeout(280_000), // 쪽 많은 PDF는 모델 로드 포함 수 분(인트라넷 lib/ocr.ts와 같은 넉넉함)
    });
    if (!r.ok) throw fail(502, 'ocr');
    const d = await r.json().catch(() => ({}));
    if (typeof d.text !== 'string') throw fail(502, 'ocr');
    return d.text;
  }
  const key = encodeURIComponent(env.OFFICE_VISION_API_KEY);
  const features = [{ type: 'DOCUMENT_TEXT_DETECTION' }], ctx = { languageHints: ['ko', 'en'] };
  const r = pdf
    ? await fetchImpl(`https://vision.googleapis.com/v1/files:annotate?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ inputConfig: { content: data, mimeType: 'application/pdf' }, features, imageContext: ctx, pages: [1, 2, 3, 4, 5] }] }) })
    : await fetchImpl(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: data }, features, imageContext: ctx }] }) });
  if (!r.ok) throw fail(502, 'ocr');
  return visionText(await r.json());
}
