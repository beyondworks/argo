import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 문서함 공유 링크(15차, 유건 결정 5 — 메일 큰 첨부): 토큰은 SHA-256만 저장, 링크로는 그 파일 하나만, 만료·끊김·지운 파일은 열 수 없다,
// 만들기·끊기 권한(내 공간 본인 / 조직은 올린 사람·관리자), 같은 값 다시 쓰지 않기, 상한, 정리 작업이 만료·끊은 링크 행을 지운다, 공개 열기는 service_role·stable.
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'Run scripts/billing-pg-drill.sh test/office-file-links-pg.test.mjs';
const U = Object.fromEntries(['owner', 'admin', 'member', 'member2', 'guest', 'outsider'].map((k) => [k, randomUUID()]));
let ORG;
const raw = (q) => psqlSpawn(DB, ['-A', '-t', '-c', q]);
const sql = (q) => { const r = raw(q); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const org = (o) => (o ? `${quote(o)}::uuid` : 'null');
const userSql = (u, q) => `set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last = (s) => s.split('\n').filter(Boolean).at(-1);
const j = (d) => `${quote(JSON.stringify(d))}::jsonb`;
const call = (u, q) => JSON.parse(last(sql(userSql(u, `select ${q}`))));
const fails = (u, q) => { const r = raw(userSql(u, `select ${q}`)); assert.notEqual(r.status, 0, `should fail: ${q}`); return r.stderr; };
const svc = (q) => last(sql(`set role service_role; select ${q}`));
const fileWrite = (u, a, d, o = ORG) => call(u, `office_file_write(${org(o)},${quote(a)},${j(d)})`);
const linkWrite = (u, a, d, o = ORG) => call(u, `office_file_link_write(${org(o)},${quote(a)},${j(d)})`);
const linkFail = (u, a, d, o = ORG) => fails(u, `office_file_link_write(${org(o)},${quote(a)},${j(d)})`);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
/** 문서함 파일 하나(자리 → 서버 확인 → 등록) — 객체는 기록이 가진다(claimed) */
function newFile(u, { o = ORG, title = '도면.pdf', size = 1234 } = {}) {
  const id = randomUUID();
  const key = fileWrite(u, 'file.reserve', { id, filename: title, size, mime: 'application/pdf' }, o).key;
  svc(`r2_object_commit(${quote(key)},${size},'etag')`);
  fileWrite(u, 'file.create', { id, title, filename: title, mime: 'application/pdf', size, storage_path: key }, o);
  return { id, key };
}
/** 링크 만들기 → { id, tok, hash } */
function newLink(u, file, { o = ORG, days, source } = {}) {
  const tok = token(), id = randomUUID();
  const out = linkWrite(u, 'link.create', { id, file_id: file.id, token_hash: sha(tok), ...(days != null ? { days } : {}), ...(source ? { source } : {}) }, o);
  assert.equal(out.id, id);
  return { id, tok, hash: sha(tok), expires: out.expires_at };
}
const open = (hash) => { const r = svc(`office_file_link_open(${quote(hash)})`); return r ? JSON.parse(r) : null; };
const linkRow = (id) => { const r = sql(`select coalesce(revoked_at::text,'')||'|'||xmin::text from office_file_links where id=${quote(id)}`); if (!r) return null; const [revoked, xmin] = r.split('|'); return { revoked, xmin }; };

before(() => {
  if (!DB) return;
  sql(`do $$begin
 if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
 end$$;
 grant usage on schema public to anon,authenticated,service_role;
 create schema auth; grant usage on schema auth to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,created_at timestamptz default now(),email text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('argo.uid',true),'')::uuid$$;
 create schema storage;
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,created_at timestamptz default now(),metadata jsonb);
 create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint);
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated; grant select,insert,delete on storage.objects to authenticated;
 create schema realtime;
 create table realtime.messages(id bigint generated always as identity primary key,topic text,extension text,payload jsonb);
 create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
 create function realtime.send(payload jsonb,event text,topic text,private boolean default true) returns void language sql as $$select null::void$$;
 alter table realtime.messages enable row level security; grant select,insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql', '20260927144230_office_business.sql', '20260928010000_office_marketing.sql', '20260929140000_office_deal_flow.sql', '20260929180000_office_tasks_owners.sql',
    '20261002201700_office_files.sql', '20261004120000_office_file_links.sql', '20261004120000_office_file_links.sql']) { // 마지막 파일은 두 번 — 다시 적용해도 깨지지 않는다
    const r = psqlSpawn(DB, ['-f', fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url))]);
    if (r.status !== 0) throw new Error(`${f}: ${r.stderr}`);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users(id,email)values(${quote(id)},${quote(`${k}@example.test`)})`);
  ORG = last(sql(userSql(U.owner, `insert into msgr_orgs(name,slug,owner_user_id)values('Links','links',${quote(U.owner)}) returning id`)));
  sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
  for (const k of ['admin', 'member', 'member2', 'guest']) sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k === 'member2' ? 'member' : k)})`);
});

