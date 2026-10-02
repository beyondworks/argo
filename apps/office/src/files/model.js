// 문서함 규칙(순수 함수) — 화면·예시 저장소·서버 함수가 같은 판정을 쓴다. 규칙은 test/files-model.test.mjs.
// 인트라넷 근거: app/documents/page.tsx(분류·배지), app/api/documents/upload/route.ts(유형·허용 형식), lib/docgen/save.ts(거래처 연결).
import { fileKind } from '../core/files.js';
import { RULES, BODY, PHONE, EMAIL } from './rules.js';

/** 분류 — 인트라넷 7종(견적서·계약서·사업자등록증·명함·증빙·보관·일반) + 거래처 첨부의 통장사본. 이 순서로 묶어 보인다 */
export const CATEGORIES = ['quote', 'contract', 'bizcert', 'card', 'bankbook', 'evidence', 'archive', 'general'];
/** 거래처 첨부 종류(인트라넷 customers/page.tsx:80 사업자등록증·통장사본·계약서·기타 + 명함) */
export const CUSTOMER_TYPES = ['bizcert', 'bankbook', 'contract', 'card', 'general'];
export const MAX_BYTES = 50 * 1024 * 1024; // 오피스 파일 상한(core/files.js MAX_FILE, 버킷 file_size_limit과 같다)
export const TRASH_DAYS = 30;              // 휴지통 보존(페이지 휴지통과 같은 값 — 유건 승인 2026-09-26)
export const SUMMARY_MAX = 1900, TEXT_MAX = 100_000;
/** 쓴 용량 / 한도(LOW-B) — 목록이 주는 usage(판정과 같은 함수)를 그대로. 한도의 80%부터 안내 한 줄. 요금제 이름·가격은 넣지 않는다(결제 연결 때) */
export function usageInfo(u) {
  if (!u || !(u.quota > 0) || !(u.used >= 0)) return null;
  return { used: u.used, quota: u.quota, ratio: u.used / u.quota, near: u.used >= u.quota * 0.8 };
}
/** 용량 글자 — GB(2^30)까지. 판정 숫자와 같은 단위 */
export const fmtSize = (n) => (n >= 1073741824 ? `${+(n / 1073741824).toFixed(n % 1073741824 ? 1 : 0)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
/** 서버·DB 오류 코드 → 화면 문구 키(files.err.<값>) — 모든 값에 ko/en 문구가 있어야 한다(test/files-model.test.mjs) */
export const FILE_ERRORS = { file_forbidden: 'permission', file_input: 'input', file_not_found: 'missing', file_missing: 'missing', file_conflict: 'conflict', file_limit: 'limit', file_quota: 'quota',
  file_folder_not_empty: 'notEmpty', task_signin: 'signin', file_daily_limit: 'daily', file_too_big: 'too_big', uploads_paused: 'paused', file_size_mismatch: 'request',
  file_expired: 'uploadExpired', r2_not_configured: 'storage', storage: 'storage' };

const OFFICE_DOC = /\.(docx?|xlsx?|pptx?|hwpx?|hwp|odt|ods|odp|rtf|csv|txt|md|pages|numbers|key|json|xml)$/i;
/** 유형(인트라넷 4종): pdf · image · doc(문서) · other. svg는 그림으로 보이지 않는다(받기만) */
export function kindOf(name = '', mime = '') {
  const k = fileKind(name, mime);
  if (k === 'pdf') return 'pdf';
  if (k === 'image') return 'image';
  if (k === 'md' || k === 'text' || OFFICE_DOC.test(name) || /officedocument|msword|ms-excel|ms-powerpoint|opendocument|hwp/i.test(mime ?? '')) return 'doc';
  return 'other';
}
/** 글자 읽기(OCR) 대상 — PDF·그림 */
export const ocrable = (f) => f?.kind !== 'link' && ['pdf', 'image'].includes(kindOf(f?.filename || f?.title, f?.mime));

const ALLOWED = ['image/', 'text/', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.', 'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.', 'application/json', 'application/csv', 'application/xml', 'application/zip',
  'application/x-hwp', 'application/haansofthwp', 'application/vnd.hancom.'];
/** 올릴 수 있는가 — 크기 상한, 형식 허용 목록(모르는 형식 application/octet-stream·빈 값은 확장자로 다시 본다 — 인트라넷과 같다) */
export function uploadCheck(file) {
  if (!file || !file.name) return 'input';
  if (file.size > MAX_BYTES) return 'tooBig';
  if (file.size === 0) return 'empty';
  const mime = (file.type || '').toLowerCase();
  if (!mime || mime === 'application/octet-stream') return null;
  if (mime === 'text/html' || mime === 'image/svg+xml' || mime === 'application/xhtml+xml') return null; // 받기만 되고 열리지 않는다(스크립트를 품을 수 있다)
  return ALLOWED.some((p) => mime.startsWith(p)) || /^(video|audio)\//.test(mime) ? null : 'type';
}

/** Storage 경로 이름 — 확장자는 살리고 경로·제어 문자를 뺀다(원래 이름은 filename 칸에 따로 둔다) */
export function safeName(name = 'file') {
  const s = String(name).normalize('NFC').replace(/\.{2,}/g, '').replace(/[\\/\u0000-\u001f\u007f]+/g, '_').replace(/^\.+/, '').trim();
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(s);
  const ext = m ? m[1] : '', base = (m ? s.slice(0, -ext.length) : s).replace(/[^\p{L}\p{N} ._()-]+/gu, '_').slice(0, 100) || 'file';
  return base + ext;
}
/** Storage 경로 — 범위 칸('o-<조직>'|'u-<사람>')/파일 id/이름. 서버 office_file_write가 같은 모양을 검사한다 */
export const storagePath = (seg, id, name) => `${seg}/${id}/${safeName(name)}`;
export const segOf = (org, uid) => (org ? `o-${org}` : `u-${uid}`);

/** 자동 분류 — 이름 먼저(사람이 붙인 이름이 가장 확실), 다음 읽은 글자. 그림인데 글자가 짧고 전화·메일이 함께 있으면 명함. 못 정하면 일반 */
export function classify({ name = '', text = '', mime = '' } = {}) {
  for (const [cat, re] of RULES) if (re.test(name)) return cat;
  const body = String(text).slice(0, 4000);
  if (body) {
    for (const [cat, test] of BODY) if (test(body)) return cat;
    if (kindOf(name, mime) === 'image' && body.length < 600 && PHONE.test(body) && EMAIL.test(body)) return 'card';
  }
  return 'general';
}

const nfc = (s) => String(s ?? '').normalize('NFC').trim();
/** 고객사명 → 거래처(인트라넷 docgen/save.ts:9-19와 같은 규칙): 정확 일치 먼저, 없으면 포함 일치가 하나일 때만. 애매하면 연결하지 않는다 */
export function matchCustomer(name, customers = []) {
  const q = nfc(name);
  if (!q) return null;
  const exact = customers.find((c) => nfc(c.name) === q);
  if (exact) return exact;
  const part = customers.filter((c) => nfc(c.name).length >= 2 && (nfc(c.name).includes(q) || q.includes(nfc(c.name))));
  return part.length === 1 ? part[0] : null;
}
const digits = (s) => String(s ?? '').replace(/\D/g, '');
/** 읽은 글자·이름에서 거래처 찾기 — 사업자번호(10자리)가 맞으면 그 거래처, 아니면 이름이 하나만 나올 때만 */
export function findCustomer({ name = '', text = '' } = {}, customers = []) {
  const hay = nfc(`${name}\n${text}`);
  const nos = new Set([...hay.matchAll(/\d{3}-?\d{2}-?\d{5}/g)].map((m) => digits(m[0])));
  const byNo = customers.filter((c) => digits(c.biz_no).length === 10 && nos.has(digits(c.biz_no)));
  if (byNo.length === 1) return byNo[0];
  const named = customers.filter((c) => nfc(c.name).length >= 2 && hay.includes(nfc(c.name)));
  return named.length === 1 ? named[0] : null;
}

/** 요약·전문 자르기(인트라넷과 같다: 요약 1,900자, 전문 10만 자) */
export const clip = (text) => { const s = String(text ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); return { summary: s.slice(0, SUMMARY_MAX), full_text: s.slice(0, TEXT_MAX) }; };

/** 예시 저장소·화면 검색 — 제목·파일명·본문·태그(대소문자·정규화 무시). 서버는 같은 칸을 ilike로 본다 */
export function matches(f, q) {
  const s = nfc(q).toLowerCase();
  if (!s) return true;
  return [f.title, f.filename, f.full_text ?? f.summary, (f.tags ?? []).join(' ')].some((v) => nfc(v).toLowerCase().includes(s));
}

/** 화면 필터 — 분류(null=전체)·거래처·폴더(undefined = 폴더 무시, null = 맨 위) */
export function filterFiles(files, { category = null, customer = null, folder } = {}) {
  return files.filter((f) => (!category || (f.category ?? 'general') === category) && (!customer || f.customer_id === customer)
    && (folder === undefined || (f.folder_id ?? null) === folder));
}
/** 분류별 건수 */
export function countBy(files, key = (f) => f.category ?? 'general') {
  const m = {};
  for (const f of files) { const k = key(f); m[k] = (m[k] ?? 0) + 1; }
  return m;
}
/** 거래처 허브처럼 분류 순서로 묶기(인트라넷 customer-hub.tsx:204-213) — [[분류, 파일들]] */
export function groupByCategory(files) {
  const m = new Map();
  for (const f of files) { const k = f.category ?? 'general'; if (!m.has(k)) m.set(k, []); m.get(k).push(f); }
  return [...m].sort((a, b) => CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]));
}
/** 많은 분류 3개 '견적서 3 · 계약서 1'(허브 상단 카드 customer-hub.tsx:314) — label(분류) 사전 함수 */
export const topCategories = (files, label, n = 3) => groupByCategory(files).sort((a, b) => b[1].length - a[1].length).slice(0, n).map(([c, l]) => `${label(c)} ${l.length}`).join(' · ');

/** 사업자등록증 미보유 활성 거래처(인트라넷 customers/page.tsx:333-339) — 종료한 거래처는 빼고 */
export function missingBizcert(customers = [], files = []) {
  const have = new Set(files.filter((f) => f.category === 'bizcert' && f.customer_id && !f.deleted_at).map((f) => f.customer_id));
  return customers.filter((c) => (c.status ?? 'active') !== 'closed' && !have.has(c.id));
}

/** 폴더 경로(맨 위 → 지금) */
export function folderPath(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = [];
  for (let cur = byId.get(id), guard = 0; cur && guard < 64; cur = byId.get(cur.parent_id), guard++) out.unshift(cur);
  return out;
}
/** 옮길 수 있는 곳인가 — 자기 자신·자기 아래로는 못 옮긴다(서버 folder.move와 같은 판정) */
export function canMoveFolder(folders, id, parent) {
  if (parent == null) return true;
  return !folderPath(folders, parent).some((f) => f.id === id);
}
/** 폴더 안 바로 아래 폴더(이름순) */
export const childFolders = (folders, parent) => folders.filter((f) => (f.parent_id ?? null) === (parent ?? null)).sort((a, b) => a.name.localeCompare(b.name));

/** 휴지통에서 정리할 때가 지났나 */
export const expired = (f, now = Date.now()) => !!f.deleted_at && now - Date.parse(f.deleted_at) > TRASH_DAYS * 864e5;
/** 휴지통 남은 날 */
export const daysLeft = (f, now = Date.now()) => Math.max(0, TRASH_DAYS - Math.floor((now - Date.parse(f.deleted_at)) / 864e5));

/** 태그 입력 '견적서, 한빛 ,  ' → ['견적서','한빛'] (20개·40자까지 — 서버와 같다) */
export const parseTags = (s) => [...new Set(String(s ?? '').split(/[,#\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 20).map((x) => x.slice(0, 40));

/** 정리 실행 시점 — 사람·기기당 하루 한 번(DB 위생: 정리 목록 호출이 화면을 열 때마다 나가지 않게) */
export const purgeDue = (last, now = Date.now()) => !last || now - Number(last) > 864e5;

/** 여러 파일 올리기 결과 요약 — { ok, failed } → 토스트 사전 키·값(인트라넷 documents/page.tsx:169-177) */
export function uploadSummary(names, results) {
  const ok = results.filter((r) => r === true).length, failed = results.length - ok;
  if (!failed) return names.length === 1 ? { key: 'files.uploaded1', vars: { name: names[0] } } : { key: 'files.uploadedN', vars: { n: ok } };
  return { key: 'files.uploadedMixed', vars: { ok, failed } };
}

/** 문서함 머리 ⋯ 메뉴(유건 10/2 10차 — '새로고침' 하나라 눌러도 반응이 없어 보였다). 탭마다 그 화면에서 할 수 있는 일: 화면이 id를 메뉴 항목으로 바꾼다 */
export function pageMenuIds(tab, { rows = 0, allSelected = false, purgeable = 0 } = {}) {
  if (tab === 'trash') return ['refresh', 'sep', purgeable ? 'emptyTrash' : 'emptyTrash:off'];
  if (tab === 'customers') return ['refresh', 'drive'];
  return ['refresh', 'newFolder', 'drive', ...(rows ? [allSelected ? 'selNone' : 'selAll'] : [])];
}
