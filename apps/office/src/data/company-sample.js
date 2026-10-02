// 예시 데이터 — 회사 정보·직원 명부·평가 레포트(트랙 C). 서버 함수(office_company_* · office_people_* · office_perf_eval_*)와 같은 모양.
// 회사·사람·번호·주소는 전부 가상이다. 쓰기는 화면 메모리에만 남는다(새로고침하면 처음으로).
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const shift = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthOf = (day, back) => { const [y, m] = day.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 - back, 1)); const from = t.toISOString().slice(0, 10); return { from, to: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) }; };
const weekOf = (day, back) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * back); const from = d.toISOString().slice(0, 10); return { from, to: shift(from, 6) }; };
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
const uid = () => crypto.randomUUID();

const item = (category, key, label, value, extra = {}) => ({ id: uid(), key, category, label, value, notes: '', position: 0, redacted: category === 'bank' || key === 'biz_no', updated_at: ago(3), source: null, ...extra });
function companyItems(space) {
  if (space !== 'beyondworks') return [item('basic', 'name', '상호', '린 스튜디오(예시)'), item('contact', 'email', '대표 이메일', 'hello@lean-studio.example')];
  const list = [
    item('basic', 'name', '상호', '(주)비욘드웍스(예시)'), item('basic', 'ceo', '대표자', '김유건'), item('basic', 'biz_no', '사업자등록번호', '000-00-00000'),
    item('basic', 'open_date', '개업일', '2025-01-02'), item('basic', 'address', '사업장 소재지', '서울특별시 가상구 예시로 12, 3층'),
    item('bank', null, '주거래 계좌', '예시은행 000-000000-00-000 (예금주 비욘드웍스)', { notes: '견적서 입금 안내에 나갑니다' }), item('bank', null, '부가세 계좌', '예시은행 111-111111-11-111'),
    item('contact', 'manager', '담당자', '김유건'), item('contact', 'phone', '대표 전화', '02-000-0000'), item('contact', 'email', '대표 이메일', 'contact@beyondworks.example'),
    item('contact', 'website', '홈페이지', 'https://beyondworks.example'),
    item('tax', 'biz_type', '업태', '정보통신업, 전문·과학 및 기술서비스업'), item('tax', 'biz_item', '종목', '응용 소프트웨어 개발 및 공급업'),
    item('tax', 'tax_email', '세금계산서 이메일', 'tax@beyondworks.example'), item('tax', null, '관할 세무서', '가상세무서', { notes: '부가세 신고는 분기마다' }),
    item('other', null, '회사 도장 보관', '대표 책상 둘째 서랍'), // 도장 그림은 예시에도 없다 — 회사가 PNG를 올려야 생긴다(유건 10/2 13차)
  ];
  const pos = {};
  return list.map((x) => ({ ...x, position: (pos[x.category] = (pos[x.category] ?? -1) + 1) }));
}

const person = (p) => ({ id: uid(), user_id: null, title: '', department: '', email: '', phone: '', agent: '', joined_on: null, left_on: null, account_role: null, status: 'active', notes: '', account_name: null, ...p });
function people(space) {
  if (space !== 'beyondworks') return [person({ id: null, user_id: 'u-me', name: '김유건', account_role: 'member', joined_on: '2026-03-01' }), person({ id: null, user_id: 'u-lee', name: '이도윤', account_role: 'owner', joined_on: '2026-01-10' })];
  return [
    person({ user_id: 'u-me', name: '김유건', title: '대표', department: '경영', email: 'yoogeon@beyondworks.example', phone: '010-0000-0001', agent: 'Claude Code', joined_on: '2025-01-02', account_role: 'owner', account_name: '김유건' }),
    person({ user_id: 'u-minji', name: '최민지', title: '디자이너', department: '제작', email: 'minji@beyondworks.example', phone: '010-0000-0002', agent: 'Codex', joined_on: '2025-06-16', account_role: 'member', account_name: '최민지', notes: '10월 연봉 협상 예정' }),
    person({ name: '박서준', title: '영업', department: '영업', email: 'seojun@beyondworks.example', phone: '010-0000-0003', agent: 'Hermes', joined_on: '2026-02-02' }),
    person({ id: null, user_id: 'u-jiho', name: '한지호', email: '', joined_on: '2026-09-01', account_role: 'admin', notes: null }),
    person({ name: '이하은', title: '마케터', department: '마케팅', email: 'haeun@beyondworks.example', joined_on: '2025-03-04', left_on: '2026-06-30', status: 'left', notes: '퇴사 — 인수인계 완료' }),
  ];
}

