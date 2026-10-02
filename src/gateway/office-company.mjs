// 에이전트 회사 도구(office) — 아르고 오피스의 회사 정보·직원 명부·평가 레포트를 주인의 기기 세션으로 읽고 쓴다(트랙 C, 유건 10/2).
// 인트라넷 에이전트 도구(company_list·company_add·company_update·employees_list·report_list·report_add)를 오피스로 옮긴 것 — "에이전트도 오피스로 쓴다".
// 다루는 조직은 지금 메신저 조직 채널의 그 조직뿐(다른 조직 내용이 이 채널로 새지 않게). 쓰기는 서버가 관리자인지 판정한다(주인이 관리자일 때만 된다).
// 직원 메모는 관리자 전용 기록이라 도구 출력에 싣지 않는다. 손님 턴 거절은 chat.mjs 처리기가 이 함수보다 먼저 한다.
import { randomUUID } from 'node:crypto';

export const companyDeps = {
  session: async () => (await import('./msgr.mjs')).sessionClient(),
  now: () => Date.now(),
  newId: () => randomUUID(),
};

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
const CATS = ['basic', 'bank', 'contact', 'tax', 'other'];
const CAT_NAME = { basic: ['기본정보', 'basic'], bank: ['계좌', 'bank'], contact: ['연락처', 'contact'], tax: ['세무', 'tax'], other: ['기타', 'other'] };
const SCORES = ['performance', 'quality', 'productivity', 'expertise', 'collaboration'];
const KEYS = ['name', 'reg_name', 'ceo', 'biz_no', 'corp_no', 'open_date', 'address', 'biz_type', 'biz_item', 'manager', 'phone', 'fax', 'email', 'tax_email', 'website'];
export const LIST_CAP = 60;

// 호출 이름은 글자 그대로 둔다 — 크루 계약 레지스트리(test/crew-contract.test.mjs)가 src/gateway의 rpc('…')를 찾아 분류를 강제한다
function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message ?? String(error)), { rpc: true });
  return data;
}
const ERRORS = {
  company_forbidden: ['권한이 없다(회사 정보·직원 명부는 조직 관리자만 고친다)', 'not allowed (only organization admins can edit)'],
  perf_forbidden: ['권한이 없다(평가 레포트는 조직 관리자만 쓴다)', 'not allowed (only organization admins write evaluations)'],
  company_key: ['같은 서식 칸을 쓰는 항목이 이미 있다 — 그 항목을 고쳐라', 'another item already fills that document field — update it instead'],
  company_input: ['입력이 올바르지 않다', 'invalid input'], perf_input: ['입력이 올바르지 않다(점수 0~100 정수, 제목 1~200자)', 'invalid input (scores are integers 0-100, title 1-200 chars)'],
  perf_period: ['기간 모양이 틀렸다(주 = 월~일, 월 = 1일~말일, 연 = 1/1~12/31)', 'wrong period shape (week = Mon-Sun, month = 1st-last, year = Jan 1-Dec 31)'],
  perf_conflict: ['이미 새 판이 있는 레포트다', 'that report already has a newer version'], company_limit: ['조직당 상한에 걸렸다', 'organization limit reached'], perf_limit: ['올해 평가 상한에 걸렸다', 'yearly evaluation limit reached'],
};
function rpcError(e, lang) {
  const msg = String(e?.message ?? e ?? '');
  const code = Object.keys(ERRORS).find((c) => msg.includes(c));
  if (code) return pick(`오피스 서버 거절: ${ERRORS[code][0]}.`, `Office server refused: ${ERRORS[code][1]}.`, lang);
  return pick(`오피스 서버 호출 실패: ${msg.slice(0, 200) || '알 수 없는 오류'}. 사장에게 그대로 알려라.`, `Office call failed: ${msg.slice(0, 200) || 'unknown error'}. Tell the owner as is.`, lang);
}

