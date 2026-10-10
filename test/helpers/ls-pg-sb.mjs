// 결제 pg 드릴 공용 — billing-pg-integration.test.mjs와 billing-late-signup-pg.test.mjs가 같이 쓴다.
// ① prepareBillingSchema: 실 Supabase에만 있는 전제(역할·auth 스키마·msgr 3표)를 스텁으로 만들고, 결제 마이그레이션 파일을
//    그대로 적용한다(테스트용 사본 SQL이 아니라 배포될 그 파일).
// ② pgSb: 엣지 수신자(supabase/functions/ls-webhook)가 쓰는 supabase-js 호출(rpc·select().eq().neq().limit()·upsert)을
//    Postgres 문장으로 바꿔 끼운 가짜(PostgREST 대신). RPC는 service_role로 실행해 실행 권한·인자 이름까지 운영과 같은 조건으로
//    본다. 없는 함수는 PostgREST처럼 code PGRST202로 돌려준다. 표 조회·기록은 슈퍼유저로(운영의 서비스 롤처럼 RLS를 거치지 않는다).
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './pg.mjs';

export const BILLING_MIGRATIONS = [
  '20260714150000_entitlements.sql',
  '20260724000100_trial_14d.sql',
  '20260728100000_entitlements_ls.sql',
  '20260728113000_billing_hardening.sql',
  '20260728150000_ls_reconcile_cooldown.sql',
  '20260730050000_is_pro_ends_at.sql',
  '20260929110000_plan_no_trial.sql',
  '20261005130000_ls_user_by_email.sql',
  '20261010150000_billing_late_signup_link.sql',
];
export const migPath = (f) => fileURLToPath(new URL(`../../supabase/migrations/${f}`, import.meta.url));

function must(db, args) {
  const r = psqlSpawn(db, args);
  if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export function prepareBillingSchema(db, migrations = BILLING_MIGRATIONS) {
  must(db, ['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create schema if not exists auth;
    -- Supabase는 public의 새 함수에 anon·authenticated 실행권을 기본으로 준다 — 같게 걸어야 마이그레이션의
    -- "revoke ... from anon, authenticated" 줄이 실제로 효과가 있는지 권한 테스트가 가려낸다(없으면 지워도 초록).
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    -- created_at: is_pro(trial_14d·ends_at)의 language sql 본문이 CREATE 시점에 파싱된다 — 없으면 적용 자체가 실패
    -- email·email_confirmed_at: ls_user_by_email(20261005130000)이 같은 이유로 필요하다(Supabase auth.users와 같은 이름·타입)
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text, email_confirmed_at timestamptz);
    create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
    -- msgr 스키마 스텁(20260929110000의 entitled_pro_for가 join) — 900줄짜리 20260903120000_msgr.sql 전체를
    -- 로드하지 않고, is_pro()가 실제로 참조하는 3표만 auth.users와 같은 방식으로 최소 재현한다.
    create table if not exists public.msgr_orgs (id uuid primary key, deleted_at timestamptz);
    create table if not exists public.msgr_org_members (org_id uuid, user_id uuid, removed_at timestamptz, role text);
    create table if not exists public.msgr_org_entitlements (org_id uuid primary key, paid_until timestamptz);
  `]);
  for (const f of migrations) must(db, ['-f', migPath(f)]);
}

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`이름이 아니다: ${s}`); return s; };
const qlit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

export function pgSb(db) {
  const run = (q) => {
    const r = psqlSpawn(db, ['-A', '-t', '-c', q]);
    if (r.status === 0) return { out: r.stdout.trim(), error: null };
    const message = r.stderr.trim();
    // PostgREST는 스키마에 없는 함수를 PGRST202로 알린다 — 엣지 함수의 "마이그레이션 전" 분기가 이 코드를 본다.
    const code = /function public\.\S+\(.*\) does not exist/.test(message) ? 'PGRST202' : undefined;
    return { out: '', error: { message, ...(code ? { code } : {}) } };
  };
  return {
    async rpc(fn, args) {
      const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${qlit(v)}`).join(', ');
      const { out, error } = run(`set role service_role; select coalesce(to_json(public.${ident(fn)}(${named})), 'null'::json)`);
      return error ? { data: null, error } : { data: JSON.parse(out), error: null };
    },
    from(table) {
      return {
        select(cols) {
          const where = [];
          const q = {
            eq(c, v) { where.push(`${ident(c)} = ${qlit(v)}`); return q; },
            neq(c, v) { where.push(`${ident(c)} <> ${qlit(v)}`); return q; },
            async limit(n) {
              const list = String(cols).split(',').map((c) => ident(c.trim())).join(', '); // 'a, b, c' — PostgREST select 목록과 같은 모양
              const { out, error } = run(`select coalesce(json_agg(t), '[]'::json) from (select ${list} from public.${ident(table)}
                where ${where.join(' and ') || 'true'} limit ${Number(n)}) t`);
              return error ? { data: null, error } : { data: JSON.parse(out), error: null };
            },
          };
          return q;
        },
        async upsert(row, opts) {
          if (!opts?.ignoreDuplicates) throw new Error('엣지 함수는 ignoreDuplicates upsert만 쓴다 — 다른 모양이면 이 가짜를 넓힌다');
          const cols = Object.keys(row).map(ident);
          const conflict = String(opts.onConflict).split(',').map((c) => ident(c.trim())).join(', ');
          const { error } = run(`insert into public.${ident(table)} (${cols.join(', ')}) values (${cols.map((c) => qlit(row[c])).join(', ')})
            on conflict (${conflict}) do nothing`);
          return { error };
        },
      };
    },
  };
}
