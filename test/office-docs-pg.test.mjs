import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 견적·계약·전자서명(20261002201900_office_docs.sql, spec8 트랙 A) — 조직 권한(멤버 읽기·관리자 쓰기), R2 객체 목록(r2_objects — 키는 DB가 정한다),
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
const fwrite = (u, a, d, o = ORG) => call(u, 'office_file_write', `${o ? quote(o) + '::uuid' : 'null'},${quote(a)},${j(d)}`);
const fwriteFail = (u, a, d, o = ORG) => fails(u, 'office_file_write', `${o ? quote(o) + '::uuid' : 'null'},${quote(a)},${j(d)}`);
const arr = (a) => `array[${a.map(quote).join(',')}]::text[]`;
/** 서버가 R2 HEAD로 본 크기를 적는다(service_role) */
const commit = (key, size) => svc('r2_object_commit', `${quote(key)},${size},'etag'`);
/** 서버가 직접 쓰는 객체(서명 그림·서명본) 등록 */
const serverPut = (key, size, state, ref, mime = 'application/pdf') => sql(`set role service_role; select r2_object_server_put(${quote(key)},${quote(key.split('/')[0])},${size},${quote(mime)},${quote(state)},'esign',${ref ? quote(ref) : 'null'})`);
const row = (k) => sql(`select state||'|'||bytes||'|'||coalesce(ref_kind,'')||'|'||mime from r2_objects where key=${quote(k)}`);
const grant = (u, keys) => JSON.parse(last(sql(as(u, `select r2_object_read_grant(${arr(keys)})`)))).map((x) => x.key);
/** 문서 PDF 올리기(자리 → 서버 확인) → 키 */
const docPdf = (u, id, size = 100, o = ORG) => { const key = call(u, 'office_docs_write', `${o ? quote(o) : 'null'},'doc.reserve',${j({ id, size })}`).path; commit(key, size); return key; };
/** 서명 원본 올리기 → 키 */
const origPdf = (u, id, size = 100) => { const key = write(u, 'esign.reserve', { id, size }).path; commit(key, size); return key; };
/** 문서함에 서명본·생성 문서 사본 넣기(자리 → 서버 확인 → 등록) */
const fileCopy = (u, size, extra) => { const id = randomUUID(); const path = fwrite(u, 'file.reserve', { id, filename: 'copy.pdf', size, mime: 'application/pdf' }).key; commit(path, size); return { id, path, out: () => fwrite(u, 'file.create', { id, title: 'copy.pdf', storage_path: path, size, ...extra }), fail: () => fwriteFail(u, 'file.create', { id, title: 'copy.pdf', storage_path: path, size, ...extra }) }; };
let SEG, ORDER, CUSTOMER;
const finalKey = (id, a = '0123456789ab') => `${SEG}/esign/${id}/final-${a}.pdf`; // 마무리 시도마다 다른 키(검수 1)

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
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,created_at timestamptz default now(),metadata jsonb);
 create table storage.buckets(id text primary key,name text,public boolean default false);
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated; grant select,insert,delete on storage.objects to authenticated;
 create schema realtime;
 create table realtime.messages(id bigint generated always as identity primary key,topic text,extension text,payload jsonb);
 create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
 create function realtime.send(payload jsonb,event text,topic text,private boolean default true) returns void language sql as $$select null::void$$;
 alter table realtime.messages enable row level security; grant select,insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql', '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql', '20260927144230_office_business.sql', '20260927171000_office_mail.sql', '20260928010000_office_marketing.sql', '20260929140000_office_deal_flow.sql', '20260929180000_office_tasks_owners.sql', '20261002201700_office_files.sql', '20261002201900_office_docs.sql']) {
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
  const doc = write(U.admin, 'doc.save', { id, kind: 'quote', title: '견적서 — 한빛', customer_name: '한빛', customer_id: CUSTOMER, order_id: ORDER, input: { a: 1 }, pdf_path: docPdf(U.admin, id), pdf_size: 10, pdf_hash: 'h', filename: '한빛_견적서.pdf', supply: 1000, vat: 100, total: 1100 });
  assert.equal(doc.scope, undefined); assert.equal(doc.created_by, U.admin);
  const read = call(U.member, 'office_docs_read', quote(ORG));
  assert.equal(read.docs.length, 1); assert.equal(read.can_write, false);
  assert.equal(read.docs[0].input, undefined, '목록에는 입력값을 싣지 않는다(전송량)');
  assert.deepEqual(call(U.member, 'office_docs_get', `${quote(ORG)},'doc',${quote(id)}`).input, { a: 1 }, '열 때 한 건만');
  assert.match(fails(U.guest, 'office_docs_get', `${quote(ORG)},'doc',${quote(id)}`), /business_forbidden/);
  assert.match(fails(U.member, 'office_docs_get', `${quote(ORG)},'doc',${quote(randomUUID())}`), /docs_not_found/);
  assert.equal(call(U.admin, 'office_docs_read', quote(ORG)).can_write, true);
  assert.match(writeFail(U.member, 'doc.save', { id: randomUUID(), kind: 'quote', title: 'x' }), /business_forbidden/);
  assert.match(fails(U.guest, 'office_docs_read', quote(ORG)), /business_forbidden/);
  assert.match(fails(U.outsider, 'office_docs_read', quote(ORG)), /business_forbidden/);
  assert.notEqual(raw(as(U.admin, 'select * from office_docs')).status, 0);
  assert.equal(call(U.outsider, 'office_docs_read', 'null').docs.length, 0, '내 공간은 본인 것만');
});

