// 페이지 트리 '옮기기'의 규칙(16차, PARITY-tasks D6) — 순수 함수만. 창은 pages/tree-actions.jsx, 규칙 시험은 test/tree-model.test.mjs.
// 서버 office_page_move(supabase/migrations/20260927170000_office_pages.sql)와 같은 기준으로 고를 수 있는 상위만 보여 준다 — 눌렀는데 서버가 거절하는 일이 없게.
//   · 같은 공간(내 공간은 같은 주인)의 페이지만, 자기 자신과 하위는 뺀다(서버도 순환을 막는다). 템플릿은 트리에 없으니 뺀다.
//   · 고칠 수 있는 페이지 아래로만(서버: 상위도 편집 권한).
//   · 최상위로는 내 공간이면 누구나, 조직 위키는 관리자만.
//   · 조직 위키에서 관리자가 아니면 비공개 영역을 넘나들 수 없다(서버 검수 M2: 옮겨서 숨김이 풀리거나 생기는 것).

const editable = (p, sample) => p.access === 'edit' || p.access === 'full' || (sample && p.space !== 'shared');
/** 비공개(자신 또는 조상이 비공개) — 서버 office_page_hidden과 같다 */
export function hiddenOf(pages, page) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (let p = page, n = 0; p && n < 64; p = byId.get(p.parent), n++) if (p.restricted) return true;
  return false;
}
const byPos = (a, b) => ((a.position ?? '') < (b.position ?? '') ? -1 : (a.position ?? '') > (b.position ?? '') ? 1 : 0);

/** 옮길 수 있는 곳 — [{ id: null(최상위) | 페이지 id, title, depth, current }] 트리 순서. admin: 그 공간 관리자인가, sample: 예시 데이터 모드 */
export function moveTargets(pages, page, { admin = false, sample = false } = {}) {
  const space = pages.filter((p) => !p.template && p.space === page.space && (page.space !== 'shared' || p.owner === page.owner));
  const guard = page.space !== 'me' && !admin;                                      // 조직 위키의 일반 멤버
  const keepsHidden = (target) => hiddenOf(pages, page) === (!!page.restricted || (!!target && hiddenOf(pages, target)));
  const ok = (target) => (target ? editable(target, sample) : page.space === 'me' || admin) && (!guard || keepsHidden(target));
  const out = [];
  if (ok(null)) out.push({ id: null, title: '', depth: 0, current: (page.parent ?? null) === null });
  const walk = (parent, depth) => { // 위에서부터 내려가며 옮길 페이지는 건너뛴다 — 그 아래(하위 페이지)는 아예 들르지 않는다
    for (const p of space.filter((x) => (x.parent ?? null) === parent && x.id !== page.id).sort(byPos)) {
      if (ok(p)) out.push({ id: p.id, title: p.title, depth, current: p.id === page.parent });
      walk(p.id, depth + 1);                                                      // 고를 수 없는 페이지 아래에도 고를 수 있는 페이지가 있을 수 있다
    }
  };
  walk(null, 0);
  return out;
}

/** 찾기 — 이름에 글자가 들어간 곳(대소문자 무시). 빈 검색이면 전부 */
export const filterTargets = (list, q, untitled = '') => {
  const s = String(q ?? '').trim().toLowerCase();
  return s ? list.filter((x) => x.id && (x.title || untitled).toLowerCase().includes(s)) : list;
};
