// 문서함 예시 데이터(예시 모드 — 서버 설정 없음). 회사·사람은 가상이다. 문서함 화면 묶음에만 들어간다(첫 화면 밖).
// 기록은 이 브라우저의 IndexedDB에 남는다(새로고침해도 유지 — 올린 파일 미리보기·검색까지 같은 흐름). 서버 office_file_write와 같은 뜻으로 고친다.
// 예시 파일 내용(명함·사업자등록증 그림, 견적서 PDF, 회의록 docx)은 열 때 브라우저에서 그려 만든다(저장소에 큰 덩어리를 두지 않게).
import { get, set, del } from 'idb-keyval';
import { canMoveFolder, TRASH_DAYS } from './model.js';
import { seedBusiness, loadSample, sampleId } from '../business/sample-business.js';

const META = (space) => `argo-office-files:sample:v2:${space}`; // v2: 거래처를 업무 예시 원장 id로(LOW 5) — 예전 예시 기록은 새로 씨앗을 뿌린다
const BLOB = (id) => `argo-office-files:sample:blob:${id}`;
const SAMPLE_QUOTA = 1073741824; // 예시 모드 한도 — Free 풀 1GB(DB office_storage_limits와 같은 값, 표시용)
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const ago = (days, h = 10) => new Date(Date.now() - days * 864e5 - (Date.now() % 864e5) + h * 36e5).toISOString();

/** 예시 거래처 = 업무 예시 원장 하나(business/sample-business.js) — 문서함의 거래처 칸·필터와 업무 › 거래처 카드가 같은 id·이름을 쓴다(분리 검수 LOW 5).
 *  예시 모드에서 업무 화면에 새로 만든 거래처도 이 브라우저 원장에서 함께 읽는다 */
export function sampleCustomers(space) {
  let st = null;
  try { st = globalThis.localStorage ? loadSample(globalThis.localStorage, space) : null; } catch { st = null; }
  return ((st ?? seedBusiness(space)).customers ?? []).map((c) => ({ id: c.id, name: c.name, biz_no: c.biz_no ?? '', status: c.status ?? 'active', category: c.category ?? 'customer' }));
}

const T = {
  bizcert: '사업자등록증\n(법인사업자)\n등록번호: 000-00-10001\n법인명(단체명): 주식회사 한빛코퍼레이션\n대표자: 이한빛\n개업연월일: 2019년 03월 04일\n법인등록번호: 000000-0000001\n사업장 소재지: 서울특별시 강남구 예시대로 100, 5층\n업태: 서비스업  종목: 소프트웨어 개발 및 공급\n2019년 03월 04일\n역삼세무서장',
  card: '한빛코퍼레이션\n김민수 팀장 | 사업개발팀\nM. 010-0000-1234\nE. minsu.kim@hanbit.example\n서울특별시 강남구 예시대로 100, 5층',
  bankbook: '통장사본\n예금주: 주식회사 오름\n은행: 예시은행\n계좌번호: 000000-00-000002\n개설일: 2021.05.10',
  quote: '견 적 서\n견적일자: 2026년 9월 18일\n수신: 한빛코퍼레이션 귀중\n공급자: 비욘드웍스\n\n품목 | 수량 | 단가 | 금액\nAI 업무 자동화 구축 | 1 | 4,500,000 | 4,500,000\n운영 지원(3개월) | 3 | 300,000 | 900,000\n\n공급가액 5,400,000원\n부가세 540,000원\n합계 5,940,000원',
  contract: '용역 계약서\n갑: 주식회사 한빛코퍼레이션 (대표 이한빛)\n을: 비욘드웍스\n제1조(목적) 본 계약은 갑이 을에게 의뢰한 AI 업무 자동화 구축 용역에 관한 사항을 정한다.\n제2조(계약금액) 금 5,940,000원(부가세 포함)\n제3조(기간) 2026년 10월 1일 ~ 2026년 12월 31일\n전자서명 완료: 2026-09-25 14:02 (갑·을)',
  invoice: '전자세금계산서\n공급자: 비욘드웍스\n공급받는자: 주식회사 오름 (000-00-10002)\n작성일자: 2026-09-30\n공급가액 2,000,000 세액 200,000 합계 2,200,000\n품목: 9월 운영 대행',
  minutes: '3분기 회의록\n일시: 2026-09-26 10:00\n참석: 김유건, 최민지, 박준\n1. 한빛코퍼레이션 계약 진행 상황 — 서명 완료, 10월 착수\n2. 주식회사 오름 9월 세금계산서 발행 확인\n3. 다음 주 할 일 배분',
  taxi: '영수증\n카드 승인\n가맹점: 서울택시\n금액: 18,400원\n일시: 2026-09-29 22:41',
  memo: '개인 메모\n- 10월 캠페인 초안 검토\n- 영수증 정리 마감 10/5',
  conti: '촬영 콘티\n#1 오프닝 — 스튜디오 전경\n#2 인터뷰 — 대표 인사\n#3 제품 클로즈업',
  old: '견적서(초안)\n수신: 새벽베이커리\n합계 1,100,000원',
};