test('경로·연결 검사: 저장소 경로는 이 공간·이 문서 자리만, 다른 공간의 거래처·거래는 이을 수 없다', { skip }, () => {
  const id = randomUUID();
  assert.match(writeFail(U.admin, 'doc.save', { id, kind: 'quote', title: 'x', pdf_path: `u-${U.admin}/docs/${id}/${randomUUID()}.pdf` }), /docs_path/);
  assert.match(writeFail(U.admin, 'doc.save', { id, kind: 'quote', title: 'x', pdf_path: `${SEG}/docs/${id}.pdf` }), /docs_path/, '판 없는 옛 모양');
  assert.match(writeFail(U.admin, 'doc.save', { id, kind: 'quote', title: 'x', pdf_path: `${SEG}/docs/${id}/${randomUUID()}.pdf` }), /file_missing/, '올리지 않은 PDF');
  assert.match(writeFail(U.admin, 'doc.save', { id, kind: 'quote', title: 'x', customer_id: randomUUID() }), /docs_not_found/);
  assert.match(writeFail(U.admin, 'esign.create', { id, title: 'x', orig_path: `${SEG}/esign/${randomUUID()}/orig.pdf`, doc_hash: 'a'.repeat(64) }), /docs_input/);
});

test('열기 판정: 문서 PDF·서명 원본은 멤버가 읽고 손님·밖 사람은 못 읽는다, 내 공간은 본인만', { skip }, () => {
  const id = randomUUID(), key = docPdf(U.admin, id);
  write(U.admin, 'doc.save', { id, kind: 'quote', title: '읽기', pdf_path: key });
  assert.deepEqual(grant(U.member, [key]), [key]); assert.deepEqual(grant(U.guest, [key]), []); assert.deepEqual(grant(U.outsider, [key]), []);
  const mine = randomUUID(), mk = docPdf(U.outsider, mine, 50, null);
  call(U.outsider, 'office_docs_write', `null,'doc.save',${j({ id: mine, kind: 'quote', title: '내 것', pdf_path: mk })}`);
  assert.deepEqual(grant(U.outsider, [mk]), [mk]); assert.deepEqual(grant(U.admin, [mk]), []);
  assert.equal(row(key), 'claimed|100|doc|application/pdf');
});

