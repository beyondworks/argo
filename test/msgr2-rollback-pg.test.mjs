// 메신저 v2 되돌림(scripts/rollback/*msgr2*.down.sql) — U1 → U3 → U2 → U2b → U6b → U6c-1a를 적용한 뒤 역순으로 되돌리면 단계마다 적용 전과 같다
// (public 함수 서명·본문·권한·definer·설정, 트리거, public 표·열·열 권한, 정책(public·storage·realtime), 타입).
// 빈 표가 아니면 아무것도 바꾸지 않고 멈춘다(기억 데이터 보존).
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-rollback-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setupBase, MSGR2_FILES, migText } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-rollback-pg.test.mjs';
const down = (f) => readFileSync(fileURLToPath(new URL(`../scripts/rollback/${f.replace(/\.sql$/, '.down.sql')}`, import.meta.url)), 'utf8');

let db; const F = MSGR2_FILES(); const snaps = {};
const snapshot = () => ({
  procs: db.sql(`select p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '-') || '|' || p.provolatile::text
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
                   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') order by 1`).split('\n'), // 확장(pgcrypto) 함수는 되돌림 대상이 아니다
  triggers: db.sql(`select tgrelid::regclass::text || ':' || tgname::text || ':' || tgfoid::regprocedure::text from pg_trigger where not tgisinternal order by 1`).split('\n'),
  columns: db.sql(`select table_name || '.' || column_name || ':' || data_type from information_schema.columns where table_schema = 'public' order by 1`).split('\n'),
  policies: db.sql(`select schemaname || '.' || tablename || ':' || policyname || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) from pg_policies where schemaname in ('public', 'storage', 'realtime') order by 1`).split('\n'),
  colacl: db.sql(`select a.attrelid::regclass::text || '.' || a.attname::text || ':' || a.attacl::text from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and a.attacl is not null and not a.attisdropped order by 1`).split('\n'), // 열 권한(U2·U6b의 grant select (열…)) — 되돌림이 열 권한을 남기거나 지우면 잡는다
  types: db.sql(`select t.typname::text from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'c' and not exists (select 1 from pg_class c where c.reltype = t.oid) order by 1`).split('\n'),
});

before(() => {
  if (!DB) return;
  db = setupBase(DB);
  snaps.base = snapshot();
  db.psql(['-c', migText(F.u1)]); snaps.u1 = snapshot();
  db.psql(['-c', migText(F.u3)]); snaps.u3 = snapshot();
  db.psql(['-c', migText(F.u2)]); snaps.u2 = snapshot();
  db.psql(['-c', migText(F.u2b)]); snaps.u2b = snapshot();
  db.psql(['-c', migText(F.u6b)]); snaps.u6b = snapshot();
  db.psql(['-c', migText(F.u6c1a)]); snaps.u6c1a = snapshot();
});

test('적용하면 단계마다 실제로 달라진다(비교가 헛돌지 않는다)', { skip }, () => {
  assert.ok(F.u3, 'U3 실물 파일이 있어야 한다');
  for (const [a, b] of [['base', 'u1'], ['u1', 'u3'], ['u3', 'u2'], ['u2', 'u2b'], ['u2b', 'u6b'], ['u6b', 'u6c1a']]) assert.notDeepEqual(snaps[b], snaps[a], `${a} → ${b}`);
  assert.ok(snaps.u2b.policies.some((p) => p.startsWith('storage.objects:msgr2_files_select')));
  assert.ok(snaps.u2.columns.includes('msgr2_messages.mentions:ARRAY'));
  assert.ok(snaps.u6b.colacl.some((x) => x.startsWith('msgr2_works.source_message_id:')), '열 권한이 스냅숏에 잡힌다');
  assert.ok(!snaps.u2b.colacl.some((x) => x.startsWith('msgr2_works.source_message_id:')));
});

test('빈 표가 아니면 멈춘다 — U2 되돌림은 일 행이 있으면 아무것도 바꾸지 않는다', { skip }, () => {
  db.sql(`insert into auth.users (id) values ('60000000-0000-4000-8000-000000000001') on conflict do nothing`);
  const sp = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '60000000-0000-4000-8000-000000000001') returning id`);
  const rm = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${sp}', 'private', 'x') returning id`);
  const ag = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug) values ('60000000-0000-4000-8000-000000000001', 'w', 's') returning id`);
  db.sql(`insert into public.msgr2_works (room_id, agent_id, owner_user_id, from_kind, from_id, root_user_id, tier, expires_at)
          values ('${rm}', '${ag}', '60000000-0000-4000-8000-000000000001', 'user', '60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'owner', now())`);
  const r = db.raw(['-v', 'ON_ERROR_STOP=1', '-c', down(F.u2)]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr2_rollback_not_empty: msgr2_works/);
  const now = snapshot(); assert.deepEqual(now, snaps.u6c1a, '멈추면 하나도 안 바뀐다');
  db.sql(`truncate public.msgr2_works, public.msgr2_agents, public.msgr2_rooms, public.msgr2_spaces cascade`); // 시험 DB 정리(시드만)
});

test('역순 되돌림 — U6c-1a → U6b → U2b → U2 → U3 → U1 각각 적용 전과 같다', { skip }, () => {
  db.psql(['-c', down(F.u6c1a)]); assert.deepEqual(snapshot(), snaps.u6b, 'U6c-1a 되돌림 = U6b 적용 직후(접속 표시 판정 U6b 본문 복원)');
  db.psql(['-c', down(F.u6b)]); assert.deepEqual(snapshot(), snaps.u2b, 'U6b 되돌림 = U2b 적용 직후');
  db.psql(['-c', down(F.u2b)]); assert.deepEqual(snapshot(), snaps.u2, 'U2b 되돌림 = U2 적용 직후');
  db.psql(['-c', down(F.u2)]); assert.deepEqual(snapshot(), snaps.u3, 'U2 되돌림 = U3 적용 직후(msgr2_access·msgr2_lock_cols U1 본문 복원)');
  db.psql(['-c', down(F.u3)]); assert.deepEqual(snapshot(), snaps.u1, 'U3 되돌림 = U1 적용 직후(기기 자리 함수 닫힘)');
  db.psql(['-c', down(F.u1)]); assert.deepEqual(snapshot(), snaps.base, 'U1 되돌림 = 적용 전');
  // 되돌린 뒤 다시 적용해도 된다(재적용 길)
  for (const f of [F.u1, F.u3, F.u2, F.u2b, F.u6b, F.u6c1a]) db.psql(['-c', migText(f)]);
  assert.deepEqual(snapshot(), snaps.u6c1a, '다시 적용 = 처음 적용');
});
