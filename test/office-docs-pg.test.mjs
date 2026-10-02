import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 견적·계약·전자서명(20261002150000_office_docs.sql, spec8 트랙 A) — 조직 권한(멤버 읽기·관리자 쓰기), 저장소 경로 권한,
// 토큰 해시만으로 여는 공개 서명 함수(service_role 전용), 서명 기록 보호, 완료 시 거래 '계약'(보낸 사람 권한으로 office_business_write).
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'Run scripts/billing-pg-drill.sh test/office-docs-pg.test.mjs';
const U = Object.fromEntries(['owner', 'admin', 'member', 'guest', 'outsider'].map((k) => [k, randomUUID()]));
let ORG;
const raw = (q) => psqlSpawn(DB, ['-A', '-t', '-c', q]);
const sql = (q) => { const r = raw(q); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const j = (d) => `${quote(JSON.stringify(d))}::jsonb`;
const last = (s) => s.split('\n').filter(Boolean).at(-1);
const as = (u, q) => `set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const call = (u, fn, args) => JSON.parse(last(sql(as(u, `select ${fn}(${args})`))));
const fails = (u, fn, args) => { const r = raw(as(u, `select ${fn}(${args})`)); assert.notEqual(r.status, 0, `${fn} should fail`); return r.stderr; };
const svc = (fn, args) => JSON.parse(last(sql(`set role service_role; select ${fn}(${args})`)) || 'null');
const svcFail = (fn, args) => { const r = raw(`set role service_role; select ${fn}(${args})`); assert.notEqual(r.status, 0, `${fn} should fail`); return r.stderr; };
const write = (u, a, d) => call(u, 'office_docs_write', `${quote(ORG)},${quote(a)},${j(d)}`);
const writeFail = (u, a, d) => fails(u, 'office_docs_write', `${quote(ORG)},${quote(a)},${j(d)}`);
const bwrite = (a, d) => call(U.owner, 'office_business_write', `${quote(ORG)},${quote(randomUUID())},${quote(a)},${j(d)}`).id;
const sha = (s) => createHash('sha256').update(s).digest('hex');
let SEG, ORDER, CUSTOMER;

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
 -- 실제 Supabase auth.uid()처럼 요청 클레임(request.jwt.claim.sub)도 읽는다 — 완료 함수가 보낸 사람으로 업무 원장을 부르는 길을 시험
 create function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('argo.uid',true),''))::uuid$$;
 create schema storage;
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid);
 create table storage.buckets(id text primary key,name text,public boolean default false);
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated; grant select,insert,delete on storage.objects to authenticated;
 create schema realtime;
 create table realtime.messages(id bigint generated always as identity primary key,topic text,extension text,payload jsonb);
 create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
 create function realtime.send(payload jsonb,event text,topic text,private boolean default true) returns void language sql as $$select null::void$$;
 alter table realtime.messages enable row level security; grant select,insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql', '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql', '20260927144230_office_business.sql', '20260927171000_office_mail.sql', '20260928010000_office_marketing.sql', '20260929140000_office_deal_flow.sql', '20260929180000_office_tasks_owners.sql', '20261002150000_office_docs.sql']) {
    const r = psqlSpawn(DB, ['-f', fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url))]); if (r.status !== 0) throw new Error(`${f}: ${r.stderr}`);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k + '@example.test')})`);
  ORG = last(sql(as(U.owner, `insert into msgr_orgs(name,slug,owner_user_id)values('비욘드웍스','docs',${quote(U.owner)}) returning id`)));
  sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
  for (const k of ['admin', 'member', 'guest']) sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k)})`);
  SEG = `o-${ORG}`;
  CUSTOMER = bwrite('customer.save', { name: '한빛', email: '', notes: '' });
  const item = bwrite('item.save', { name: '구축', kind: 'service', sku: '', price: 1000 });
  ORDER = bwrite('order.create', { title: '한빛 구축', customer_id: CUSTOMER, lines: [{ item_id: item, quantity: 1, unit_price: 1000, tax_type: 'taxable' }] });
});

test('권한: 멤버는 읽고 관리자만 쓴다, 손님·밖 사람은 못 본다, 표를 직접 만지는 길은 없다', { skip }, () => {
  const id = randomUUID();
  const doc = write(U.admin, 'doc.save', { id, kind: 'quote', title: '견적서 — 한빛', customer_name: '한빛', customer_id: CUSTOMER, order_id: ORDER, input: { a: 1 }, pdf_path: `${SEG}/docs/${id}.pdf`, pdf_size: 10, pdf_hash: 'h', filename: '한빛_견적서.pdf', supply: 1000, vat: 100, total: 1100 });
  assert.equal(doc.scope, undefined); assert.equal(doc.created_by, U.admin);
  const read = call(U.member, 'office_docs_read', quote(ORG));
  assert.equal(read.docs.length, 1); assert.equal(read.can_write, false);
  assert.equal(call(U.admin, 'office_docs_read', quote(ORG)).can_write, true);
  assert.match(writeFail(U.member, 'doc.save', { id: randomUUID(), kind: 'quote', title: 'x' }), /business_forbidden/);
  assert.match(fails(U.guest, 'office_docs_read', quote(ORG)), /business_forbidden/);
  assert.match(fails(U.outsider, 'office_docs_read', quote(ORG)), /business_forbidden/);
  assert.notEqual(raw(as(U.admin, 'select * from office_docs')).status, 0);
  assert.equal(call(U.outsider, 'office_docs_read', 'null').docs.length, 0, '내 공간은 본인 것만');
});

test('경로·연결 검사: 저장소 경로는 이 공간·이 문서 자리만, 다른 공간의 거래처·거래는 이을 수 없다', { skip }, () => {
  const id = randomUUID();
  assert.match(writeFail(U.admin, 'doc.save', { id, kind: 'quote', title: 'x', pdf_path: `u-${U.admin}/docs/${id}.pdf` }), /docs_path/);
  assert.match(writeFail(U.admin, 'doc.save', { id, kind: 'quote', title: 'x', customer_id: randomUUID() }), /docs_not_found/);
  assert.match(writeFail(U.admin, 'esign.create', { id, title: 'x', orig_path: `${SEG}/esign/${randomUUID()}/orig.pdf`, doc_hash: 'a'.repeat(64) }), /docs_input/);
});

test('저장소 정책 함수: 내 공간·내 조직(쓰기는 관리자)만, 경로 탈출 거절', { skip }, () => {
  const ok = (u, name, w) => last(sql(as(u, `select office_docs_storage_ok(${quote(name)},${w})`))) === 't';
  assert.ok(ok(U.member, `${SEG}/docs/a.pdf`, false)); assert.ok(!ok(U.member, `${SEG}/docs/a.pdf`, true));
  assert.ok(ok(U.admin, `${SEG}/docs/a.pdf`, true)); assert.ok(!ok(U.guest, `${SEG}/docs/a.pdf`, false)); assert.ok(!ok(U.outsider, `${SEG}/docs/a.pdf`, false));
  assert.ok(ok(U.outsider, `u-${U.outsider}/docs/a.pdf`, true)); assert.ok(!ok(U.outsider, `u-${U.admin}/docs/a.pdf`, false));
  assert.ok(!ok(U.admin, `${SEG}/../x`, false));
  assert.equal(sql(`select count(*) from pg_policies where tablename='objects' and policyname like 'office_docs_%'`), '3', '읽기·올리기·지우기 — 고쳐 쓰기 없음');
});

let E, TA, TB;
test('서명 요청: 초안 → 발송(토큰 해시만, 30일 상한), 다시 보내기 거절, 서명자 검사', { skip }, () => {
  E = randomUUID();
  const e = write(U.admin, 'esign.create', { id: E, title: '용역 계약서', order_id: ORDER, orig_path: `${SEG}/esign/${E}/orig.pdf`, doc_hash: 'a'.repeat(64), fields: [{ kind: 'signature', page: 0, signer_ord: 0 }, { kind: 'date', page: 0, signer_ord: 0 }, { kind: 'signature', page: 0, signer_ord: 1 }], signers: [{ name: '한빛', email: 'p@h.example' }, { name: '', email: 'x@x.x' }], pages: 1 });
  assert.equal(e.status, 'draft'); assert.equal(e.signers.length, 1, '이름 없는 서명자는 빠진다'); assert.equal(e.mail_account, undefined);
  TA = 'A'.repeat(43); TB = 'B'.repeat(43);
  assert.match(writeFail(U.admin, 'esign.send', { id: E, signers: [{ name: 'a', email: 'p@h.example', token_hash: 'nothex' }] }), /docs_input/);
  assert.match(writeFail(U.admin, 'esign.send', { id: E, signers: [] }), /docs_signers/);
  const sent = write(U.admin, 'esign.send', { id: E, expires_at: '2099-01-01T00:00:00Z', signers: [{ name: '한빛', email: 'p@h.example', token_hash: sha(TA) }, { name: '비욘드', email: 'me@b.example', token_hash: sha(TB) }] });
  assert.equal(sent.status, 'sent'); assert.equal(sent.signers.length, 2); assert.equal(sent.signers[0].token_hash, undefined, '해시도 화면에 안 나간다');
  assert.ok(Number(sql(`select extract(day from max(token_expires)-now()) from office_esign_signers where esign_id=${quote(E)}`)) <= 30, '기간은 30일 상한');
  assert.match(writeFail(U.admin, 'esign.send', { id: E, signers: [{ name: 'x', email: 'x@x.x', token_hash: sha('z') }] }), /docs_sent/);
});

test('공개 함수는 서버(service_role)만 — 로그인한 사람도 직접 못 부른다', { skip }, () => {
  assert.match(fails(U.admin, 'office_esign_public_state', quote(sha(TA))), /permission denied/);
  assert.match(fails(U.admin, 'office_esign_public_finalize', `${quote(E)},'x','y'`), /permission denied/);
});

test('공개 서명: 가린 이메일 → 다른 이메일 거절 → 자기 칸만 → 열람 10분에 한 번 → 그림 경로는 자기 자리만 → 둘 다 내면 완료', { skip }, () => {
  assert.deepEqual(svc('office_esign_public_state', quote(sha(TA))), { status: 'pending', maskedEmail: 'p**@h.example' });
  assert.match(svcFail('office_esign_public_state', quote(sha('nope'))), /docs_invalid/);
  assert.match(svcFail('office_esign_public_open', `${quote(sha(TA))},'x@x.x','1.1.1.1','ua'`), /docs_email/);
  const o = svc('office_esign_public_open', `${quote(sha(TA))},' P@H.example ','1.1.1.1','ua'`);
  assert.equal(o.fields.length, 2); assert.equal(o.signer.ord, 0); assert.equal(o.contract.sender, '비욘드웍스'); assert.equal(o.orig_path, `${SEG}/esign/${E}/orig.pdf`);
  svc('office_esign_public_open', `${quote(sha(TA))},'p@h.example','1.1.1.1','ua'`);
  assert.equal(sql(`select count(*) from office_esign_events where esign_id=${quote(E)} and action='opened'`), '1');
  const who = svc('office_esign_public_who', quote(sha(TA)));
  const bad = [{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${E}/s-${randomUUID()}-0.png` }];
  assert.match(svcFail('office_esign_public_submit', `${quote(sha(TA))},'p@h.example',${j(bad)},'1.1.1.1','ua'`), /docs_input/);
  const good = [{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${E}/s-${who.signer_id}-0.png`, xr: 0.1, yr: 0.1, wr: 0.2 }, { page: 0, kind: 'text', text: '2026-10-02' }];
  assert.equal(svc('office_esign_public_submit', `${quote(sha(TA))},'p@h.example',${j(good)},'1.1.1.1','ua'`).done, false);
  assert.match(svcFail('office_esign_public_submit', `${quote(sha(TA))},'p@h.example',${j(good)},'1.1.1.1','ua'`), /docs_already/);
  assert.match(writeFail(U.admin, 'esign.update', { id: E, fields: [] }), /docs_state/, '보낸 뒤에는 칸·서명자를 못 바꾼다');
  const whoB = svc('office_esign_public_who', quote(sha(TB)));
  assert.equal(svc('office_esign_public_submit', `${quote(sha(TB))},'me@b.example',${j([{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${E}/s-${whoB.signer_id}-0.png` }])},'2.2.2.2','ua'`).done, true);
  const bundle = svc('office_esign_public_bundle', quote(E));
  assert.equal(bundle.signers.length, 2); assert.equal(bundle.signers[0].ip, '1.1.1.1'); assert.equal(bundle.seg, SEG);
});

test('완료: 서명본 경로·해시 검사 → 완료·링크 잠금, 연결 거래가 견적이면 보낸 사람 권한으로 계약(업무 원장 규칙 그대로), 두 번 불러도 한 번', { skip }, () => {
  assert.match(svcFail('office_esign_public_finalize', `${quote(E)},'x/final.pdf',${quote('f'.repeat(64))}`), /docs_input/);
  const r = svc('office_esign_public_finalize', `${quote(E)},${quote(`${SEG}/esign/${E}/final.pdf`)},${quote('f'.repeat(64))}`);
  assert.equal(r.order_sync, 'confirmed');
  assert.equal(sql(`select status from office_business_orders where id=${quote(ORDER)}`), 'confirmed');
  assert.equal(sql(`select count(*) from office_business_activity where order_id=${quote(ORDER)} and kind='contract'`), '1');
  assert.equal(sql(`select status||','||coalesce(final_hash,'') from office_esign where id=${quote(E)}`), `completed,${'f'.repeat(64)}`);
  assert.match(svcFail('office_esign_public_state', quote(sha(TA))), /docs_invalid/, '완료 뒤 링크는 잠긴다');
  assert.equal(svc('office_esign_public_finalize', `${quote(E)},${quote(`${SEG}/esign/${E}/final.pdf`)},${quote('f'.repeat(64))}`).already, true);
  assert.equal(sql(`select coalesce(current_setting('request.jwt.claim.sub',true),'')`), '', '보낸 사람 권한은 그 트랜잭션 안에서만');
  assert.match(writeFail(U.admin, 'esign.cancel', { id: E }), /docs_completed/);
  svc('office_esign_public_notified', quote(E));
  assert.deepEqual(call(U.member, 'office_docs_events', `${quote(ORG)},${quote(E)}`).map((x) => x.action), ['created', 'sent', 'opened', 'signed', 'signed', 'completed', 'notified']);
});

test('거래가 이미 계약 이후면 넘기지 않고 사유를 남긴다, 취소하면 링크가 끊긴다, 지우면 파일 경로를 돌려주고 기록이 함께 지워진다', { skip }, () => {
  const id = randomUUID(), t = 'C'.repeat(43);
  write(U.admin, 'esign.create', { id, title: '두 번째', order_id: ORDER, orig_path: `${SEG}/esign/${id}/orig.pdf`, doc_hash: 'b'.repeat(64) });
  write(U.admin, 'esign.send', { id, signers: [{ name: 'A', email: 'a@x.example', token_hash: sha(t) }] });
  const who = svc('office_esign_public_who', quote(sha(t)));
  svc('office_esign_public_submit', `${quote(sha(t))},'a@x.example',${j([{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${id}/s-${who.signer_id}-0.png` }])},'3.3.3.3','ua'`);
  assert.equal(svc('office_esign_public_finalize', `${quote(id)},${quote(`${SEG}/esign/${id}/final.pdf`)},${quote('e'.repeat(64))}`).order_sync, 'skipped:confirmed');
  const del = write(U.admin, 'esign.delete', { id });
  assert.deepEqual(del.paths.sort(), [`${SEG}/esign/${id}/final.pdf`, `${SEG}/esign/${id}/orig.pdf`, `${SEG}/esign/${id}/s-${who.signer_id}-0.png`].sort());
  assert.equal(sql(`select count(*) from office_esign_events where esign_id=${quote(id)}`), '0');
  const c = randomUUID(), tc = 'D'.repeat(43);
  write(U.admin, 'esign.create', { id: c, title: '취소할 것', orig_path: `${SEG}/esign/${c}/orig.pdf`, doc_hash: 'c'.repeat(64) });
  write(U.admin, 'esign.send', { id: c, signers: [{ name: 'A', email: 'a@x.example', token_hash: sha(tc) }] });
  write(U.admin, 'esign.cancel', { id: c });
  assert.match(svcFail('office_esign_public_state', quote(sha(tc))), /docs_invalid/);
});
