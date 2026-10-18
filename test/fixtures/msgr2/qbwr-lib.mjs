// qbwr 실전 시험 실행기 공용 — 검문한 접속(C)·qbwr anon 키만 받고, 합성 계정 로그인·기기 등록·psql을 한 곳에 둔다(qbwr-q.mjs·qbwr-files.mjs).
// 접속·키는 scripts/qbwr-env.sh가 검사해 환경 변수로 넘긴다. 여기서도 같은 모양을 다시 본다(직접 실행해도 운영에 닿지 않게, #1093 검수).
import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

export const REF = 'qbwrlynzvjmphwuqglsx';
export const ORIGIN = `https://${REF}.supabase.co`; // 주소는 상수 — 받은 값은 비교만 한다
const C_RE = /^host=(aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com|db\.qbwrlynzvjmphwuqglsx\.supabase\.co) port=(5432|6543) user=postgres(\.qbwrlynzvjmphwuqglsx)? dbname=postgres sslmode=require$/;
export const jwtOk = (key, role) => { try { const p = JSON.parse(Buffer.from(String(key).split('.')[1], 'base64url')); return p.ref === REF && p.role === role; } catch { return false; } };
export const originOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.host === `${REF}.supabase.co` && (x.pathname === '/' || x.pathname === '') && !x.search; } catch { return false; } };

/** 사용자 권한 실행에 필요한 것(검문한 C·qbwr anon 키·합성 비밀번호)을 확인한다. 아니면 exit 5 */
export function userEnv(env = process.env) {
  const { C, QBWR_ANON_KEY: anon, QBWR_SEED_PASSWORD: pw } = env;
  if ((env.QBWR_URL && !originOk(env.QBWR_URL)) || !C_RE.test(C ?? '') || !jwtOk(anon, 'anon') || !pw) {
    console.error(`거부  qbwr 주소·검문한 접속·qbwr anon 키·합성 비밀번호가 필요합니다(scripts/qbwr-*.sh로 실행)`);
    process.exit(5);
  }
  // psql에는 PG* 중 비밀번호·서비스 파일 막기만 넘긴다(셸의 PGHOST·PGSERVICE 등이 C를 덮지 않게)
  const psqlEnv = { PATH: env.PATH, PGPASSWORD: env.PGPASSWORD ?? '', PGSERVICEFILE: '/dev/null', PGPASSFILE: '/dev/null', PGSYSCONFDIR: '/dev/null' };
  const sql = (q) => { const r = spawnSync('psql', [C, '-X', '-A', '-t', '-q', '-c', q], { encoding: 'utf8', env: psqlEnv }); if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').pop()); return r.stdout.trim(); };
  const client = () => createClient(ORIGIN, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = (n) => `p${String(n).padStart(3, '0')}@example.test`;
  async function login(n) {
    const c = client();
    const { data, error } = await c.auth.signInWithPassword({ email: email(n), password: pw });
    if (error) throw new Error(`로그인 실패 ${email(n)}: ${error.message}`);
    const token = data.session.access_token;
    c.realtime.setAuth(token);
    return { c, uid: data.user.id, sid: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).session_id ?? null, token };
  }
  /** 합성 계정 uid → 로그인(일련번호는 이메일 p001에서) */
  const loginUid = async (uid) => login(Number(sql(`select substring(email from 2 for 3) from auth.users where id = '${uid}' and email like '%@example.test'`)));
  const APP = { p_kind: 'app', p_app: 'messenger', p_app_version: '0.2.0' };
  const reg = async (s, args = APP) => { const { data, error } = await s.c.rpc('msgr2_device_register', args); return { id: data?.device_id ?? null, err: error?.message ?? null }; };
  return { sql, client, email, login, loginUid, reg, APP };
}