test('만들기·열기: DB에는 토큰 원문이 없고 SHA-256만, 기본 30일, 열면 그 파일의 이름·크기·키, 틀린 해시·형식은 null', { skip }, () => {
  const f = newFile(U.member, { o: null, title: '내 도면.pdf', size: 2048 });
  const l = newLink(U.member, f, { o: null, source: 'mail' });
  const days = (Date.parse(l.expires) - Date.now()) / 864e5;
  assert.ok(days > 29.9 && days <= 30, `기본 만료 30일(${days})`);
  assert.equal(sql(`select count(*) from office_file_links where token_hash=${quote(l.hash)} and source='mail'`), '1');
  assert.equal(sql(`select count(*) from office_file_links where position(${quote(l.tok)} in row(office_file_links.*)::text)>0`), '0', '토큰 원문은 어느 칸에도 없다');
  assert.deepEqual(sql(`select string_agg(column_name,',' order by column_name) from information_schema.columns where table_name='office_file_links'`).split(','),
    ['created_at', 'created_by', 'expires_at', 'file_id', 'id', 'revoked_at', 'scope', 'source', 'token_hash']);
  const o = open(l.hash);
  assert.equal(o.name, '내 도면.pdf'); assert.equal(Number(o.size), 2048); assert.equal(o.key, f.key); assert.equal(o.org, null);
  assert.equal(open(sha('other')), null);
  assert.equal(open('not-a-hash'), null);
  const og = newFile(U.member); const ol = newLink(U.member, og);
  assert.equal(open(ol.hash).org, 'Links', '조직 파일은 조직 이름을 같이 보인다');
});

test('권한: 내 공간은 본인만, 조직 파일은 올린 사람·관리자만 만든다 — 다른 직원·손님·남은 못 만들고, 남의 내 공간 파일은 찾을 수 없다', { skip }, () => {
  const f = newFile(U.member);
  newLink(U.member, f); newLink(U.admin, f); newLink(U.owner, f);
  const d = () => ({ id: randomUUID(), file_id: f.id, token_hash: sha(token()) });
  assert.match(linkFail(U.member2, 'link.create', d()), /file_forbidden/, '올리지 않은 직원');
  assert.match(linkFail(U.guest, 'link.create', d()), /file_forbidden/);
  assert.match(linkFail(U.outsider, 'link.create', d()), /file_forbidden/);
  const mine = newFile(U.member, { o: null });
  assert.match(linkFail(U.outsider, 'link.create', { id: randomUUID(), file_id: mine.id, token_hash: sha(token()) }, null), /file_not_found/, '남의 내 공간 파일');
  assert.match(fails('00000000-0000-4000-8000-000000000000', `office_file_link_list(null,${quote(mine.id)})`), /file_not_found/);
  assert.match(fails(U.outsider, `office_file_link_list(${org(ORG)},${quote(f.id)})`), /file_forbidden/);
  const viewer = call(U.member2, `office_file_link_list(${org(ORG)},${quote(f.id)})`);
  assert.equal(viewer.can, false, '볼 수는 있지만 만들기·끊기는 안 된다');
  assert.equal(viewer.links.length, 3);
  assert.equal(call(U.member, `office_file_link_list(${org(ORG)},${quote(f.id)})`).can, true);
  // 공개 열기·정리는 service_role만
  assert.match(fails(U.member, `office_file_link_open(${quote(sha('x'))})`), /permission denied/);
  assert.match(raw(`set role anon; select office_file_link_open(${quote(sha('x'))})`).stderr, /permission denied/);
  assert.match(fails(U.admin, 'office_storage_sweep(10)'), /permission denied/);
  assert.match(raw(userSql(U.member, 'select count(*) from office_file_links')).stderr, /permission denied/, '표는 함수로만');
});