const REVIEW = `## 총평
이번 달은 **견적 회신 속도**가 눈에 띄게 빨라졌다. 신규 거래처 2곳과 계약까지 갔다.

| 평가 그룹 | 근거 | 점수 |
| --- | --- | --- |
| 업무성과 | 계약 2건, 청구 3건 | 85 |
| 업무품질 | 수정 요청 1건 | 78 |
| 협업태도 | 요청 응답 평균 35분 | 92 |

- 다음 달: 제안서 템플릿 정리
- 거래처 메일 '주의' 1건 후속 확인`;
function evals(space) {
  const today = kstToday();
  if (space !== 'beyondworks') {
    const m = monthOf(today, 1);
    return [{ id: uid(), subject_kind: 'person', subject_user: 'u-me', subject_name: '김유건', subject_type: 'staff', scope: 'month', period_from: m.from, period_to: m.to, period_label: '', title: '월간 평가', performance: 82, quality: 76, productivity: 88, expertise: 70, collaboration: 90, total: 81, review: REVIEW, work: '- 랜딩 페이지 문구 정리\n- 사용자 인터뷰 3건', achievements: '- 전환율 1.2%p 개선', basis: null, author_kind: 'person', author_name: '이도윤', replaces: null, replaced_by: null, source: null, created_at: ago(2) }];
  }
  const out = [];
  const add = (e) => { const x = { id: uid(), subject_kind: 'person', subject_user: null, subject_type: 'staff', period_label: '', review: '', work: '', achievements: '', basis: null, author_kind: 'person', author_name: '김유건', replaces: null, replaced_by: null, source: null, created_at: ago(out.length + 1), ...e }; out.push(x); return x; };
  const sc = (p, q, r, x, c) => ({ performance: p, quality: q, productivity: r, expertise: x, collaboration: c, total: Math.round((p + q + r + x + c) / 5) });
  [3, 2, 1].forEach((back, i) => { const m = monthOf(today, back); add({ subject_user: 'u-minji', subject_name: '최민지', scope: 'month', period_from: m.from, period_to: m.to, title: `${m.from.slice(0, 7)} 월간 평가`, ...sc(70 + i * 6, 68 + i * 5, 75 + i * 4, 66 + i * 3, 80 + i * 4), review: i === 2 ? REVIEW : '## 총평\n꾸준히 맡은 일을 기한 안에 끝냈다.', work: '- 브랜드 가이드 2차\n- 상세 페이지 3종', achievements: '- 거래처 시안 1회 통과', basis: i === 2 ? { kind: 'review', period: m.from.slice(0, 7), status: 'shared', totals: { contract: 4200000, paid: 3300000, tasks_done: 18, tasks_due: 15, tasks_on_time: 13, tasks_done_due: 14, approvals: 6, pages: 9, crew: 4 } } : null }); });
  const w = weekOf(today, 1);
  add({ subject_user: 'u-minji', subject_name: '최민지', scope: 'week', period_from: w.from, period_to: w.to, title: '주간 평가', ...sc(84, 80, 86, 72, 90), author_kind: 'crew', author_name: '페퍼', review: '일간 브리핑 5건을 근거로 정리했다.' });
  const m1 = monthOf(today, 1);
  const first = add({ subject_user: 'u-me', subject_name: '김유건', subject_type: 'ceo', scope: 'month', period_from: m1.from, period_to: m1.to, title: '대표 월간 점검', ...sc(88, 74, 80, 85, 70) });
  const fixed = add({ subject_user: 'u-me', subject_name: '김유건', subject_type: 'ceo', scope: 'month', period_from: m1.from, period_to: m1.to, title: '대표 월간 점검(고침)', ...sc(88, 78, 80, 85, 72), replaces: first.id, review: '협업 점수를 회의록 근거로 다시 매김.' });
  first.replaced_by = fixed.id;
  [2, 1].forEach((back, i) => { const m = monthOf(today, back); add({ subject_kind: 'crew', subject_name: '루나', subject_type: 'agent', scope: 'month', period_from: m.from, period_to: m.to, title: '루나 월간 평가', ...sc(76 + i * 8, 82, 90, 70 + i * 6, 74), author_name: '김유건', work: '- 견적서 초안 12건\n- 거래처 메일 분류', achievements: '- 재견적 응답 하루 안에' }); });
  const y = String(Number(today.slice(0, 4)) - 1);
  add({ subject_kind: 'crew', subject_name: '페퍼', subject_type: 'agent', scope: 'year', period_from: `${y}-01-01`, period_to: `${y}-12-31`, period_label: `${y}년`, title: `${y} 연간 평가`, ...sc(80, 77, 92, 74, 81), author_kind: 'import', author_name: '페퍼', source: 'notion', review: '노션에서 옮긴 레포트입니다.' });
  return out;
}