const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
/** 범위·기준 날짜 → 서버가 받는 기간(주 = 월~일, 월 = 1일~말일, 연) */
export function periodOf(scope, day) {
  const [y, m] = day.split('-').map(Number);
  if (scope === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (scope === 'month') return { from: `${day.slice(0, 7)}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const from = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 6);
  return { from, to: d.toISOString().slice(0, 10) };
}

export async function companyTool(args, { ctx = null, crew, lang = 'ko', ownerId = null } = {}) {
  const a = args ?? {};
  if (ctx?.kind === 'msgr-rules') return pick('메신저 위임 턴에서는 회사 도구를 쓰지 않는다 — 요청한 동료에게 돌려줘라.', 'The office tool is not available in a delegated messenger turn — hand it back.', lang);
  if (ctx?.kind !== 'msgr' || !ctx.orgId) return pick('회사 정보·직원·평가는 메신저 조직 채널 대화에서만 다룬다(그 조직의 것). 지금 대화에서는 쓸 수 없다고 알려라.', 'Company info, people and evaluations are only available in a messenger org channel (that org). Say it is unavailable here.', lang);
  let c;
  try { c = await companyDeps.session(); } catch (e) { return pick(`메신저 세션을 불러오지 못했다: ${String(e?.message ?? e).slice(0, 160)}.`, `Could not load the messenger session: ${String(e?.message ?? e).slice(0, 160)}.`, lang); }
  if (!c?.client || !c.uid) return pick('메신저에 로그인돼 있지 않아 오피스를 다룰 수 없다 — 사장에게 Argo 설정에서 메신저(오피스) 계정에 로그인해 달라고 알려라.', 'Not signed in to the messenger, so Office is unavailable — ask the owner to sign in in Argo settings.', lang);
  if (!ownerId || ownerId !== c.uid || ctx.uid !== c.uid) return pick('이 기기의 메신저 로그인 계정이 이 크루 주인의 계정이 아니라 오피스를 다루지 않는다 — 사장에게 알려라.', 'The messenger account on this device is not this crew\'s owner, so Office is not used — tell the owner.', lang);
  const org = ctx.orgId;
  try {
    if (a.action === 'company') {
      const d = unwrap(await c.client.rpc('office_company_read', { p_org: org }));
      const items = d?.items ?? [];
      if (!items.length) return pick('회사 정보가 비어 있다.', 'Company info is empty.', lang);
      return [pick(`회사 정보 ${items.length}개(분류 · 항목 = 값 · 서식 칸 · id):`, `Company info, ${items.length} items (category · item = value · document field · id):`, lang),
        ...items.slice(0, LIST_CAP).map((x) => `- ${CAT_NAME[x.category]?.[lang === 'en' ? 1 : 0] ?? x.category} · ${x.label} = ${['seal', 'logo'].includes(x.key) ? pick('(그림)', '(image)', lang) : x.value || '—'}${x.key ? ` · key=${x.key}` : ''}${x.notes ? ` · ${pick('메모', 'note', lang)} ${x.notes}` : ''} · id=${x.id}`),
        pick('같은 항목은 새로 만들지 말고 company_set에 id를 줘서 고쳐라.', 'Do not add duplicates — pass the id to company_set to update.', lang)].join('\n');
    }
    if (a.action === 'company_set') {
      const label = String(a.label ?? '').trim();
      let cur = null;
      if (a.id || !label) {
        const d = unwrap(await c.client.rpc('office_company_read', { p_org: org }));
        cur = (d?.items ?? []).find((x) => x.id === a.id) ?? null;
        if (a.id && !cur) return pick(`id=${a.id} 항목이 없다 — company로 다시 확인하라.`, `No item id=${a.id} — check with company.`, lang);
      }
      if (!cur && !label) return pick('company_set에는 label(새 항목) 또는 id(고칠 항목)가 필요하다.', 'company_set needs label (new) or id (update).', lang);
      if (a.category && !CATS.includes(a.category)) return pick(`category는 ${CATS.join('|')} 중 하나.`, `category must be one of ${CATS.join('|')}.`, lang);
      if (a.key && !KEYS.includes(a.key)) return pick(`key는 ${KEYS.join('|')} 중 하나(없으면 비워라).`, `key must be one of ${KEYS.join('|')} (or omit).`, lang);
      const data = { id: cur?.id ?? companyDeps.newId(), label: label || cur.label, value: a.value ?? cur?.value ?? '', notes: a.notes ?? cur?.notes ?? '',
        category: a.category ?? cur?.category ?? 'other', key: a.key ?? cur?.key ?? null, ...(cur ? { position: cur.position, redacted: cur.redacted } : {}) };
      const r = unwrap(await c.client.rpc('office_company_write', { p_org: org, p_action: 'item.save', p_data: data }));
      return pick(`회사 정보를 ${cur ? '고쳤다' : '추가했다'}: ${r?.item?.label ?? data.label} = ${r?.item?.value ?? data.value} (id=${data.id})`, `${cur ? 'Updated' : 'Added'} company info: ${r?.item?.label ?? data.label} = ${r?.item?.value ?? data.value} (id=${data.id})`, lang);
    }
    if (a.action === 'people') {
      const d = unwrap(await c.client.rpc('office_people_read', { p_org: org }));
      const list = (d?.people ?? []).filter((p) => a.status === 'all' || p.status === (a.status ?? 'active'));
      if (!list.length) return pick('명부에 사람이 없다.', 'The directory is empty.', lang);
      return [pick(`직원 ${list.length}명(이름 · 직무 · 부서 · 에이전트 · 상태):`, `${list.length} people (name · role · team · agent · status):`, lang),
        ...list.slice(0, LIST_CAP).map((p) => `- ${p.name} · ${p.title || '—'} · ${p.department || '—'} · ${p.agent || '—'} · ${p.status}${p.account_role ? ` · ${pick('계정', 'account', lang)} ${p.account_role}` : ''}${p.user_id ? ` · user=${p.user_id}` : ''}`)].join('\n'); // 메모는 싣지 않는다
    }
    if (a.action === 'evals') {
      const d = unwrap(await c.client.rpc('office_perf_eval_list', { p_org: org }));
      const list = (d?.evals ?? []).filter((e) => !e.replaced_by && (!a.scope || e.scope === a.scope) && (!a.subject || e.subject_name === a.subject));
      if (!list.length) return pick('조건에 맞는 평가 레포트가 없다.', 'No evaluation reports match.', lang);
      return [pick(`평가 레포트 ${list.length}건(지금 판만):`, `${list.length} evaluation reports (current versions):`, lang),
        ...list.slice(0, 30).map((e) => `- [${e.scope}] ${e.subject_name}(${e.subject_type}) ${e.period_from}~${e.period_to} · ${e.title} · ${pick('종합', 'total', lang)} ${e.total ?? '—'} (${SCORES.map((k) => e[k] ?? '—').join('/')}) · ${pick('작성', 'by', lang)} ${e.author_name} · id=${e.id}${e.review ? `\n  ${pick('총평', 'review', lang)}: ${String(e.review).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)].join('\n');
    }
    if (a.action === 'eval_add') {
      const scope = a.scope;
      if (!['week', 'month', 'year'].includes(scope)) return pick('eval_add에는 scope(week|month|year)가 필요하다.', 'eval_add needs scope (week|month|year).', lang);
      const day = a.period_day || kstDay(companyDeps.now());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return pick('period_day는 YYYY-MM-DD(그 기간 안의 아무 날).', 'period_day must be YYYY-MM-DD (any day in the period).', lang);
      const kind = a.subject_kind === 'crew' ? 'crew' : 'person';
      if (kind === 'person' && !a.subject_user) return pick('사람 평가에는 subject_user(people이 보여 준 user=…)가 필요하다. 계정 없는 사람은 평가할 수 없다.', 'A person evaluation needs subject_user (the user=… shown by people).', lang);
      if (kind === 'crew' && !String(a.subject_name ?? '').trim()) return pick('크루 평가에는 subject_name(크루 이름)이 필요하다.', 'A crew evaluation needs subject_name.', lang);
      const p = periodOf(scope, day);
      const data = { id: companyDeps.newId(), subject_kind: kind, subject_user: kind === 'person' ? a.subject_user : null, subject_name: a.subject_name ?? null, subject_type: a.subject_type === 'ceo' ? 'ceo' : 'staff',
        scope, from: p.from, to: p.to, title: String(a.title ?? '').trim(), ...Object.fromEntries(SCORES.map((k) => [k, a[k] ?? null])), total: a.total ?? null,
        review: a.review ?? '', work: a.work ?? '', achievements: a.achievements ?? '', crew: crew ?? null };
      const r = unwrap(await c.client.rpc('office_perf_eval_write', { p_org: org, p_action: 'eval.add', p_data: data }));
      return pick(`평가 레포트를 남겼다(고칠 수 없고, 바꾸려면 관리자가 새 판을 쓴다): ${r?.eval?.title ?? data.title} · ${p.from}~${p.to} · 종합 ${r?.eval?.total ?? '—'} (id=${r?.eval?.id ?? data.id})`,
        `Saved the evaluation (final — an admin writes a new version to change it): ${r?.eval?.title ?? data.title} · ${p.from}~${p.to} · total ${r?.eval?.total ?? '—'} (id=${r?.eval?.id ?? data.id})`, lang);
    }
    return pick('action은 company·company_set·people·evals·eval_add 중 하나다.', 'action must be company, company_set, people, evals or eval_add.', lang);
  } catch (e) {
    return rpcError(e, lang);
  }
}

export function companyDescription(lang = 'ko') {
  return lang === 'en'
    ? 'Argo Office company records for the org of this messenger channel. action=company lists company info (business, bank, contact, tax items with id); company_set adds an item (label, value, category basic|bank|contact|tax|other, optional key for document fields) or updates one by id — do not add duplicates. action=people lists the directory (name, role, team, agent, status, user id). action=evals lists evaluation reports (filter scope week|month|year, subject name); eval_add writes one: scope, period_day (any day in the period), subject_kind person (subject_user from people) or crew (subject_name), title, scores performance/quality/productivity/expertise/collaboration (integers 0-100, base them on real records — never invent), optional total (blank = average), review (Markdown), work, achievements. Evaluations are final; only admins can write them. Writes need the owner to be an org admin.'
    : '이 메신저 채널 조직의 아르고 오피스 회사 기록. action=company는 회사 정보(사업자·계좌·연락처·세무 항목, id 포함), company_set은 항목 추가(label·value·category basic|bank|contact|tax|other, 서식 칸이면 key) 또는 id로 고치기 — 같은 항목을 새로 만들지 마라. action=people은 직원 명부(이름·직무·부서·에이전트·상태·계정 id). action=evals는 평가 레포트 목록(scope week|month|year·subject 이름으로 거르기), eval_add는 평가 쓰기: scope, period_day(그 기간 안의 아무 날), subject_kind person(people의 user id를 subject_user로) 또는 crew(subject_name), title, 점수 performance·quality·productivity·expertise·collaboration(0~100 정수 — 실제 기록에 근거해 매기고 지어내지 마라), total(비우면 평균), review(마크다운), work, achievements. 평가는 저장하면 고칠 수 없고 관리자만 쓴다. 쓰기는 주인이 조직 관리자일 때만 된다.';
}