function seed(space) {
  const cust = (n) => sampleId(space, n); // 업무 예시 원장의 거래처(1 한빛코퍼레이션 · 2 주식회사 오름 · 3 새벽베이커리)
  const f = (id, o) => ({ id, kind: 'file', folder_id: null, mime: 'application/pdf', source: 'upload', drive_id: null, tags: [], customer_id: null, deal_id: null,
    ocr_status: 'none', summary: '', full_text: '', created_by: 'u-me', created_at: ago(1), updated_at: ago(1), deleted_at: null, link_url: null, sample: true, ...o,
    storage_path: o.kind === 'link' ? null : `sample/${id}`, filename: o.filename ?? o.title });
  const text = (key) => ({ summary: T[key].slice(0, 1900), full_text: T[key] });
  if (space === 'beyondworks') {
    return {
      folders: [{ id: 'fo-deal', name: '견적·계약', parent_id: null, created_by: 'u-me' }, { id: 'fo-evid', name: '증빙', parent_id: null, created_by: 'u-minji' }, { id: 'fo-2026', name: '2026', parent_id: 'fo-evid', created_by: 'u-minji' }],
      files: [
        f('sf-quote', { title: '한빛코퍼레이션_견적서_2026-09.pdf', folder_id: 'fo-deal', category: 'quote', customer_id: cust(1), source: 'generated', tags: ['견적서', '한빛코퍼레이션'], size: 182_311, created_at: ago(14), sampleKind: 'quote', ...text('quote') }),
        f('sf-contract', { title: '한빛코퍼레이션_용역계약서_서명본.pdf', folder_id: 'fo-deal', category: 'contract', customer_id: cust(1), source: 'esign', tags: ['계약서', 'signed'], size: 241_002, created_at: ago(7), sampleKind: 'contract', ...text('contract') }),
        f('sf-bizcert', { title: '사업자등록증_한빛코퍼레이션.png', mime: 'image/png', category: 'bizcert', customer_id: cust(1), size: 412_877, created_at: ago(20), ocr_status: 'done', sampleKind: 'bizcert', ...text('bizcert') }),
        f('sf-card', { title: '김민수_명함.png', mime: 'image/png', category: 'card', customer_id: cust(1), size: 98_220, created_at: ago(3), ocr_status: 'done', sampleKind: 'card', created_by: 'u-jun', ...text('card') }),
        f('sf-bank', { title: '오름_통장사본.png', mime: 'image/png', category: 'bankbook', customer_id: cust(2), size: 133_104, created_at: ago(10), ocr_status: 'done', sampleKind: 'bankbook', created_by: 'u-minji', ...text('bankbook') }),
        f('sf-invoice', { title: '9월_세금계산서_오름.pdf', folder_id: 'fo-2026', category: 'evidence', customer_id: cust(2), size: 156_330, created_at: ago(2), ocr_status: 'done', sampleKind: 'invoice', created_by: 'u-minji', ...text('invoice') }),
        f('sf-minutes', { title: '3분기 회의록.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'general', size: 21_448, created_at: ago(5), ocr_status: 'done', sampleKind: 'minutes', ...text('minutes') }),
        f('sf-link', { kind: 'link', title: '하반기 제안서 (구글 문서)', mime: 'application/vnd.google-apps.document', link_url: 'https://docs.google.com/document/d/sample-proposal/edit', drive_id: 'sample-proposal', source: 'drive', category: 'general', size: 0, created_at: ago(4) }),
        f('sf-old', { title: '옛 견적서 초안.pdf', category: 'quote', customer_id: cust(3), size: 90_112, created_at: ago(40), deleted_at: ago(3), sampleKind: 'old', ...text('old') }),
      ],
    };
  }
  if (space === 'me') return { folders: [], files: [
    f('sf-taxi', { title: '영수증_택시_0929.jpg', mime: 'image/jpeg', category: 'evidence', size: 64_002, created_at: ago(2), ocr_status: 'done', sampleKind: 'taxi', ...text('taxi') }),
    f('sf-memo', { title: '개인 메모.txt', mime: 'text/plain', category: 'general', size: 120, created_at: ago(6), ocr_status: 'done', sampleKind: 'memo', ...text('memo') }),
  ] };
  if (space === 'lean-studio') return { folders: [], files: [
    f('sf-conti', { title: '촬영 콘티.pdf', category: 'general', customer_id: cust(2), size: 301_220, created_at: ago(8), sampleKind: 'conti', ...text('conti') }),
  ] };
  return { folders: [], files: [] };
}

/* ── 저장소 ── */
const mem = new Map(); // IndexedDB를 못 쓰는 창(사생활 보호 모드)에서도 화면은 돈다 — 그때는 새로고침하면 처음으로
async function load(space) {
  if (mem.has(space)) return mem.get(space);
  let m = null;
  try { m = await get(META(space)); } catch { /* 저장소 없음 */ }
  if (!m) m = seed(space);
  mem.set(space, m);
  return m;
}
async function save(space, m) { mem.set(space, m); try { await set(META(space), m); } catch { /* 화면 메모리에만 */ } }
export async function sampleBlobPut(id, blob) { try { await set(BLOB(id), blob); } catch { mem.set(BLOB(id), blob); } }
export async function sampleBlobGet(f) {
  if (f.sample) return makeSampleBlob(f);
  try { return (await get(BLOB(f.id))) ?? mem.get(BLOB(f.id)) ?? null; } catch { return mem.get(BLOB(f.id)) ?? null; }
}

const pick = (f, full) => { const { full_text, ...rest } = f; return full ? f : { ...rest, summary: (f.summary ?? '').slice(0, 200), full_text: (f.full_text ?? '').slice(0, 4000) }; };
export async function sampleList(space, { q, trash = false, customer = null, match } = {}) {
  const m = await load(space);
  const files = m.files.filter((f) => (trash ? !!f.deleted_at : !f.deleted_at) && (!customer || f.customer_id === customer) && (!q || match(f, q)))
    .sort((a, b) => Date.parse(b.deleted_at ?? b.created_at) - Date.parse(a.deleted_at ?? a.created_at));
  // 쓴 용량 / 한도 — 로그인 모드(office_file_list usage)와 같은 모양. 예시 저장소의 파일 크기 합, 한도는 Free 풀(1GB — DB office_storage_limits 값)
  return { files: files.map((f) => pick(f)), folders: [...m.folders], more: false, usage: { used: m.files.reduce((s, f) => s + (f.size ?? 0), 0), quota: SAMPLE_QUOTA }, manager: true, me: 'u-me' };
}
export async function sampleGet(space, id) {
  const f = (await load(space)).files.find((x) => x.id === id);
  if (!f) fail('file_not_found');
  return pick(f, true);
}

/** 쓰기 — 서버 office_file_write와 같은 동작·거절 이유 */
export async function sampleWrite(space, action, d) {
  const m = await load(space);
  const now = new Date().toISOString();
  const fileOf = (id) => m.files.find((x) => x.id === id) ?? fail('file_not_found');
  let out;
  if (action === 'file.create' || action === 'link.create') {
    if (!d.id || !String(d.title ?? '').trim()) fail('file_input');
    if (m.files.some((x) => x.id === d.id)) return { id: d.id };
    if (d.folder_id && !m.folders.some((x) => x.id === d.folder_id)) fail('file_input');
    m.files.push({ kind: action === 'file.create' ? 'file' : 'link', folder_id: null, filename: '', mime: '', size: 0, source: action === 'link.create' ? 'drive' : 'upload', drive_id: null,
      category: 'general', tags: [], customer_id: null, deal_id: null, ocr_status: 'none', summary: '', full_text: '', created_by: 'u-me', created_at: now, updated_at: now, deleted_at: null,
      ...d, title: d.title.trim(), storage_path: action === 'file.create' ? d.storage_path : null, link_url: action === 'link.create' ? d.link_url : null });
    out = { id: d.id };
  } else if (action === 'file.update') {
    const f = fileOf(d.id);
    if (f.deleted_at) fail('file_not_found');
    if ('title' in d && !String(d.title).trim()) fail('file_input');
    if (d.folder_id && !m.folders.some((x) => x.id === d.folder_id)) fail('file_input');
    for (const k of ['title', 'category', 'tags', 'customer_id', 'deal_id', 'folder_id']) if (k in d) f[k] = k === 'title' ? d.title.trim() : d[k];
    f.updated_at = now; out = { id: f.id };
  } else if (action === 'file.ocr') {
    const f = fileOf(d.id);
    Object.assign(f, { ocr_status: d.ocr_status, summary: (d.summary ?? f.summary).slice(0, 1900), full_text: (d.full_text ?? f.full_text).slice(0, 100000), updated_at: now });
    out = { id: f.id };
  } else if (action === 'file.trash' || action === 'file.restore' || action === 'file.purge') {
    const ids = new Set(d.ids ?? []);
    const hit = m.files.filter((f) => ids.has(f.id) && (action === 'file.trash' ? !f.deleted_at : !!f.deleted_at));
    if (action === 'file.purge') { m.files = m.files.filter((f) => !hit.includes(f)); for (const f of hit) { try { await del(BLOB(f.id)); } catch { /* 없음 */ } } }
    else hit.forEach((f) => { f.deleted_at = action === 'file.trash' ? now : null; f.updated_at = now; });
    out = { ids: hit.map((f) => f.id) };
  } else if (action === 'folder.create') {
    if (!d.id || !String(d.name ?? '').trim()) fail('file_input');
    if (d.parent_id && !m.folders.some((x) => x.id === d.parent_id)) fail('file_input');
    if (!m.folders.some((x) => x.id === d.id)) m.folders.push({ id: d.id, name: d.name.trim(), parent_id: d.parent_id ?? null, created_by: 'u-me' });
    out = { id: d.id };
  } else if (action === 'folder.rename' || action === 'folder.move' || action === 'folder.delete') {
    const fo = m.folders.find((x) => x.id === d.id) ?? fail('file_not_found');
    if (action === 'folder.rename') { if (!String(d.name ?? '').trim()) fail('file_input'); fo.name = d.name.trim(); }
    else if (action === 'folder.move') { if (!canMoveFolder(m.folders, d.id, d.parent_id ?? null)) fail('file_input'); fo.parent_id = d.parent_id ?? null; }
    else {
      if (m.files.some((f) => f.folder_id === d.id) || m.folders.some((x) => x.parent_id === d.id)) fail('file_folder_not_empty');
      m.folders = m.folders.filter((x) => x.id !== d.id);
    }
    out = { id: d.id };
  } else fail('file_input');
  await save(space, m);
  return out;
}
/* ── 예시 공유 링크(15차) — 서버 office_file_link_*와 같은 판정. 같은 브라우저에서 /f#<토큰>을 열면 이 기록으로 연다 ── */
const LINKS = 'argo-office-files:sample:links';
async function loadLinks() { try { return (await get(LINKS)) ?? mem.get(LINKS) ?? []; } catch { return mem.get(LINKS) ?? []; } }
async function saveLinks(list) { mem.set(LINKS, list); try { await set(LINKS, list); } catch { /* 화면 메모리에만 */ } }
const alive = (l, now = Date.now()) => !l.revoked_at && Date.parse(l.expires_at) > now;
export async function sampleLinkWrite(space, action, d) {
  const links = (await loadLinks()).filter((l) => alive(l)); // 만료·끊은 링크는 여기서 정리(서버는 정리 작업이 지운다)
  if (action === 'link.create') {
    if (!d?.id || !/^[0-9a-f]{64}$/.test(d.token_hash ?? '') || !(d.days >= 1 && d.days <= 90)) fail('file_input');
    const f = (await load(space)).files.find((x) => x.id === d.file_id && !x.deleted_at) ?? fail('file_not_found');
    if (f.kind !== 'file') fail('file_input');
    const same = links.find((l) => l.id === d.id);
    if (same) return { id: same.id, expires_at: same.expires_at };
    if (links.filter((l) => l.file_id === f.id).length >= 20) fail('file_limit');
    const now = Date.now(), l = { id: d.id, space, file_id: f.id, token_hash: d.token_hash, source: d.source === 'mail' ? 'mail' : 'manual', created_at: new Date(now).toISOString(), expires_at: new Date(now + d.days * 864e5).toISOString(), revoked_at: null };
    await saveLinks([...links, l]);
    return { id: l.id, expires_at: l.expires_at };
  }
  if (action === 'link.revoke') {
    const l = links.find((x) => x.id === d?.id && x.space === space) ?? fail('file_not_found');
    l.revoked_at = new Date().toISOString();
    await saveLinks(links);
    return { id: l.id };
  }
  return fail('file_input');
}
export async function sampleLinkList(space, fileId) {
  const links = (await loadLinks()).filter((l) => alive(l) && l.space === space && l.file_id === fileId);
  return { can: true, links: links.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map(({ id, source, created_at, expires_at }) => ({ id, source, created_at, expires_at, mine: true })) };
}
async function linkFile(hash) {
  const l = (await loadLinks()).find((x) => x.token_hash === hash && alive(x));
  const f = l ? (await load(l.space)).files.find((x) => x.id === l.file_id && !x.deleted_at && x.kind === 'file') : null;
  if (!f) fail('gone');
  return { l, f };
}
export async function sampleLinkOpen(hash) {
  const { l, f } = await linkFile(hash);
  return { name: f.filename || f.title, size: f.size ?? 0, mime: f.mime ?? '', expiresAt: l.expires_at, space: l.space }; // 공간 이름은 화면(links.js)이 붙인다(이 파일은 node 시험에서도 읽힌다)
}
export async function sampleLinkBlob(hash) {
  const { f } = await linkFile(hash);
  const blob = await sampleBlobGet(f);
  if (!blob) fail('gone');
  return { blob, name: f.filename || f.title };
}

/** 정리 대상(예시) — 30일 지난 휴지통 파일 */
export async function sampleExpired(space) {
  const m = await load(space);
  return { files: m.files.filter((f) => f.deleted_at && Date.now() - Date.parse(f.deleted_at) > TRASH_DAYS * 864e5).map((f) => ({ id: f.id, path: f.storage_path })), orphans: [] };
}

/* ── 예시 파일 내용 만들기(열 때만) ── */
async function canvasBlob(w, h, draw, type = 'image/png') {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  draw(g, w, h);
  return new Promise((ok) => c.toBlob(ok, type, 0.9));
}
const FONT = (px, w = 400) => `${w} ${px}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif`;
function lines(g, text, x, y, px, gap = 1.55, w = 400) {
  g.fillStyle = '#1a1a1a';
  text.split('\n').forEach((line, i) => { g.font = FONT(i === 0 ? px * 1.5 : px, i === 0 ? 700 : w); g.fillText(line, x, y + (i === 0 ? 0 : px * 0.8 + i * px * gap)); });
}
const docPage = (key) => (g, w) => { g.strokeStyle = '#d6d6d6'; g.lineWidth = 2; g.strokeRect(40, 40, w - 80, 1600); lines(g, T[key], 90, 150, 30); };

/** 그림 한 장을 JPEG로 담은 최소 PDF(A4) — 예시 PDF 미리보기용 */
async function pdfFromCanvas(draw) {
  const jpg = new Uint8Array(await (await canvasBlob(1190, 1684, draw, 'image/jpeg')).arrayBuffer());
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body, stream) => { offs[n] = len; push(`${n} 0 obj\n${body}\n`); if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); } push('endobj\n'); };
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
  obj(4, `<< /Type /XObject /Subtype /Image /Width 1190 /Height 1684 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  obj(5, `<< /Length ${content.length} >>`, enc.encode(content));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offs[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
/** 압축 없이 담은 docx(본문 한 장) */
function docxOf(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  const enc = new TextEncoder(), files = [['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'], ['word/document.xml', xml]];
  const crc = (b) => { let c = -1; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ -1) >>> 0; };
  const out = [], cd = []; let off = 0;
  for (const [name, body] of files) {
    const n = enc.encode(name), d = enc.encode(body), lh = new DataView(new ArrayBuffer(30)), ch = new DataView(new ArrayBuffer(46)), c = crc(d);
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, c, true); lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, n.length, true);
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(6, 20, true); ch.setUint32(16, c, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true); ch.setUint16(28, n.length, true); ch.setUint32(42, off, true);
    out.push(lh, n, d); cd.push(ch, n); off += 30 + n.length + d.length;
  }
  const size = cd.reduce((s, p) => s + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, off, true);
  return new Blob([...out, ...cd, end], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
async function makeSampleBlob(f) {
  const k = f.sampleKind;
  if (k === 'card') return canvasBlob(900, 520, (g) => { g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, 900, 520); g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, 14, 520); lines(g, T.card, 70, 110, 30); });
  if (k === 'bizcert' || k === 'bankbook' || k === 'taxi') return canvasBlob(1000, 1300, (g) => { g.strokeStyle = '#c9c9c9'; g.lineWidth = 3; g.strokeRect(30, 30, 940, 1240); lines(g, T[k], 80, 140, 28); }, k === 'taxi' ? 'image/jpeg' : 'image/png');
  if (k === 'minutes') return docxOf(T.minutes);
  if (k === 'memo') return new Blob([T.memo], { type: 'text/plain' });
  if (T[k]) return pdfFromCanvas(docPage(k));
  return null;
}

/* ── 예시 구글 드라이브(예시 모드에서 연결·탐색·가져오기·링크 흐름을 보여 준다) ── */
const D = (id, name, mimeType, o = {}) => ({ id, name, mimeType, iconLink: null, webViewLink: `https://drive.google.com/file/d/${id}/view`, modifiedTime: ago(o.days ?? 3), size: o.size ?? null, owners: o.owner ?? '김유건', isFolder: mimeType === 'application/vnd.google-apps.folder', sampleKind: o.kind ?? null });
const FOLDER = 'application/vnd.google-apps.folder';
const DRIVE = {
  root: [D('d-f-sales', '영업 자료', FOLDER, { days: 9 }), D('d-f-tax', '세무', FOLDER, { days: 20 }),
    D('d-intro', '회사소개서_2026.pdf', 'application/pdf', { size: 2_310_400, kind: 'conti', days: 12 }),
    D('d-plan', '하반기 사업계획 (구글 문서)', 'application/vnd.google-apps.document', { kind: 'minutes', days: 2 }),
    D('d-sheet', '거래처 연락처 (구글 시트)', 'application/vnd.google-apps.spreadsheet', { days: 5 }),
    D('d-form', '고객 설문 (구글 설문지)', 'application/vnd.google-apps.form', { days: 30 })],
  'd-f-sales': [D('d-q-next', '오름_견적서_v2.pdf', 'application/pdf', { size: 188_200, kind: 'quote', days: 6 }), D('d-card-scan', '명함_스캔_박지현.jpg', 'image/jpeg', { size: 520_100, kind: 'card', days: 4 })],
  'd-f-tax': [D('d-f-2026', '2026', FOLDER, { days: 20 })],
  'd-f-2026': [D('d-inv-09', '9월_세금계산서_모음.pdf', 'application/pdf', { size: 410_002, kind: 'invoice', days: 1 })],
  'd-shared-drive': [D('d-team-guide', '팀 업무 안내.pdf', 'application/pdf', { size: 120_000, kind: 'minutes', days: 15, owner: '최민지' })],
};
const SHARED = [D('d-sh-1', '한빛_요구사항정의서.pdf', 'application/pdf', { size: 640_000, kind: 'contract', days: 3, owner: '김민수(한빛)' })];
export function sampleDriveList({ view = 'mydrive', folder = '', q = '' } = {}) {
  const all = [...Object.values(DRIVE).flat(), ...SHARED];
  if (q.trim()) return { files: all.filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase())), search: true };
  if (folder && folder !== 'root') return { files: DRIVE[folder] ?? [] };
  if (view === 'home') return { files: all.filter((f) => !f.isFolder).sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime)).slice(0, 8) };
  if (view === 'shared') return { files: SHARED };
  if (view === 'drives') return { files: [{ ...D('d-shared-drive', '비욘드웍스 팀 드라이브', FOLDER), webViewLink: 'https://drive.google.com/drive/folders/d-shared-drive' }] };
  if (view === 'starred') return { files: [DRIVE.root[2], DRIVE['d-f-sales'][0]] };
  return { files: DRIVE.root };
}
/** 예시 가져오기 — 구글 문서류는 PDF로 내보낸 것처럼 이름에 .pdf, 시트는 .xlsx */
export function sampleDriveFile(id) { return [...Object.values(DRIVE).flat(), ...SHARED].find((f) => f.id === id) ?? null; }
