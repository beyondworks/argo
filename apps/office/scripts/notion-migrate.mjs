// Notion → 오피스 일회 이관 실행기(트랙 C, 유건 10/2). 기본은 시험 실행 — 아무것도 쓰지 않고 계획과 건수만 보여 준다.
// Notion은 읽기만 한다(data source 조회·블록 목록 읽기 — 페이지를 고치거나 보관하지 않는다). 쓰기는 오피스 함수로만(앱과 같은 검사).
// id는 (조직·종류·Notion id)로 고정이라 다시 돌려도 두 번 들어가지 않고(--resume), 끝나면 계획한 id가 오피스에 실제로 있는지 대조한다.
//
//   node scripts/notion-migrate.mjs --fixture                    예시 원본(scripts/fixtures/notion-sample.mjs)으로 시험 실행 — 네트워크 없음
//   node scripts/notion-migrate.mjs                              실제 Notion을 읽어 시험 실행(쓰기 없음) — NOTION_TOKEN 필요
//   node scripts/notion-migrate.mjs --apply --org <조직 id>        이관 실행 + 대조(유건 승인 뒤에만)
//   옵션: --only events,tasks,pages,company,evals,people · --people <이름→계정 id JSON 파일> · --resume · --json(계획 전체 출력 — 계좌·사업자번호는 가린다)
// 환경 변수(값은 출력하지 않는다): NOTION_TOKEN(읽기 전용 내부 통합 토큰), OFFICE_MIGRATE_URL, OFFICE_MIGRATE_ANON_KEY, OFFICE_MIGRATE_EMAIL, OFFICE_MIGRATE_PASSWORD,
//   OFFICE_MIGRATE_SERVICE_KEY(평가 레포트를 옮길 때만 — 원본 작성자·작성 시각은 이관 전용 함수 office_perf_eval_import(service_role)만 받는다. 실행자 = 로그인한 관리자),
//   INTRANET_DB(직원 표, 기본 ~/lean-projects/AI-Native/data/board.db — 없으면 직원은 건너뜀),
//   NOTION_CALENDAR_DS · NOTION_PARENT_DS · NOTION_COMPANY_DS · NOTION_REPORTS_DS · NOTION_WORKBOARD_ROOT(기본 = 인트라넷 lib/integrations/notion.ts의 값)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planAll, maskForPrint } from './notion-plan.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = flag('--apply');
const ONLY = new Set((opt('--only') ?? 'events,tasks,pages,company,evals,people').split(','));
const ORG = opt('--org') ?? null;
const log = (...a) => console.log(...a);

// 인트라넷이 읽던 Notion 위치(비밀 값 아님 — 워크스페이스 안 DB·페이지 id)
const DS = {
  calendar: process.env.NOTION_CALENDAR_DS || '242003c7-f7be-81c7-bc4e-000b42296aa4',
  parents: process.env.NOTION_PARENT_DS || '242003c7-f7be-810c-be5e-000b8a4550d6',
  company: process.env.NOTION_COMPANY_DS || 'd1c3a96c-ff61-4c1d-aea8-63494569024d',
  reports: process.env.NOTION_REPORTS_DS || '352e9f6e-cea1-40b9-9f57-20ff829416e8',
  workboard: process.env.NOTION_WORKBOARD_ROOT || '381003c7-f7be-81ef-8809-e6c9f41a6a4d',
};

