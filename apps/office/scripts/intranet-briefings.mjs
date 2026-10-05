// 인트라넷 브리핑 → 오피스 브리핑 이관(유건 10/5 "브리핑은 필요해", 받는 사람의 내 공간에). 인트라넷 board.db는 읽기만 한다.
// 기본은 시험 실행 — 계획과 건수만. --sql <파일>을 주면 적용할 SQL을 쓴다(값을 화면에 내지 않는다).
// SQL은 실행 계정(--actor, 그 조직 관리자)의 권한으로 이관 전용 함수 office_briefing_import만 부른다 — 앱과 같은 검사(관리자·받는 사람이 구성원)를 거치고,
// 같은 원본은 조직마다 한 번만 들어가 다시 돌려도 두 번 들어가지 않는다. 한 트랜잭션이라 하나라도 거절되면 아무것도 들어가지 않는다.
//   node scripts/intranet-briefings.mjs --org <조직 id> --to <받는 사람 id> [--actor <실행 계정 id, 기본 = 받는 사람>] [--sql <파일>]
// 적용(유건 승인 뒤): psql -v ON_ERROR_STOP=1 -f <파일>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DB = process.env.INTRANET_DB || join(homedir(), 'lean-projects/AI-Native/data/board.db');

/** 원본 한 줄 → 이관 자료. 샘플 글(system:sample)은 뺀다. 시각은 board.db의 UTC 글자('YYYY-MM-DD HH:MM:SS') */
export function planBriefings(rows, org) {
  const skipped = [], items = [];
  for (const r of rows) {
    if (String(r.author_agent ?? '').startsWith('system:')) { skipped.push({ id: r.id, why: 'sample' }); continue; }
    const hex = createHash('sha256').update(`${org}:briefing:${r.id}`).digest('hex');
    items.push({
      id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`, // 조직·원본으로 고정(다시 돌려도 같은 id)
      title: String(r.title ?? '').trim(), body: String(r.content_md ?? ''),
      kind: ['daily', 'weekly'].includes(r.scope) ? r.scope : 'custom', period: String(r.period ?? '').slice(0, 100),
      author_name: r.author_agent === 'pepper' ? '페퍼' : String(r.author_agent ?? '').slice(0, 100),
      created_at: `${String(r.created_at).replace(' ', 'T')}Z`, source: { kind: 'intranet', id: String(r.id) },
    });
  }
  return { items, skipped };
}

const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
/** 실행 계정의 JWT 문맥(auth.uid())으로 이관 함수만 부르는 한 트랜잭션 */
export function toSql({ items }, { org, to, actor }) {
  return ['\\set ON_ERROR_STOP on', 'begin;', 'set local role authenticated;',
    `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: actor, role: 'authenticated' }))}, true);`,
    ...items.map((b) => `select (public.office_briefing_import(${lit(org)}::uuid, ${lit(JSON.stringify({ ...b, recipient: to }))}::jsonb))->>'id';`),
    'reset role;', // 건수 확인은 표를 직접 읽는다(일반 계정은 표를 못 읽는다)
    `select count(*) as briefings from public.office_briefings where org_id = ${lit(org)}::uuid and source->>'kind' = 'intranet';`,
    'commit;', ''].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const org = opt('--org'), to = opt('--to'), actor = opt('--actor') ?? to, out = opt('--sql');
  if (![org, to, actor].every((x) => UUID.test(x ?? ''))) { console.error('--org·--to(·--actor)에 uuid가 필요합니다'); process.exit(2); }
  const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', DB, 'select id, scope, period, author_agent, title, content_md, created_at from briefings order by created_at, id'], { encoding: 'utf8' }) || '[]');
  const plan = planBriefings(rows, org);
  const by = (k) => Object.entries(plan.items.reduce((m, b) => ({ ...m, [b[k]]: (m[b[k]] ?? 0) + 1 }), {})).map(([v, n]) => `${v} ${n}`).join(', ');
  console.log(`원본 ${rows.length}건 → 옮길 것 ${plan.items.length}건(뺀 것 ${plan.skipped.length}: ${plan.skipped.map((s) => `#${s.id} ${s.why}`).join(', ') || '없음'})`);
  console.log(`종류: ${by('kind')} · 작성자: ${by('author_name')} · 기간 ${plan.items[0]?.created_at ?? '—'} ~ ${plan.items.at(-1)?.created_at ?? '—'}`);
  console.log(`가장 긴 제목 ${Math.max(0, ...plan.items.map((b) => b.title.length))}자 · 가장 긴 본문 ${Math.max(0, ...plan.items.map((b) => b.body.length))}자`);
  if (out) { writeFileSync(out, toSql(plan, { org, to, actor }), { mode: 0o600 }); console.log(`SQL을 썼습니다: ${out} (적용은 승인 뒤 psql -f)`); }
  else console.log('시험 실행 — 쓰기 없음. SQL을 만들려면 --sql <파일>');
}