let E, TA, TB;
const FINAL_SIZE = 5000;
test('서명 요청: 초안 → 발송(토큰 해시만, 30일 상한), 다시 보내기 거절, 서명자 검사', { skip }, () => {
  E = randomUUID();
  assert.match(writeFail(U.admin, 'esign.create', { id: E, title: '용역 계약서', orig_path: `${SEG}/esign/${E}/orig.pdf`, doc_hash: 'a'.repeat(64) }), /file_missing/, '원본을 올리기 전에는 만들 수 없다');
  const e = write(U.admin, 'esign.create', { id: E, title: '용역 계약서', order_id: ORDER, orig_path: origPdf(U.admin, E), doc_hash: 'a'.repeat(64), fields: [{ kind: 'signature', page: 0, signer_ord: 0 }, { kind: 'date', page: 0, signer_ord: 0 }, { kind: 'signature', page: 0, signer_ord: 1 }], signers: [{ name: '한빛', email: 'p@h.example' }, { name: '', email: 'x@x.x' }], pages: 1 });
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
  assert.match(svcFail('office_esign_public_who', `${quote(sha(TA))},'x@x.x'`), /docs_email/, '이메일 확인 전에는 그림 자리를 주지 않는다');
  const who = svc('office_esign_public_who', `${quote(sha(TA))},'p@h.example'`);
  assert.equal(who.all_signed, false);
  const bad = [{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${E}/s-${randomUUID()}-0.png` }];
  assert.match(svcFail('office_esign_public_submit', `${quote(sha(TA))},'p@h.example',${j(bad)},'1.1.1.1','ua'`), /docs_input/);
  const good = [{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${E}/s-${who.signer_id}-0.png`, xr: 0.1, yr: 0.1, wr: 0.2 }, { page: 0, kind: 'text', text: '2026-10-02' }];
  assert.match(svcFail('office_esign_public_submit', `${quote(sha(TA))},'p@h.example',${j(good)},'1.1.1.1','ua'`), /docs_input/, '서버가 R2에 올려 등록하지 않은 그림은 받지 않는다');
  serverPut(good[0].img_path, 10, 'uploaded', E, 'image/png');
  assert.equal(svc('office_esign_public_submit', `${quote(sha(TA))},'p@h.example',${j(good)},'1.1.1.1','ua'`).done, false);
  assert.match(svcFail('office_esign_public_submit', `${quote(sha(TA))},'p@h.example',${j(good)},'1.1.1.1','ua'`), /docs_already/);
  assert.match(writeFail(U.admin, 'esign.update', { id: E, fields: [] }), /docs_state/, '보낸 뒤에는 칸·서명자를 못 바꾼다');
  const whoB = svc('office_esign_public_who', `${quote(sha(TB))},'me@b.example'`);
  assert.equal(row(good[0].img_path), 'claimed|10|esign|image/png', '제출이 그림을 가져간다(정리 대상에서 빠진다)');
  serverPut(`${SEG}/esign/${E}/s-${whoB.signer_id}-0.png`, 10, 'uploaded', E, 'image/png');
  assert.equal(svc('office_esign_public_submit', `${quote(sha(TB))},'me@b.example',${j([{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${E}/s-${whoB.signer_id}-0.png` }])},'2.2.2.2','ua'`).done, true);
  assert.equal(svc('office_esign_public_who', `${quote(sha(TB))},'me@b.example'`).all_signed, true, '끊긴 마무리를 서버가 알아본다');
  const bundle = svc('office_esign_public_bundle', quote(E));
  assert.equal(bundle.signers.length, 2); assert.equal(bundle.signers[0].ip, '1.1.1.1'); assert.equal(bundle.seg, SEG);
});

test('완료: 서명본 경로·해시 검사 → 완료·링크 잠금, 연결 거래가 견적이면 보낸 사람 권한으로 계약(업무 원장 규칙 그대로), 두 번 불러도 한 번', { skip }, () => {
  assert.match(svcFail('office_esign_public_finalize', `${quote(E)},'x/final.pdf',${quote('f'.repeat(64))}`), /docs_input/);
  // 원래 호출자의 클레임으로 되돌리는지 — 같은 트랜잭션 안에서 본다
  assert.match(svcFail('office_esign_public_finalize', `${quote(E)},${quote(finalKey(E))},${quote('f'.repeat(64))}`), /docs_input/, '서버가 R2에 올려 등록하지 않은 서명본으로는 완료할 수 없다');
  serverPut(finalKey(E), FINAL_SIZE, 'uploaded', E);
  const after = sql(`set local role service_role; set local request.jwt.claims = '{"role":"service_role"}'; select office_esign_public_finalize(${quote(E)},${quote(finalKey(E))},${quote('f'.repeat(64))}); select current_setting('request.jwt.claims')`);
  assert.equal(last(after), '{"role":"service_role"}', '보낸 사람 흉내 뒤 service_role 클레임으로 되돌린다');
  const r = { order_sync: sql(`select order_sync from office_esign where id=${quote(E)}`) };
  assert.equal(r.order_sync, 'confirmed');
  assert.equal(sql(`select status from office_business_orders where id=${quote(ORDER)}`), 'confirmed');
  assert.equal(sql(`select count(*) from office_business_activity where order_id=${quote(ORDER)} and kind='contract'`), '1');
  assert.equal(sql(`select status||','||coalesce(final_hash,'') from office_esign where id=${quote(E)}`), `completed,${'f'.repeat(64)}`);
  assert.match(svcFail('office_esign_public_state', quote(sha(TA))), /docs_invalid/, '완료 뒤 링크는 잠긴다');
  assert.equal(row(finalKey(E)).split('|')[0], 'claimed', '완료가 서명본을 가져간다');
  // 검수 1: 겹친 마무리(다른 시도의 서명본) — 이긴 쪽 경로·해시만 남고, 진 쪽 객체는 등록 전이라 정리 대상
  serverPut(finalKey(E, 'bbbbbbbbbbbb'), FINAL_SIZE + 7, 'uploaded', E);
  const late = svc('office_esign_public_finalize', `${quote(E)},${quote(finalKey(E, 'bbbbbbbbbbbb'))},${quote('b'.repeat(64))}`);
  assert.deepEqual([late.already, late.final_path], [true, finalKey(E)], '진 쪽은 이긴 쪽 서명본 경로를 돌려받는다');
  assert.equal(sql(`select final_path||','||final_hash from office_esign where id=${quote(E)}`), `${finalKey(E)},${'f'.repeat(64)}`, '기록은 이긴 쪽 그대로');
  assert.equal(row(finalKey(E, 'bbbbbbbbbbbb')).split('|')[0], 'uploaded');
  assert.equal(sql(`select coalesce(current_setting('request.jwt.claim.sub',true),'')`), '', '보낸 사람 권한은 그 트랜잭션 안에서만');
  assert.match(writeFail(U.admin, 'esign.cancel', { id: E }), /docs_completed/);
  svc('office_esign_public_notified', quote(E));
  assert.deepEqual(call(U.member, 'office_docs_events', `${quote(ORG)},${quote(E)}`).map((x) => x.action), ['created', 'sent', 'opened', 'signed', 'signed', 'completed', 'notified']);
});

test('거래가 이미 계약 이후면 넘기지 않고 사유를 남긴다, 취소하면 링크가 끊긴다, 지우면 파일 경로를 돌려주고 기록이 함께 지워진다', { skip }, () => {
  const id = randomUUID(), t = 'C'.repeat(43);
  write(U.admin, 'esign.create', { id, title: '두 번째', order_id: ORDER, orig_path: origPdf(U.admin, id), doc_hash: 'b'.repeat(64) });
  write(U.admin, 'esign.send', { id, signers: [{ name: 'A', email: 'a@x.example', token_hash: sha(t) }] });
  assert.match(writeFail(U.admin, 'esign.reserve', { id, size: 10 }), /docs_state/, '서명 기록이 있는 동안 원본 자리를 다시 받을 수 없다(바꿔 끼우기 불가)');
  assert.deepEqual(grant(U.member, [`${SEG}/esign/${id}/orig.pdf`]), [`${SEG}/esign/${id}/orig.pdf`], '읽기는 멤버');
  const who = svc('office_esign_public_who', `${quote(sha(t))},'a@x.example'`);
  assert.match(writeFail(U.admin, 'esign.finishable', { id }), /docs_state/, '서명 전에는 다시 시도할 것이 없다');
  serverPut(`${SEG}/esign/${id}/s-${who.signer_id}-0-abc.png`, 9, 'uploaded', id, 'image/png');
  serverPut(`${SEG}/esign/${id}/s-${who.signer_id}-0-old.png`, 9, 'uploaded', id, 'image/png'); // 실패한 앞 시도의 그림
  svc('office_esign_public_submit', `${quote(sha(t))},'a@x.example',${j([{ page: 0, kind: 'signature', img_path: `${SEG}/esign/${id}/s-${who.signer_id}-0-abc.png` }])},'3.3.3.3','ua'`);
  assert.match(writeFail(U.admin, 'esign.cancel', { id }), /docs_signed/, '전원 서명 건은 취소하지 않는다(완료 다시 시도)');
  assert.equal(write(U.admin, 'esign.finishable', { id }).id, id);
  assert.match(writeFail(U.member, 'esign.finishable', { id }), /business_forbidden/);
  serverPut(finalKey(id), 20, 'uploaded', id);
  assert.equal(svc('office_esign_public_finalize', `${quote(id)},${quote(finalKey(id))},${quote('e'.repeat(64))}`).order_sync, 'skipped:confirmed');
  const del = write(U.admin, 'esign.delete', { id });
  const all = [finalKey(id), `${SEG}/esign/${id}/orig.pdf`, `${SEG}/esign/${id}/s-${who.signer_id}-0-abc.png`, `${SEG}/esign/${id}/s-${who.signer_id}-0-old.png`].sort();
  assert.deepEqual(del.keys, all, '서명 폴더 아래 전부 — 실패한 시도의 그림까지');
  assert.ok(all.every((k) => row(k).startsWith('deleting|')), '기록과 같은 트랜잭션에서 지우기로 정해졌다');
  assert.equal(sql(`select count(*) from office_esign_events where esign_id=${quote(id)}`), '0');
  const c = randomUUID(), tc = 'D'.repeat(43);
  write(U.admin, 'esign.create', { id: c, title: '취소할 것', orig_path: origPdf(U.admin, c), doc_hash: 'c'.repeat(64) });
  write(U.admin, 'esign.send', { id: c, signers: [{ name: 'A', email: 'a@x.example', token_hash: sha(tc) }] });
  // 반복 기록(열람 등)이 500줄을 채워도 증빙 기록(취소)은 남는다
  sql(`insert into office_esign_events(esign_id,actor,action) select ${quote(c)},'x','opened' from generate_series(1,600)`);
  write(U.admin, 'esign.update', { id: c, title: '이름 바꿈' });
  write(U.admin, 'esign.cancel', { id: c });
  assert.equal(sql(`select string_agg(action||':'||n, ',' order by action) from (select action, count(*) n from office_esign_events where esign_id=${quote(c)} and action in ('renamed','cancelled') group by action) q`), 'cancelled:1', '이름 바꿈은 상한에 걸리고 취소는 남는다');
  assert.match(svcFail('office_esign_public_state', quote(sha(tc))), /docs_invalid/);
});

test('MEDIUM 1 문서 저장소: 키는 서버가 정하고(PDF·20MB만), 문서 크기는 서버가 확인한 크기, 같은 문서를 PDF와 함께 다시 저장해도 겹치지 않는다(검수 7: 옛 판은 지우지 않고 그 문서의 판으로 남는다)', { skip }, () => {
  const id = randomUUID();
  const r1 = call(U.outsider, 'office_docs_write', `null,'doc.reserve',${j({ id, size: 100 })}`).path;
  assert.match(r1, new RegExp(`^u-${U.outsider}/docs/${id}/[0-9a-f-]{36}\\.pdf$`));
  assert.equal(JSON.parse(last(sql(as(U.outsider, `select r2_object_pending_mine(${quote(r1)})`)))).mime, 'application/pdf', '형식은 PDF로 고정 — 서명에 들어간다');
  assert.match(fails(U.outsider, 'office_docs_write', `null,'doc.reserve',${j({ id: randomUUID(), size: 20971521 })}`), /file_too_big/, '20MB 상한(버킷 제한이 없으므로 자리에서 막는다)');
  commit(r1, 100);
  const v1 = call(U.outsider, 'office_docs_write', `null,'doc.save',${j({ id, kind: 'quote', title: '내 견적', pdf_path: r1, pdf_size: 1 })}`);
  assert.equal(v1.pdf_size, 100, '문서 크기도 실제 객체 크기');
  const r2 = call(U.outsider, 'office_docs_write', `null,'doc.reserve',${j({ id, size: 120 })}`).path; // 옛 구조에서는 여기서 file_conflict
  assert.notEqual(r2, r1); commit(r2, 120);
  const v2 = call(U.outsider, 'office_docs_write', `null,'doc.save',${j({ id, kind: 'quote', title: '내 견적 2', pdf_path: r2 })}`);
  assert.deepEqual([v2.pdf_path, v2.pdf_size], [r2, 120]);
  assert.equal(row(r1), 'claimed|100|doc|application/pdf', '옛 판은 자동으로 지우지 않는다(계약 증빙 — 삭제는 사람이 할 때만), 용량에는 든다');
  assert.deepEqual(call(U.outsider, 'office_docs_get', `null,'doc',${quote(id)}`).versions.map((v) => [v.key, v.bytes]), [[r1, 100]], '이전 판 목록');
  assert.equal(row(r2), 'claimed|120|doc|application/pdf');
  const keep = call(U.outsider, 'office_docs_write', `null,'doc.save',${j({ id, kind: 'quote', title: 'PDF 없이 고치기' })}`);
  assert.equal(keep.pdf_path, r2, 'PDF 없이 저장하면 판은 그대로');
  assert.deepEqual(call(U.outsider, 'office_docs_write', `null,'doc.delete',${j({ id })}`).keys, [r1, r2].sort(), '사람이 문서를 지우면 모든 판을 함께');
  assert.equal(row(r1).split('|')[0], 'deleting'); assert.equal(row(r2).split('|')[0], 'deleting');
  const e = randomUUID();
  assert.equal(write(U.admin, 'esign.reserve', { id: e, size: 10 }).path, `${SEG}/esign/${e}/orig.pdf`);
  assert.match(writeFail(U.member, 'esign.reserve', { id: randomUUID(), size: 10 }), /business_forbidden/);
});

test('LOW 4·6 서명본 → 문서함: 완료된 서명만 출처 esign, 같은 서명은 한 번만(두 관리자가 동시에 넣어도), 크기는 서명본과 같아야', { skip }, () => {
  const first = fileCopy(U.admin, FINAL_SIZE, { ref_esign: E, source: 'esign' });
  first.out();
  assert.equal(sql(`select source||','||ref_id||','||size from office_files where id=${quote(first.id)}`), `esign,${E},${FINAL_SIZE}`);
  const second = fileCopy(U.owner, FINAL_SIZE, { ref_esign: E, source: 'esign' });
  assert.match(second.fail(), /file_conflict/, '두 번째 관리자는 같은 서명본을 또 넣지 못한다');
  const wrong = fileCopy(U.admin, FINAL_SIZE - 1, { ref_esign: E });
  assert.match(wrong.fail(), /file_input/, '서명본과 크기가 다르면 서명본이 아니다');
  const draft = randomUUID();
  write(U.admin, 'esign.create', { id: draft, title: '초안', orig_path: origPdf(U.admin, draft), doc_hash: 'd'.repeat(64) });
  assert.match(fileCopy(U.admin, 10, { ref_esign: draft }).fail(), /file_input/, '완료 안 된 서명은 서명본이 없다');
  const doc = randomUUID();
  write(U.admin, 'doc.save', { id: doc, kind: 'quote', title: '견적', pdf_path: docPdf(U.admin, doc, 300), pdf_size: 1 });
  const gen = fileCopy(U.admin, 300, { ref_doc: doc, source: 'upload' });
  gen.out();
  assert.equal(sql(`select source from office_files where id=${quote(gen.id)}`), 'generated');
  assert.match(fileCopy(U.member, 300, { ref_doc: randomUUID() }).fail(), /file_input/);
  write(U.admin, 'esign.filed', { id: E });
});

test('서버 정리(문서): 저장이 실패해 기록이 가져가지 않은 PDF·서명 원본은 1시간 뒤 정리 대상, 기록이 가진 객체는 남긴다', { skip }, () => {
  const lost = docPdf(U.admin, randomUUID()), lostE = origPdf(U.admin, randomUUID());
  sql(`update r2_objects set updated_at=now()-interval '2 hours' where key in (${quote(lost)},${quote(lostE)})`);
  const keys = svc('office_storage_sweep', '500').keys;
  assert.ok(keys.includes(lost) && keys.includes(lostE));
  assert.ok(!keys.includes(`${SEG}/esign/${E}/orig.pdf`) && !keys.includes(finalKey(E)), '완료된 서명의 원본·서명본은 남는다');
  assert.ok(!keys.includes(finalKey(E, 'bbbbbbbbbbbb')), '진 쪽 서명본은 등록 전 1시간 뒤에 정리');
  sql(`update r2_objects set updated_at=now()-interval '2 hours' where key in (${quote(finalKey(E))},${quote(finalKey(E, 'bbbbbbbbbbbb'))})`);
  const keys2 = svc('office_storage_sweep', '500').keys;
  assert.ok(keys2.includes(finalKey(E, 'bbbbbbbbbbbb')) && !keys2.includes(finalKey(E)), '1시간 뒤: 진 쪽만 정리, 이긴 쪽은 남는다');
});

test('서명은 막지 않는다: 조직 풀이 한도를 넘어도 서명자의 그림 제출·서명본 저장·완료는 된다(사람의 새 올리기만 막힌다)', { skip }, () => {
  const id = randomUUID(), t = 'F'.repeat(43);
  write(U.admin, 'esign.create', { id, title: '가득 찬 조직', orig_path: origPdf(U.admin, id), doc_hash: 'f'.repeat(64) });
  write(U.admin, 'esign.send', { id, signers: [{ name: 'A', email: 'a@x.example', token_hash: sha(t) }] });
  const big = `${SEG}/files/${randomUUID()}.bin`;
  sql(`insert into r2_objects(bucket,key,seg,bytes,state,ref_kind) values('argo-office',${quote(big)},${quote(SEG)},5368709120,'claimed','file')`);
  assert.match(writeFail(U.admin, 'doc.reserve', { id: randomUUID(), size: 10 }), /file_quota/, '사람이 새로 올리는 것은 막힌다');
  const who = svc('office_esign_public_who', `${quote(sha(t))},'a@x.example'`);
  const img = `${SEG}/esign/${id}/s-${who.signer_id}-0-q.png`;
  serverPut(img, 9, 'uploaded', id, 'image/png');
  assert.equal(svc('office_esign_public_submit', `${quote(sha(t))},'a@x.example',${j([{ page: 0, kind: 'signature', img_path: img }])},'4.4.4.4','ua'`).done, true);
  serverPut(finalKey(id), 30, 'uploaded', id);
  svc('office_esign_public_finalize', `${quote(id)},${quote(finalKey(id))},${quote('a'.repeat(64))}`);
  assert.equal(sql(`select status from office_esign where id=${quote(id)}`), 'completed');
  assert.equal(row(img).split('|')[0], 'claimed');
  sql(`delete from r2_objects where key=${quote(big)}`);
});

test('검수 6: 같은 문서를 PDF와 함께 동시에 저장해도 두 판이 모두 그 문서에 남는다(문서 줄을 먼저 잠근다)', { skip }, async () => {
  const id = randomUUID(), k1 = docPdf(U.admin, id, 11), k2 = docPdf(U.admin, id, 22);
  const { spawn } = await import('node:child_process');
  const run = (delay, key, sleep) => new Promise((ok) => setTimeout(() => {
    const q = `begin; set role authenticated; select set_config('argo.uid',${quote(U.admin)},true); select office_docs_write(${quote(ORG)}::uuid,'doc.save',${j({ id, kind: 'quote', title: 'x', pdf_path: key })}); select pg_sleep(${sleep}); commit;`;
    const p = spawn('psql', [DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q]); let err = ''; p.stderr.on('data', (d) => (err += d)); p.on('close', (code) => ok({ code, err }));
  }, delay));
  const res = await Promise.all([run(0, k1, 1.5), run(400, k2, 0)]);
  assert.ok(res.every((r) => r.code === 0), res.map((r) => r.err).join(' '));
  const d = call(U.admin, 'office_docs_get', `${quote(ORG)},'doc',${quote(id)}`);
  assert.deepEqual([d.pdf_path, ...d.versions.map((v) => v.key)].sort(), [k1, k2].sort(), '진 쪽 PDF도 그 문서의 판으로 남는다(주인 없는 claimed가 생기지 않는다)');
});

test('LOW-B 사용량 표시 = 판정: 문서함 목록의 usage는 판정 함수와 같은 값 — 예전 PDF 판·서명본·서명 그림·처리 중인 자리 포함, 남은 만큼은 받고 1바이트 넘으면 거절', { skip }, () => {
  const s = `u-${U.guest}`; // 다른 테스트와 안 겹치는 내 공간(손님도 자기 공간은 쓴다)
  const usage = () => call(U.guest, 'office_file_list', 'null').usage;
  const u0 = usage();
  assert.deepEqual(Object.keys(u0).sort(), ['quota', 'used']); assert.equal(u0.quota, 1073741824, '한도는 office_storage_limits·office_seat_plan(지금 Free 1GB)');
  const id = randomUUID();
  const k1 = docPdf(U.guest, id, 1000, null); call(U.guest, 'office_docs_write', `null,'doc.save',${j({ id, kind: 'quote', title: 'v1', pdf_path: k1 })}`);
  const k2 = docPdf(U.guest, id, 2000, null); call(U.guest, 'office_docs_write', `null,'doc.save',${j({ id, kind: 'quote', title: 'v2', pdf_path: k2 })}`);
  const e = randomUUID();
  serverPut(`${s}/esign/${e}/final-0123456789ab.pdf`, 300, 'claimed', e); serverPut(`${s}/esign/${e}/s-${randomUUID()}-0-a.png`, 40, 'uploaded', e, 'image/png');
  call(U.guest, 'office_docs_write', `null,'doc.reserve',${j({ id: randomUUID(), size: 5 })}`); // 처리 중인 자리
  assert.equal(usage().used - u0.used, 1000 + 2000 + 300 + 40 + 5, '예전 판(1000)·현재 판·서명본·서명 그림·자리까지');
  assert.equal(usage().used, Number(sql(`select office_storage_taken(${quote(s)})`)), '판정과 같은 함수');
  // 판정 경계: 남은 바이트만큼은 받고 1바이트 넘으면 거절 — 표시값이 판정값과 같다는 행동 증거
  const fill = `${s}/files/${randomUUID()}.bin`;
  sql(`insert into r2_objects(bucket,key,seg,created_by,bytes,state,ref_kind) values('argo-office',${quote(fill)},${quote(s)},${quote(U.guest)},${u0.quota - usage().used - 1000},'claimed','file')`);
  const left = usage().quota - usage().used;
  assert.equal(left, 1000);
  assert.match(fails(U.guest, 'office_file_write', `null,'file.reserve',${j({ id: randomUUID(), filename: 'a.bin', size: left + 1 })}`), /file_quota/);
  call(U.guest, 'office_file_write', `null,'file.reserve',${j({ id: randomUUID(), filename: 'a.bin', size: left })}`);
  assert.equal(usage().used, usage().quota);
  const before = sql(`select string_agg(key||':'||xmin::text,',' order by key) from r2_objects where seg=${quote(s)}`);
  usage(); usage();
  assert.equal(sql(`select string_agg(key||':'||xmin::text,',' order by key) from r2_objects where seg=${quote(s)}`), before, '읽기 쓰기 0');
  assert.equal(sql(`select string_agg(proname||'='||provolatile::text,',' order by proname) from pg_proc where proname in ('office_file_list','office_storage_taken')`), 'office_file_list=s,office_storage_taken=s');
  sql(`delete from r2_objects where seg=${quote(s)}`);
});