/* ── Notion 읽기(읽기 전용 호출만, 초당 3회 아래로, 429는 기다렸다 다시) ── */
async function notion(path, body) {
  const token = process.env.NOTION_TOKEN;
  if (!token) { console.error('NOTION_TOKEN 이 없습니다(값은 출력하지 않음). --fixture 로 예시 시험은 할 수 있습니다.'); process.exit(2); }
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 340));
    const res = await fetch(`https://api.notion.com/v1/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000)); continue; }
    if (!res.ok) throw new Error(`Notion ${res.status} ${path.split('?')[0]}`);
    return res.json();
  }
  throw new Error(`Notion 재시도 초과 ${path.split('?')[0]}`);
}
async function queryAll(ds) {
  const out = []; let cursor;
  do { const r = await notion(`data_sources/${ds}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }); out.push(...r.results); cursor = r.has_more ? r.next_cursor : null; } while (cursor);
  return out;
}
async function children(id, depth = 0) {
  const out = []; let cursor;
  do {
    const r = await notion(`blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    for (const b of r.results) { if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database' && depth < 6) b.children = await children(b.id, depth + 1); out.push(b); }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}
async function tree(id, title) {
  const blocks = await children(id);
  const kids = [];
  for (const b of blocks.filter((x) => x.type === 'child_page')) kids.push(await tree(b.id, b.child_page?.title));
  return { id, title, blocks: blocks.filter((x) => x.type !== 'child_page'), children: kids };
}

async function loadSource() {
  if (flag('--fixture')) {
    const f = await import('./fixtures/notion-sample.mjs');
    return { calendar: f.calendar, parents: f.parents, workboard: f.workboard, company: f.company, reports: f.reports, employees: f.employees, from: 'fixture' };
  }
  const src = { from: 'notion' };
  if (ONLY.has('events') || ONLY.has('tasks')) { src.calendar = await queryAll(DS.calendar); src.parents = await queryAll(DS.parents); }
  if (ONLY.has('pages')) { const root = await notion(`pages/${DS.workboard}`); const t = Object.values(root.properties ?? {}).find((p) => p.type === 'title'); src.workboard = await tree(DS.workboard, (t?.title ?? []).map((x) => x.plain_text).join('') || '워크보드'); }
  if (ONLY.has('company')) src.company = await queryAll(DS.company);
  if (ONLY.has('evals')) src.reports = await queryAll(DS.reports);
  const db = process.env.INTRANET_DB || join(homedir(), 'lean-projects/AI-Native/data/board.db');
  if (ONLY.has('people') && existsSync(db)) src.employees = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, 'select id, name, role, agent from employees order by id'], { encoding: 'utf8' }) || '[]'); // cli_token은 읽지 않는다
  return src;
}

const source = await loadSource();
const people = opt('--people') ? JSON.parse(readFileSync(opt('--people'), 'utf8')) : {};
const { plan, summary } = planAll(source, { org: ORG, people });
for (const k of Object.keys(plan)) if (!ONLY.has(k)) plan[k] = [];
log(`원본(${source.from}): Beyond_Tasks ${summary.source.calendar}줄(날짜 없음 ${summary.source.undated}) · 워크보드 ${summary.source.workboardPages}쪽 · 회사정보 ${summary.source.company} · 레포트 ${summary.source.reports} · 직원 ${summary.source.employees}`);
log(`계획: 일정 ${plan.events.length} · 할 일 ${plan.tasks.length}(끝낸 일 ${plan.tasks.filter((t) => t.done_at).length}) · 위키 페이지 ${plan.pages.length} · 회사 정보 ${plan.company.length}(서식 칸 ${plan.company.filter((c) => c.key).length}) · 평가 ${plan.evals.length}(계정 못 찾은 사람 ${plan.evals.filter((e) => e.subject_kind === 'person' && !e.subject_user).length}) · 직원 ${plan.people.length}`);
log(`기간 ${summary.range ? summary.range.join(' ~ ') : '—'} · 본문 블록 ${summary.blocks}개 · 글자로만 옮긴 블록 ${JSON.stringify(summary.textOnlyBlocks)}`);
if (flag('--json')) log(JSON.stringify(maskForPrint(plan), null, 2)); // 계좌·사업자번호는 가린다(터미널·로그에 남지 않게)
if (!APPLY) { log('시험 실행 — 쓰기 없음. 실제 이관은 --apply --org <조직 id>(유건 승인 뒤)'); process.exit(0); }

/* ── 이관 실행(--apply) ── */
if (!ORG) { console.error('--apply 에는 --org <조직 id>가 필요합니다'); process.exit(2); }
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} 가 없습니다`); process.exit(2); } return v; };
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(need('OFFICE_MIGRATE_URL'), need('OFFICE_MIGRATE_ANON_KEY'), { auth: { persistSession: false } });
const { error: signInError } = await sb.auth.signInWithPassword({ email: need('OFFICE_MIGRATE_EMAIL'), password: need('OFFICE_MIGRATE_PASSWORD') });
if (signInError) { console.error('로그인 실패:', signInError.message); process.exit(1); }
const rpc = async (fn, a) => { const { data, error } = await sb.rpc(fn, a); if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code }); return data; };

