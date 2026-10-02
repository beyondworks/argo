// 회사 정보 규칙(트랙 C, 유건 10/2) — 화면·읽기 API·이관 스크립트가 같이 쓰는 순수 함수. DB·화면 없이 테스트한다.
// 인트라넷은 항목·값·분류·메모 네 칸의 자유 목록이었다. 오피스는 그 자유 목록을 그대로 두고, 견적·계약 서식이 찾는 항목에만 key를 붙인다.

import { COMPANY_KEY_LABELS, CATEGORY_FROM_KO } from './match-i18n.js';

export const CATEGORIES = ['basic', 'bank', 'contact', 'tax', 'other'];
// 인트라넷 분류 이름 → 오피스 분류(없거나 모르는 분류는 기타 — 인트라넷의 '미분류' 묶음) — match-i18n.js
export { CATEGORY_FROM_KO };

// 서식이 찾는 항목(순서 = 화면의 '서식에 들어가는 값' 순서). 분류는 새로 만들 때의 기본값
export const COMPANY_KEYS = [
  ['name', 'basic'], ['reg_name', 'basic'], ['ceo', 'basic'], ['biz_no', 'basic'], ['corp_no', 'basic'], ['open_date', 'basic'], ['address', 'basic'],
  ['biz_type', 'tax'], ['biz_item', 'tax'], ['tax_email', 'tax'],
  ['manager', 'contact'], ['phone', 'contact'], ['fax', 'contact'], ['email', 'contact'], ['website', 'contact'],
  ['seal', 'basic'], ['logo', 'basic'], // 도장·로고 그림(트랙 A 계약서 도장·배너 — 값 = data:image 또는 https 주소)
];
export const IMAGE_KEYS = ['seal', 'logo'];
export const isImage = (v) => /^(data:image\/(png|jpeg|webp|svg\+xml);base64,|https:\/\/)/.test(String(v ?? ''));
export const KEY_CATEGORY = Object.fromEntries(COMPANY_KEYS);
// 견적서·계약서 공급자 칸에 실제로 찍히는 값(인트라넷 lib/docgen/render.ts SUPPLIER와 같은 칸) — 비어 있으면 화면이 알려 준다
export const DOC_KEYS = ['name', 'ceo', 'biz_no', 'address', 'open_date', 'biz_type', 'biz_item', 'manager', 'phone', 'email'];

// 항목 이름으로 key 짐작(이관·새 항목의 기본값). 공백·괄호·대소문자를 무시하고 전체가 같을 때만
// 항목 이름 표는 한글 원문이라 사전 파일(match-i18n.js)에 둔다
const LABELS = COMPANY_KEY_LABELS;
const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/[\s()·_.:-]/g, '');
const BY_LABEL = new Map(Object.entries(LABELS).flatMap(([key, names]) => names.map((n) => [norm(n), key])));
export const guessKey = (label) => BY_LABEL.get(norm(label)) ?? null;

/** 분류별로 묶기(서버 순서 유지) — 빈 분류는 뺀다 */
export function groupItems(items) {
  return CATEGORIES.map((c) => ({ category: c, items: (items ?? []).filter((x) => (CATEGORIES.includes(x.category) ? x.category : 'other') === c) })).filter((g) => g.items.length);
}

/** key가 붙은 항목 먼저, 없으면 이름 짐작으로 — 하나의 값 */
function pick(items, key) {
  const byKey = items.find((x) => x.key === key && x.value);
  if (byKey) return byKey.value;
  return items.find((x) => !x.key && x.value && guessKey(x.label) === key)?.value ?? '';
}

/**
 * 견적·계약 서식이 쓰는 회사 정보(트랙 A가 읽는다). 값이 없으면 빈 글자 — 서식이 빈칸으로 둔다.
 * accounts: 계좌 분류의 항목 전부({ label, value }), missing: DOC_KEYS 중 빈 칸
 */
export function companyProfile(items = []) {
  const list = Array.isArray(items) ? items : [];
  const v = Object.fromEntries(COMPANY_KEYS.map(([k]) => [k, pick(list, k)]));
  return {
    name: v.name, regName: v.reg_name, ceo: v.ceo, bizNo: v.biz_no, corpNo: v.corp_no, openDate: v.open_date, address: v.address,
    bizType: v.biz_type, bizItem: v.biz_item, taxEmail: v.tax_email, manager: v.manager, phone: v.phone, fax: v.fax, email: v.email, website: v.website,
    seal: isImage(v.seal) ? v.seal : '', logo: isImage(v.logo) ? v.logo : '', // 그림이 아니면 빈 값(서식은 글자로 대신)
    accounts: list.filter((x) => x.category === 'bank' && x.value).map((x) => ({ label: x.label, value: x.value })),
    missing: DOC_KEYS.filter((k) => !v[k]),
  };
}

/** 저장 전 입력 정리 — 화면 폼 → 서버 item.save. 이름이 비면 null(저장 막기) */
export function itemPayload(form) {
  const label = String(form.label ?? '').trim();
  if (!label) return null;
  return {
    id: form.id, label: label.slice(0, 100), value: String(form.value ?? '').trim().slice(0, IMAGE_KEYS.includes(form.key) ? 200000 : 2000), notes: String(form.notes ?? '').trim().slice(0, 2000),
    category: CATEGORIES.includes(form.category) ? form.category : 'other', key: KEY_CATEGORY[form.key] ? form.key : null,
    ...(typeof form.redacted === 'boolean' ? { redacted: form.redacted } : {}),
  };
}

/** 한 분류 안에서 id를 위(-1)·아래(+1)로 — 바뀐 순서의 id 목록(못 움직이면 null) */
export function moveInCategory(items, id, dir) {
  const cat = items.find((x) => x.id === id)?.category;
  const ids = items.filter((x) => x.category === cat).map((x) => x.id);
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}

/** '서식' 표(항목이 견적서·계약서의 어느 칸에 들어가는지) 메뉴(유건 10/2 10차 — 눌러도 반응이 없었다).
 *  누구나 그 칸이 실제로 들어가는 견적서·계약서 작성 화면을 열어 볼 수 있고, 관리자는 어느 칸으로 갈지 바꾼다(항목 수정 창). 돌려주는 값은 화면이 메뉴로 바꾼다 */
export function keyMenu(item, { manager = false } = {}) {
  if (!item?.key || !KEY_CATEGORY[item.key]) return [];
  const view = DOC_KEYS.includes(item.key) || IMAGE_KEYS.includes(item.key);
  return [
    ...(view ? [{ id: 'quote', to: 'contracts?new=quote' }, { id: 'contract', to: 'contracts?new=contract' }] : []),
    ...(manager ? [{ id: 'change', edit: true }] : []),
  ];
}