const store = new Map();
const of = (space) => { if (!store.has(space)) store.set(space, { items: companyItems(space), deleted: [], people: people(space), evals: evals(space) }); return store.get(space); };
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export const sampleCompany = (space, manager) => { const s = of(space); return { role: manager ? 'manager' : 'member', items: s.items.map((x) => ({ ...x })), deleted: manager ? s.deleted.map(({ history_id, label, category, at }) => ({ history_id, label, category, at })) : [] }; };
export function sampleCompanyWrite(space, action, data) {
  const s = of(space);
  if (action === 'items.order') { data.ids.forEach((id, i) => { const x = s.items.find((y) => y.id === id); if (x) x.position = i; }); s.items.sort((a, b) => a.position - b.position); return { ok: true }; }
  if (action === 'item.restore') { const h = s.deleted.find((x) => x.history_id === data.history_id); if (!h) fail('company_not_found'); s.deleted = s.deleted.filter((x) => x !== h); s.items.push(h.before); return { ok: true, item: h.before }; }
  const i = s.items.findIndex((x) => x.id === data.id);
  if (action === 'item.delete') { if (i >= 0) { s.deleted.unshift({ history_id: Date.now(), label: s.items[i].label, category: s.items[i].category, at: new Date().toISOString(), before: s.items[i] }); s.items.splice(i, 1); } return { ok: true }; }
  if (data.key && s.items.some((x) => x.key === data.key && x.id !== data.id)) fail('company_key');
  const next = { ...(i >= 0 ? s.items[i] : { position: s.items.filter((x) => x.category === data.category).length, source: null }), ...data, redacted: data.redacted ?? (i >= 0 ? s.items[i].redacted : data.category === 'bank' || data.key === 'biz_no'), updated_at: new Date().toISOString() };
  if (i >= 0) s.items[i] = next; else s.items.push(next);
  return { ok: true, item: next };
}

export const samplePeople = (space, manager, me) => ({ role: manager ? 'manager' : 'member', me, people: of(space).people.map((p) => ({ ...p, notes: manager ? p.notes : null, email: manager || p.id ? p.email : '' })) });
export function samplePeopleWrite(space, action, data) {
  const s = of(space);
  if (action === 'person.delete') { s.people = s.people.filter((p) => p.id !== data.id); return { ok: true }; }
  const i = s.people.findIndex((p) => p.id === data.id);
  const acct = data.user_id ? s.people.find((p) => p.user_id === data.user_id) : null;
  const status = data.left_on && data.left_on <= kstToday() ? 'left' : 'active';
  const next = { ...(i >= 0 ? s.people[i] : {}), ...data, account_role: acct?.account_role ?? null, account_name: acct?.name ?? null, status };
  if (acct && acct.id === null) s.people = s.people.filter((p) => p !== acct); // 계정 행은 명부 행으로 바뀐다
  const j = s.people.findIndex((p) => p.id === data.id);
  if (j >= 0) s.people[j] = next; else s.people.push(next);
  return { ok: true, id: data.id };
}

export const sampleEvals = (space, manager, me) => ({ role: manager ? 'manager' : 'member', me, evals: of(space).evals.filter((e) => manager || e.subject_user === me).map((e) => ({ ...e })) });
export function sampleEvalWrite(space, data, authorName) {
  const s = of(space);
  if (s.evals.some((e) => e.id === data.id)) return { ok: true, eval: s.evals.find((e) => e.id === data.id) };
  const prev = data.replaces ? s.evals.find((e) => e.id === data.replaces) : null;
  if (data.replaces && (!prev || prev.replaced_by)) fail('perf_conflict');
  const base = prev ? { subject_kind: prev.subject_kind, subject_user: prev.subject_user, subject_name: prev.subject_name, subject_type: prev.subject_type, scope: prev.scope, period_from: prev.period_from, period_to: prev.period_to }
    : { subject_kind: data.subject_kind, subject_user: data.subject_user ?? null, subject_name: data.subject_name ?? s.people.find((p) => p.user_id === data.subject_user)?.name ?? '?', subject_type: data.subject_kind === 'crew' ? 'agent' : data.subject_type ?? 'staff', scope: data.scope, period_from: data.from, period_to: data.to };
  const scores = ['performance', 'quality', 'productivity', 'expertise', 'collaboration'].map((k) => data[k]).filter((v) => v != null);
  const e = { ...base, id: data.id, title: data.title, performance: data.performance, quality: data.quality, productivity: data.productivity, expertise: data.expertise, collaboration: data.collaboration,
    total: data.total ?? (scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null), review: data.review ?? '', work: data.work ?? '', achievements: data.achievements ?? '',
    period_label: '', basis: null, author_kind: 'person', author_name: authorName, replaces: data.replaces ?? null, replaced_by: null, source: null, created_at: new Date().toISOString() };
  if (prev) prev.replaced_by = e.id;
  s.evals.unshift(e);
  return { ok: true, eval: e };
}