const before = await rpc('office_company_read', { p_org: ORG });
if (before.role !== 'manager') { console.error('이 조직의 관리자 계정으로 실행해야 합니다'); process.exit(1); }
if (before.items.some((x) => x.source === 'notion') && !flag('--resume')) { console.error('이미 Notion에서 옮긴 회사 정보가 있습니다. 같은 이관을 이어서 하려면 --resume'); process.exit(1); }

const done = { events: 0, tasks: 0, pages: 0, company: 0, evals: 0, people: 0 };
for (const c of plan.company) { await rpc('office_company_write', { p_org: ORG, p_action: 'item.save', p_data: c }); done.company++; }
for (const p of plan.people) { await rpc('office_people_write', { p_org: ORG, p_action: 'person.save', p_data: p }); done.people++; }
for (const e of plan.events) { await rpc('office_event_write', { p_action: 'save', p_data: e }); done.events++; }
for (const t of plan.tasks) { await rpc('office_task_import', { p_org: ORG, p_data: t }); done.tasks++; }
for (const p of plan.pages) { await rpc('office_page_create', { p_id: p.id, p_org: ORG, p_parent: p.parent, p_position: p.position, p_title: p.title, p_content: p.content, p_template: false }); done.pages++; }
if (plan.evals.length) { // 평가: 이관 전용 함수(service_role) — 보통 쓰기는 출처·원본 작성 시각을 받지 않는다(분리 검수 LOW 3)
  const svc = createClient(need('OFFICE_MIGRATE_URL'), need('OFFICE_MIGRATE_SERVICE_KEY'), { auth: { persistSession: false } });
  const actor = (await sb.auth.getUser()).data?.user?.id;
  for (const e of plan.evals) { const { error } = await svc.rpc('office_perf_eval_import', { p_org: ORG, p_actor: actor, p_data: e }); if (error) throw new Error(`office_perf_eval_import: ${error.message}`); done.evals++; }
}

// 대조: 계획한 id가 오피스에 실제로 있는가(같은 조직, 다시 읽기)
const ids = (list) => new Set(list.map((x) => x.id));
const have = {
  company: (await rpc('office_company_read', { p_org: ORG })).items,
  people: (await rpc('office_people_read', { p_org: ORG })).people,
  tasks: await rpc('office_task_list', { p_org: ORG }),
  evals: (await rpc('office_perf_eval_list', { p_org: ORG })).evals,
  pages: (await sb.from('office_pages').select('id').eq('org_id', ORG)).data ?? [],
  events: summary.range ? (await rpc('office_event_list', { p_from: `${summary.range[0]}T00:00:00+09:00`, p_to: `${summary.range[1]}T23:59:59+09:00` })).events : [],
};
const rows = Object.keys(done).map((k) => { const want = ids(plan[k]); const got = have[k].filter((x) => want.has(x.id)).length; return { 항목: k, 계획: want.size, 처리: done[k], 오피스: got, 결과: got === want.size ? '같음' : '다름' }; });
console.table(rows);
process.exit(rows.every((r) => r.결과 === '같음') ? 0 : 3);