test('입력 검사: 기간 1~90일, 해시 모양, 드라이브 링크는 안 된다, 같은 요청 다시는 그대로·다른 토큰이면 충돌, 같은 해시는 충돌', { skip }, () => {
  const f = newFile(U.member);
  for (const days of [0, 91, 'x']) assert.match(linkFail(U.member, 'link.create', { id: randomUUID(), file_id: f.id, token_hash: sha(token()), days }), /file_input/, String(days));
  assert.match(linkFail(U.member, 'link.create', { id: randomUUID(), file_id: f.id, token_hash: 'abc' }), /file_input/);
  const drive = randomUUID();
  fileWrite(U.member, 'link.create', { id: drive, title: '구글 문서', link_url: 'https://docs.google.com/document/d/x/edit' });
  assert.match(linkFail(U.member, 'link.create', { id: randomUUID(), file_id: drive, token_hash: sha(token()) }), /file_input/);
  const id = randomUUID(), h = sha(token());
  const a = linkWrite(U.member, 'link.create', { id, file_id: f.id, token_hash: h, days: 7 });
  assert.deepEqual(linkWrite(U.member, 'link.create', { id, file_id: f.id, token_hash: h, days: 7 }), a, '네트워크 재시도');
  assert.match(linkFail(U.member, 'link.create', { id, file_id: f.id, token_hash: sha(token()) }), /file_conflict/);
  assert.match(linkFail(U.member, 'link.create', { id: randomUUID(), file_id: f.id, token_hash: h }), /file_conflict/, '같은 해시');
  assert.ok((Date.parse(a.expires_at) - Date.now()) / 864e5 <= 7);
});

test('끊기: 만든 사람·올린 사람·관리자 — 끊으면 열 수 없고, 다시 끊어도 행을 다시 쓰지 않는다(xmin 그대로)', { skip }, () => {
  const f = newFile(U.member);
  const l = newLink(U.admin, f);
  assert.ok(open(l.hash));
  assert.match(linkFail(U.member2, 'link.revoke', { id: l.id }), /file_forbidden/);
  assert.match(linkFail(U.guest, 'link.revoke', { id: l.id }), /file_forbidden/);
  linkWrite(U.member, 'link.revoke', { id: l.id }); // 파일을 올린 사람
  assert.equal(open(l.hash), null);
  const before = linkRow(l.id);
  assert.ok(before.revoked);
  linkWrite(U.admin, 'link.revoke', { id: l.id });
  assert.deepEqual(linkRow(l.id), before, '이미 끊은 링크는 다시 쓰지 않는다');
  assert.ok(!call(U.member, `office_file_link_list(${org(ORG)},${quote(f.id)})`).links.some((x) => x.id === l.id), '끊은 링크는 목록에 없다');
  assert.match(linkFail(U.member, 'link.revoke', { id: randomUUID() }), /file_not_found/);
});

