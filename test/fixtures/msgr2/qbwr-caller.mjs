// qbwr Q6~Q11 실행기의 호출 층 — 같은 시험 코드를 두 곳에서 돌린다.
//   qbwr:  scripts/qbwr-q6.sh가 부른다. 사람 요청 = 실 GoTrue 로그인(anon 키) + PostgREST(supabase-js), 관리 질의 = 검문한 psql(qbwr-lib userEnv).
//   local: --local postgresql://…@127.0.0.1|localhost/… (로컬 연습 DB만). 사람 요청 = psql에서 authenticated 역할 + JWT 클레임 대역(auth.uid는 argo.uid).
// 사람 세션: { uid, sid, rpc(fn, args) → { data, error, ms }, insert(table, row) → { data, error, ms } }. 관리 질의: admin(sql) → 마지막 출력.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// 로컬 연습 DB만: 사용자 칸은 점 없는 이름(postgres.<ref> 같은 Supabase 풀러 사용자 거부), 호스트는 127.0.0.1·localhost, 쿼리 없음. 운영 ref는 어디에도 없어야 한다
const LOCAL_RE = /^postgres(ql)?:\/\/[a-z0-9_]+(:[^@/?#]*)?@(127\.0\.0\.1|localhost)(:\d+)?\/[a-z0-9_]+$/;
const PROD_REF = 'nvqorpdorlbkhpcvwoty';
const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : Array.isArray(v) ? `'{${v.map((x) => String(x).replace(/[",\\{}]/g, '')).join(',')}}'` : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb` : `'${String(v).replace(/'/g, "''")}'`);
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

export async function makeCaller(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--local');
  if (i >= 0) {
    const url = argv[i + 1];
    if (!LOCAL_RE.test(url ?? '') || String(url).toLowerCase().includes(PROD_REF)) { console.error('거부  --local은 127.0.0.1·localhost의 연습 DB만 받습니다'); process.exit(5); }
    argv.splice(i, 2);
    // 셸의 PG*(PGHOSTADDR·PGSERVICE·PGUSER…)가 접속 주소를 바꾸지 못하게 psql에는 PATH와 서비스·비밀번호 파일 막기만 넘긴다(#1093 검문과 같은 이유, #1100 검수)
    const LOCAL_PSQL_ENV = { PATH: process.env.PATH, PGSERVICEFILE: '/dev/null', PGPASSFILE: '/dev/null', PGSYSCONFDIR: '/dev/null' };
    // 여러 문장 중 마지막 결과만 읽는다(psql 15+는 SHOW_ALL_RESULTS=off, 14는 원래 마지막만)
    const run = (q) => { const r = spawnSync('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'SHOW_ALL_RESULTS=off', '-c', q], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: LOCAL_PSQL_ENV }); return r.status === 0 ? { out: r.stdout.trim() } : { err: r.stderr.trim().split('\n').find((l) => /ERROR/.test(l))?.replace(/^.*ERROR:\s*/, '') || r.stderr.trim() || String(r.error?.message ?? `psql 종료 ${r.status}`) }; };
    const admin = (q) => { const r = run(q); if (r.err) throw new Error(r.err); return r.out.split('\n').pop() ?? ''; };
    // 주소가 localhost여도 실제 연결 상대가 루프백인지 서버에게 묻는다(localhost로 열어 둔 운영 터널을 막는다, #1100 검수)
    const peer = run("select coalesce(host(inet_server_addr()), '')");
    if (peer.err || !['127.0.0.1', '::1'].includes(peer.out)) { console.error(`거부  --local 연결 상대가 루프백이 아닙니다(${peer.err ? '접속 실패' : peer.out || '알 수 없음'})`); process.exit(5); }
    const ctx = (uid, sid) => `set role authenticated; select set_config('argo.uid', '${uid}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, session_id: sid, role: 'authenticated' })}', false); `;
    const sets = new Map();
    const retset = (fn) => { if (!sets.has(fn)) sets.set(fn, admin(`select bool_or(proretset) from pg_proc where proname = '${fn.replace(/[^a-z0-9_]/g, '')}' and pronamespace = 'public'::regnamespace`) === 't'); return sets.get(fn); };
    const as = (uid, sid, q) => { const t0 = now(); const r = run(ctx(uid, sid) + q); return { ...r, ms: now() - t0 }; };
    async function login(n) {
      const uid = admin(`select id from auth.users where email = 'p${String(n).padStart(3, '0')}@example.test'`);
      const sid = randomUUID();
      admin(`insert into auth.sessions (id, user_id) values ('${sid}', '${uid}')`);
      return {
        uid, sid,
        async rpc(fn, args = {}) {
          const a = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
          const r = as(uid, sid, `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.${fn}(${a}) t`);
          if (r.err) return { data: null, error: { message: r.err }, ms: r.ms };
          let d = JSON.parse(r.out.split('\n').pop());
          // PostgREST처럼: 한 값을 돌려주는 함수는 그 값, 여러 행(setof·table)을 돌려주는 함수는 행 배열
          if (!retset(fn)) d = d.length ? d[0] : null;
          return { data: d, error: null, ms: r.ms };
        },
        async insert(table, row) {
          const cols = Object.keys(row), vals = cols.map((k) => lit(row[k]));
          const r = as(uid, sid, `insert into public.${table} (${cols.join(', ')}) values (${vals.join(', ')}) returning to_jsonb(${table}.*)`);
          return r.err ? { data: null, error: { message: r.err }, ms: r.ms } : { data: JSON.parse(r.out.split('\n').pop()), error: null, ms: r.ms };
        },
      };
    }
    return { mode: 'local', argv, admin, login };
  }
  const { userEnv } = await import('./qbwr-lib.mjs');
  const U = userEnv(env); // 검문한 접속·qbwr anon 키가 아니면 exit 5
  async function login(n) {
    const s = await U.login(n);
    const wrap = async (p) => { const t0 = now(); const { data, error } = await p; return { data, error: error ? { message: error.message } : null, ms: now() - t0 }; };
    return { uid: s.uid, sid: s.sid, c: s.c, rpc: (fn, args = {}) => wrap(s.c.rpc(fn, args)), insert: (table, row) => wrap(s.c.from(table).insert(row).select().single()) };
  }
  return { mode: 'qbwr', argv, admin: (q) => U.sql(q).split('\n').pop() ?? '', login };
}

export const APP = { p_kind: 'app', p_app: 'messenger', p_app_version: '0.2.0' };
export const RUNNER = { p_kind: 'runner', p_app: 'desktop', p_app_version: '0.1.113', p_link_min: 1, p_link_max: 1, p_runners: ['claude'] };
