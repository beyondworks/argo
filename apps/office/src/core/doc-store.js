// 다른 화면이 만든 문서를 문서함에 넣는 작은 입구(트랙 A 견적서·계약서·서명본 PDF, 인트라넷 lib/docgen/save.ts와 같은 일).
// 부르는 쪽은 이 파일을 지연 로드한다: import('../core/doc-store.js').then((m) => m.saveDocument(space, {...})). 문서함 코드도 이때만 받는다.
import { navigate } from './router.jsx';
import { baseOf } from './commands.js';

/**
 * 문서함에 저장 — 반환 { id, title, category, customer_id }. 실패하면 사전 키(files.err.*)를 담은 오류를 던진다.
 * @param {string} space 공간 키('me' 또는 조직 slug)
 * @param {{ file: Blob, filename: string, title: string, category?: 'quote'|'contract'|'bizcert'|'card'|'bankbook'|'evidence'|'archive'|'general',
 *   customerId?: string, customerName?: string, dealId?: string, tags?: string[], summary?: string, refDoc?: string, refEsign?: string }} doc
 *   customerName: 거래처 id가 없을 때 이름으로 연결(정확 일치 먼저, 부분 일치는 하나일 때만 — 애매하면 연결하지 않는다)
 *   summary: 검색에 쓰는 본문(요약 1,900자·전문 10만 자로 자른다).
 *   출처는 서버가 정한다(분리 검수 LOW 6): refDoc(견적·계약 문서 id) → 'generated', refEsign(완료된 서명 id) → 'esign'(같은 서명본은 한 번만 — 두 번째는 code 'conflict').
 *   서명본은 category 'contract' + refEsign + tags ['signed']
 */
export async function saveDocument(space, doc) {
  const { saveGenerated } = await import('../files/api.js');
  return saveGenerated(space, doc);
}

/** 문서함에서 그 문서 미리보기 열기 */
export const openDocument = (space, id) => navigate(`${baseOf(space)}/files?open=${encodeURIComponent(id)}`);

/** 파일 글자 읽기(사업자등록증 OCR 등) — 서버 OCR(PaddleOCR 사이드카 OFFICE_OCR_URL)이 없거나 한도를 넘으면 브라우저에서 → { status, text } */
export async function readText(space, file) {
  const { readTextInBrowser } = await import('./ocr-browser.js');
  const { configured } = await import('./supabase.js');
  if (configured) {
    const { serverOcr } = await import('../files/api.js');
    if (await serverOcr()) {
      try {
        const { apiUrl } = await import('./platform.js');
        const { getClient } = await import('./supabase.js');
        const jwt = (await (await getClient())?.auth.getSession())?.data.session?.access_token;
        const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(r.error); r.readAsDataURL(file); });
        const res = await fetch(apiUrl('/api/files/ocr'), { method: 'POST', headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify({ data, name: file.name ?? 'file', mime: file.type }) });
        if (res.ok) return await res.json();
      } catch { /* 브라우저로 */ }
    }
  }
  return readTextInBrowser(file, file.name ?? '', file.type);
}