test('열 수 없는 링크: 만료·휴지통(되살리면 다시)·영구 삭제(행도 같이 지워짐)·객체가 지우기로 정해진 파일', { skip }, () => {
  const f = newFile(U.member);
  const l = newLink(U.member, f);
  sql(`update office_file_links set created_at=now()-interval '31 days', expires_at=now()-interval '1 second' where id=${quote(l.id)}`); // 만든 날이 만료보다 앞서야 한다(표 검사)
  assert.equal(open(l.hash), null, '만료');
  const l2 = newLink(U.member, f);
  fileWrite(U.member, 'file.trash', { ids: [f.id] });
  assert.equal(open(l2.hash), null, '휴지통');
  assert.match(linkFail(U.member, 'link.create', { id: randomUUID(), file_id: f.id, token_hash: sha(token()) }), /file_not_found/, '휴지통 파일로는 새 링크를 못 만든다');
  fileWrite(U.member, 'file.restore', { ids: [f.id] });
  assert.ok(open(l2.hash), '되살리면 만료 전 링크는 다시 열린다');
  sql(`update r2_objects set state='deleting' where key=${quote(f.key)}`);
  assert.equal(open(l2.hash), null, '객체가 지우기로 정해졌으면 열지 않는다');
  sql(`update r2_objects set state='claimed' where key=${quote(f.key)}`);
  fileWrite(U.member, 'file.trash', { ids: [f.id] });
  fileWrite(U.member, 'file.purge', { ids: [f.id] });
  assert.equal(sql(`select count(*) from office_file_links where file_id=${quote(f.id)}`), '0', '영구 삭제하면 링크 행도 지워진다');
});

test('상한: 파일 하나에 살아 있는 링크 20개', { skip }, () => {
  const f = newFile(U.member);
  for (let i = 0; i < 20; i++) newLink(U.member, f, { days: 1 });
  assert.match(linkFail(U.member, 'link.create', { id: randomUUID(), file_id: f.id, token_hash: sha(token()) }), /file_limit/);
  const one = sql(`select id from office_file_links where file_id=${quote(f.id)} limit 1`);
  linkWrite(U.member, 'link.revoke', { id: one });
  newLink(U.member, f); // 끊으면 자리가 난다
});

test('정리 작업: 만료·끊은 링크 행만 지우고 살아 있는 링크는 남긴다, 지운 수를 돌려준다, 다시 돌리면 0(유휴 쓰기 0)', { skip }, () => {
  const f = newFile(U.member);
  const alive = newLink(U.member, f), expired = newLink(U.member, f), cut = newLink(U.member, f);
  sql(`update office_file_links set created_at=now()-interval '31 days', expires_at=now()-interval '1 day' where id=${quote(expired.id)}`);
  linkWrite(U.member, 'link.revoke', { id: cut.id });
  const out = JSON.parse(svc('office_storage_sweep(500)'));
  assert.ok(out.links >= 2, `지운 링크 행 ${out.links}`);
  assert.ok(Array.isArray(out.keys), '기존 정리(지울 키 목록)는 그대로');
  assert.ok(linkRow(alive.id)); assert.equal(linkRow(expired.id), null); assert.equal(linkRow(cut.id), null);
  assert.equal(JSON.parse(svc('office_storage_sweep(500)')).links, 0);
});

test('공개 열기는 stable(열 때 DB에 쓰지 않는다), 만들기·끊기·목록 함수의 실행 권한', { skip }, () => {
  assert.equal(sql(`select provolatile::text from pg_proc where proname='office_file_link_open'`), 's');
  assert.equal(sql(`select provolatile::text from pg_proc where proname='office_file_link_list'`), 's');
  const can = (role, fn) => sql(`select has_function_privilege(${quote(role)}, ${quote(fn)}, 'execute')`);
  assert.equal(can('authenticated', 'office_file_link_write(uuid,text,jsonb)'), 't');
  assert.equal(can('anon', 'office_file_link_write(uuid,text,jsonb)'), 'f');
  assert.equal(can('authenticated', 'office_file_link_open(text)'), 'f');
  assert.equal(can('service_role', 'office_file_link_open(text)'), 't');
  assert.equal(can('service_role', 'office_storage_sweep(integer)'), 't');
  assert.equal(can('authenticated', 'office_storage_sweep(integer)'), 'f');
});
