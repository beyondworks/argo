import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 문서함·거래처 파일(유건 10/2, 트랙 B): 조직 파일은 손님을 뺀 멤버만, 내 공간 파일은 본인만. 파일 바이트는 R2(argo-office) — DB에는 객체 목록 r2_objects.
// 올리기 = 자리(file.reserve, 키는 서버가 정함) → 서버가 R2 HEAD로 크기를 보고 r2_object_commit(service_role) → 등록(file.create가 객체를 가져간다).
// 서명 주소는 DB 함수가 허락한 키만(r2_object_pending_mine·r2_object_read_grant — 둘 다 stable, 열기 쓰기 0). 삭제·휴지통 30일은 deleting → 서버가 R2에서 지운 뒤 행 삭제.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-files-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','guest','outsider'].map(k=>[k,randomUUID()]));
let ORG, ORG2, CUST, CUST2;
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const org=o=>o?quote(o)+'::uuid':'null';
const userSql=(u,q)=>`set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last=s=>s.split('\n').filter(Boolean).at(-1);
const j=d=>`${quote(JSON.stringify(d))}::jsonb`;
const arr=a=>`array[${a.map(quote).join(',')}]::text[]`;
const call=(u,q)=>JSON.parse(last(sql(userSql(u,`select ${q}`))));
const fails=(u,q)=>{const r=raw(userSql(u,`select ${q}`)); assert.notEqual(r.status,0,`should fail: ${q}`); return r.stderr;};
const svc=q=>last(sql(`set role service_role; select ${q}`));
const svcFail=q=>{const r=raw(`set role service_role; select ${q}`); assert.notEqual(r.status,0,`should fail: ${q}`); return r.stderr;};
const write=(u,a,d,o=ORG)=>call(u,`office_file_write(${org(o)},${quote(a)},${j(d)})`);
const writeFail=(u,a,d,o=ORG)=>fails(u,`office_file_write(${org(o)},${quote(a)},${j(d)})`);
const list=(u,o=ORG,extra='')=>call(u,`office_file_list(${org(o)}${extra})`);
const seg=o=>o?`o-${o}`:null;
const row=k=>{const r=sql(`select state||'|'||bytes||'|'||coalesce(created_by::text,'')||'|'||coalesce(ref_kind,'')||'|'||mime from r2_objects where key=${quote(k)}`); if(!r)return null; const [state,bytes,by,ref,mime]=r.split('|'); return {state,bytes:Number(bytes),by,ref,mime};};
const grantRows=(u,keys)=>JSON.parse(last(sql(userSql(u,`select r2_object_read_grant(${arr(keys)})`))));
const grant=(u,keys)=>grantRows(u,keys).map(x=>x.key);
const pending=(u,k)=>{const r=last(sql(userSql(u,`select r2_object_pending_mine(${quote(k)})`))); return r?JSON.parse(r):null;};
/** 자리 받기 → 키(서버가 정함) */
const reserve=(u,{o=ORG,id=randomUUID(),filename='a.pdf',size=1234,mime='application/pdf'}={})=>({id,key:write(u,'file.reserve',{id,filename,size,mime},o).key});
/** 서버가 R2 HEAD로 본 크기를 적는다(service_role) */
const commit=(k,size=1234)=>JSON.parse(svc(`r2_object_commit(${quote(k)},${size},'etag')`));
const upload=(u,opt={})=>{const r=reserve(u,opt); commit(r.key,opt.size??1234); return r;};
const newFile=(u,{o=ORG,title='견적서.pdf',...rest}={})=>{
  const {id,key}=upload(u,{o,filename:title});
  write(u,'file.create',{id,title,filename:title,mime:'application/pdf',size:1234,storage_path:key,...rest},o);
  return {id,path:key};
};

before(()=>{
 if(!DB)return;
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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260927144230_office_business.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20261002201700_office_files.sql','20261002201700_office_files.sql']){ // 마지막 파일은 두 번 — 다시 적용해도 깨지지 않는다
  const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);
 }
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Files','files',${quote(U.owner)}) returning id`)));
 ORG2=last(sql(userSql(U.outsider,`insert into msgr_orgs(name,slug,owner_user_id)values('Other','other-files',${quote(U.outsider)}) returning id`)));
 for(const o of [ORG,ORG2])sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(o)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','guest'])sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k)})`);
 CUST=call(U.owner,`office_business_write(${quote(ORG)},${quote(randomUUID())},'customer.save',${j({name:'한빛코퍼레이션',email:'',notes:''})})`).id;
 CUST2=call(U.outsider,`office_business_write(${quote(ORG2)},${quote(randomUUID())},'customer.save',${j({name:'남의 거래처',email:'',notes:''})})`).id;
});


test('올리기: 키는 서버가 정하고(<범위>/files/<id>.<확장자>, 이름 없음), 확인·등록하면 목록에 보이고, 다른 조직·손님에게는 안 보인다', {skip}, ()=>{
 const {id,key}=reserve(U.member,{filename:'한빛 견적서.PDF'});
 assert.equal(key,`${seg(ORG)}/files/${id}.pdf`);
 assert.deepEqual(row(key),{state:'pending',bytes:1234,by:U.member,ref:'',mime:'application/pdf'});
 commit(key);
 write(U.member,'file.create',{id,title:'한빛 견적서.pdf',storage_path:key,category:'quote',customer_id:CUST,tags:['견적서','한빛']});
 assert.equal(row(key).state,'claimed'); assert.equal(row(key).ref,'file');
 const f=list(U.admin).files.find(x=>x.id===id);
 assert.equal(f.category,'quote'); assert.equal(f.customer_id,CUST); assert.equal(f.storage_path,key);
 assert.equal(list(U.admin).manager,true); assert.equal(list(U.member).manager,false);
 assert.match(fails(U.guest,`office_file_list(${org(ORG)})`),/file_forbidden/);
 assert.match(fails(U.outsider,`office_file_list(${org(ORG)})`),/file_forbidden/);
 assert.equal(reserve(U.member,{filename:'noext'}).key.split('/').at(-1).includes('.'),false,'확장자 없는 이름은 키에도 없다');
 assert.match(writeFail(U.guest,'file.reserve',{id:randomUUID(),filename:'a.pdf',size:1}),/file_forbidden/);
 assert.match(writeFail(U.outsider,'file.reserve',{id:randomUUID(),filename:'a.pdf',size:1}),/file_forbidden/);
});

test('서명 판정(pending_mine): 내가 받은 지나지 않은 자리만 — 키·크기·형식은 DB 값, 형식은 type/subtype만', {skip}, ()=>{
 const {key}=reserve(U.member,{size:77,mime:'text/html\r\nx-evil: 1'});
 assert.deepEqual(pending(U.member,key),{key,bytes:77,mime:'application/octet-stream',state:'pending',expired:false},'줄바꿈 섞인 형식은 서명에 넣지 않는다');
 assert.equal(pending(U.admin,key),null,'남의 자리');
 assert.equal(pending(U.member,`${seg(ORG)}/files/${randomUUID()}.pdf`),null,'없는 키');
 sql(`update r2_objects set expires_at=now()-interval '1 second' where key=${quote(key)}`);
 assert.equal(pending(U.member,key).expired,true,'느린 올리기: 지난 자리도 유예 1시간 동안은 확인(commit)할 수 있다 — 새 올리기 주소는 안 준다(서버가 expired를 본다)');
 sql(`update r2_objects set expires_at=now()-interval '61 minutes' where key=${quote(key)}`);
 assert.equal(pending(U.member,key),null,'유예도 지난 자리');
 const b=reserve(U.member,{mime:'IMAGE/PNG'}); assert.equal(pending(U.member,b.key).mime,'image/png');
 commit(b.key); assert.equal(pending(U.member,b.key).state,'uploaded','확인된 뒤에는 uploaded(확인 다시 부르기용)');
});

test('열기 판정(read_grant): 등록된 객체는 그 범위를 읽는 사람만, 등록 전은 올린 사람만, 지우기로 정한 것·자리는 안 준다, 50개 상한', {skip}, ()=>{
 const a=newFile(U.member,{title:'공용.pdf'});
 const mine=newFile(U.member,{o:null,title:'내 것.pdf'});
 const up=upload(U.member); const pend=reserve(U.member);
 assert.deepEqual(grant(U.admin,[a.path,mine.path,up.key,pend.key]),[a.path]);
 assert.deepEqual(grant(U.member,[a.path,mine.path,up.key,pend.key]).sort(),[a.path,mine.path,up.key].sort());
 assert.deepEqual(grant(U.guest,[a.path]),[]); assert.deepEqual(grant(U.outsider,[a.path,mine.path]),[]);
 write(U.member,'file.trash',{ids:[a.id]});
 assert.deepEqual(grant(U.admin,[a.path]),[a.path],'휴지통에서도 미리보기는 된다');
 write(U.admin,'file.purge',{ids:[a.id]});
 assert.deepEqual(grant(U.admin,[a.path]),[],'지우기로 정한 객체는 주지 않는다');
 assert.match(fails(U.member,`r2_object_read_grant(array(select g::text from generate_series(1,51) g))`),/file_input/);
 assert.notEqual(raw(`set role anon; select r2_object_read_grant(array['x'])`).status,0);
});

test('등록 검사: 확인 전(pending)·없는 객체·다른 id 키·내 공간 키를 조직에·남의 거래처·남이 올린 객체는 거절, 같은 요청 다시는 통과', {skip}, ()=>{
 const p=reserve(U.member);
 assert.match(writeFail(U.member,'file.create',{id:p.id,title:'x.pdf',storage_path:p.key}),/file_missing/,'서버 확인(commit) 전');
 const id0=randomUUID();
 assert.match(writeFail(U.member,'file.create',{id:id0,title:'x.pdf',storage_path:`${seg(ORG)}/files/${id0}.pdf`}),/file_missing/);
 const other=upload(U.member);
 assert.match(writeFail(U.member,'file.create',{id:randomUUID(),title:'y.pdf',storage_path:other.key}),/file_input/,'id와 키가 다르다');
 const mine=upload(U.member,{o:null});
 assert.match(writeFail(U.member,'file.create',{id:mine.id,title:'z.pdf',storage_path:mine.key}),/file_input/,'조직 범위로 내 공간 객체 등록');
 const c=upload(U.member);
 assert.match(writeFail(U.member,'file.create',{id:c.id,title:'c.pdf',storage_path:c.key,customer_id:CUST2}),/file_input/);
 const d=upload(U.admin);
 assert.match(writeFail(U.member,'file.create',{id:d.id,title:'d.pdf',storage_path:d.key}),/file_forbidden/,'남이 올린 객체');
 const ok=newFile(U.member,{title:'재시도.pdf'});
 assert.equal(write(U.member,'file.create',{id:ok.id,title:'재시도.pdf',storage_path:ok.path}).id,ok.id);
});

test('확인(commit, service_role만): 크기가 다르면 file_size_mismatch, 다시 불러도 쓰지 않는다, 지난 자리는 file_missing, 실패 정리는 등록 전 행만', {skip}, ()=>{
 const a=reserve(U.member,{size:100});
 assert.match(svcFail(`r2_object_commit(${quote(a.key)},101,'e')`),/file_size_mismatch/);
 commit(a.key,100);
 const x1=sql(`select xmin from r2_objects where key=${quote(a.key)}`);
 assert.equal(commit(a.key,100).state,'uploaded');
 assert.equal(sql(`select xmin from r2_objects where key=${quote(a.key)}`),x1,'두 번째 확인은 쓰지 않는다');
 const slow=reserve(U.member); sql(`update r2_objects set expires_at=now()-interval '10 minutes' where key=${quote(slow.key)}`);
 assert.equal(commit(slow.key).state,'uploaded','검수 4: 자리 만료 뒤 유예 1시간 안에 끝난 느린 PUT은 확인된다');
 const b=reserve(U.member); sql(`update r2_objects set expires_at=now()-interval '61 minutes' where key=${quote(b.key)}`);
 assert.match(svcFail(`r2_object_commit(${quote(b.key)},1234,'e')`),/file_missing/,'유예도 지나면 확인하지 않는다');
 const f=newFile(U.member,{title:'남길것.pdf'});
 assert.equal(svc(`r2_object_fail(${arr([a.key,b.key,f.path])})`),'2','등록된 객체 행은 지우지 않는다');
 assert.equal(row(f.path).state,'claimed');
 for(const q of [`r2_object_commit(${quote(f.path)},1,'e')`,`r2_object_fail(${arr([f.path])})`,`r2_object_forget(${arr([f.path])})`,`r2_object_deleting(${arr([f.path])})`,
   `r2_object_server_put(${quote(`${seg(ORG)}/x`)},${quote(seg(ORG))},1,'a/b','claimed')`,`office_storage_sweep(10)`])
  assert.match(fails(U.owner,q),/permission denied/,q);
});

test('검색: 제목·파일명·추출 본문·태그로 찾는다(와일드카드 글자는 그대로)', {skip}, ()=>{
 const {id}=newFile(U.member,{title:'scan_001.jpg',filename:'scan_001.jpg'});
 write(U.member,'file.ocr',{id,ocr_status:'done',summary:'사업자등록번호 123-45-67890',full_text:'법인명 넥스트필드 사업자등록번호 123-45-67890'});
 assert.ok(list(U.admin,ORG,`,'넥스트필드'`).files.some(x=>x.id===id));
 assert.ok(!list(U.admin,ORG,`,'100%'`).files.some(x=>x.id===id));
 assert.equal(call(U.admin,`office_file_get(${org(ORG)},${quote(id)})`).full_text.includes('넥스트필드'),true);
 assert.equal(list(U.admin,ORG,`,null,false,${quote(CUST)}::uuid`).files.every(x=>x.customer_id===CUST),true);
});

test('OCR 결과는 바뀔 때만 쓴다(같은 값 다시 보내면 행 그대로)', {skip}, ()=>{
 const {id}=newFile(U.member,{title:'ocr.pdf'});
 write(U.member,'file.ocr',{id,ocr_status:'done',summary:'a',full_text:'a'});
 const x1=sql(`select xmin from office_files where id=${quote(id)}`);
 write(U.member,'file.ocr',{id,ocr_status:'done',summary:'a',full_text:'a'});
 assert.equal(sql(`select xmin from office_files where id=${quote(id)}`),x1);
});

test('폴더: 만들기·이름 바꾸기·자기 아래로 옮기기 거절·빈 폴더만 지우기', {skip}, ()=>{
 const a=randomUUID(), b=randomUUID();
 write(U.member,'folder.create',{id:a,name:'계약'});
 write(U.member,'folder.create',{id:b,name:'2026',parent_id:a});
 assert.match(writeFail(U.member,'folder.move',{id:a,parent_id:b}),/file_input/);
 write(U.member,'folder.rename',{id:b,name:'2026년'});
 const {id}=newFile(U.member,{title:'계약서.pdf',folder_id:b});
 assert.match(writeFail(U.member,'folder.delete',{id:b}),/file_folder_not_empty/);
 write(U.member,'file.update',{id,folder_id:null,category:'contract'});
 write(U.member,'folder.delete',{id:b});
 const l=list(U.member);
 assert.deepEqual(l.folders.map(f=>f.name),['계약']);
 assert.equal(l.files.find(x=>x.id===id).category,'contract');
 assert.match(writeFail(U.outsider,'folder.create',{id:randomUUID(),name:'x'},ORG),/file_forbidden/);
});

test('링크(드라이브): https만, 등록 뒤 목록에 링크로 보인다', {skip}, ()=>{
 const id=randomUUID();
 assert.match(writeFail(U.member,'link.create',{id,title:'x',link_url:'javascript:alert(1)'}),/check|violates|file_/);
 write(U.member,'link.create',{id,title:'제안서 (구글 문서)',link_url:'https://docs.google.com/document/d/abc/edit',drive_id:'abc',mime:'application/vnd.google-apps.document'});
 const f=list(U.member).files.find(x=>x.id===id);
 assert.equal(f.kind,'link'); assert.equal(f.source,'drive'); assert.equal(f.storage_path,null);
});

test('표는 직접 못 읽고, 드라이브 토큰은 본인 것만', {skip}, ()=>{
 assert.notEqual(raw(userSql(U.owner,`select * from office_files`)).status,0);
 sql(userSql(U.member,`select office_drive_connect(${quote(U.member)},'Me@Gmail.com','https://www.googleapis.com/auth/drive.readonly','sealed-x')`));
 assert.match(fails(U.owner,`office_drive_connect(${quote(U.member)},'x@y.z','','s')`),/session mismatch/);
 assert.equal(sql(userSql(U.member,`select address from office_drive_accounts`)).split('\n').at(-1),'me@gmail.com');
 assert.equal(sql(userSql(U.owner,`select count(*) from office_drive_accounts`)).split('\n').at(-1),'0');
 assert.notEqual(raw(userSql(U.member,`select * from office_drive_secrets`)).status,0);
 assert.equal(sql(userSql(U.owner,`select count(*) from office_drive_secret()`)).split('\n').at(-1),'0');
 sql(userSql(U.member,`select office_drive_disconnect()`));
 assert.equal(sql(`select count(*) from office_drive_secrets where user_id=${quote(U.member)}`),'0');
});

test('공개 페이지 본문에서 /파일 블록(fileRef)은 빠진다 — 조직 파일 이름이 공개 링크로 새지 않게', {skip}, ()=>{
 const doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'안내'}]},{type:'fileRef',attrs:{id:'x',title:'비밀 계약서.pdf'}}]};
 const out=JSON.parse(sql(`select office_strip(${j(doc)})`));
 assert.deepEqual(out.content.map(n=>n.type),['paragraph']);
});

test('HIGH 1 서버 OCR 한도: 사람마다 시간당 60회, 넘으면 false(행을 다시 쓰지 않는다), 다른 사람은 따로, 하루 지난 기록은 정리', {skip}, ()=>{
 const take=u=>last(sql(userSql(u,'select office_ocr_take()')));
 assert.equal(sql(userSql(U.member,`select count(*) from (select office_ocr_take() t from generate_series(1,60)) s where t`)).split('\n').at(-1),'60');
 const x1=sql(`select xmin from office_ocr_usage where user_id=${quote(U.member)}`);
 assert.equal(take(U.member),'f');
 assert.equal(sql(`select xmin from office_ocr_usage where user_id=${quote(U.member)}`),x1,'한도를 넘은 호출은 쓰지 않는다');
 assert.equal(take(U.admin),'t');
 sql(`insert into office_ocr_usage(user_id,hour,n) values(${quote(U.admin)},date_trunc('hour',now())-interval '2 days',5)`);
 take(U.admin);
 assert.equal(sql(`select count(*) from office_ocr_usage where user_id=${quote(U.admin)}`),'1');
 assert.notEqual(raw(`set role anon; select office_ocr_take()`).status,0);
 assert.notEqual(raw(userSql(U.member,'select * from office_ocr_usage')).status,0);
});

test('휴지통 → 복원 → 영구 삭제: 기록을 지우며 객체를 deleting으로(한 트랜잭션), 멤버는 남의 파일을 영구 삭제 못 한다, R2에서 지운 뒤에만 행이 없어진다', {skip}, ()=>{
 const {id,path}=newFile(U.admin,{title:'지울것.pdf'});
 write(U.member,'file.trash',{ids:[id]});
 assert.ok(!list(U.member).files.some(x=>x.id===id));
 assert.ok(list(U.member,ORG,`,null,true`).files.some(x=>x.id===id));
 write(U.member,'file.restore',{ids:[id]});
 write(U.member,'file.trash',{ids:[id]});
 assert.deepEqual(write(U.member,'file.purge',{ids:[id]}),{ids:[],keys:[]},'멤버는 남의 파일 영구 삭제 불가');
 assert.equal(row(path).state,'claimed');
 assert.deepEqual(write(U.admin,'file.purge',{ids:[id]}),{ids:[id],keys:[path]});
 assert.equal(sql(`select count(*) from office_files where id=${quote(id)}`),'0');
 assert.equal(row(path).state,'deleting','R2 삭제 전까지 행은 남는다(못 지우면 크론이 다시)');
 assert.equal(svc(`array_to_json(r2_object_deleting(${arr([path,'nope'])}))`),JSON.stringify([path]),'flush는 deleting 키만');
 assert.equal(svc(`r2_object_forget(${arr([path])})`),'1');
 assert.equal(svc(`r2_object_forget(${arr([path])})`),'0','이중 삭제는 0건');
 assert.equal(row(path),null);
});

test('서버 정리(service_role): 휴지통 30일 기록 삭제+deleting, 지난 자리·1시간 넘은 등록 전 객체·deleting 목록, 새 것·등록된 것은 남긴다, 할 일 없으면 쓰기 0', {skip}, ()=>{
 const old=newFile(U.member,{title:'오래된.pdf'});
 write(U.member,'file.trash',{ids:[old.id]});
 sql(`update office_files set deleted_at=now()-interval '31 days' where id=${quote(old.id)}`);
 const recent=newFile(U.member,{title:'최근휴지통.pdf'}); write(U.member,'file.trash',{ids:[recent.id]});
 const live=newFile(U.member,{title:'산것.pdf'});
 const expired=reserve(U.member); sql(`update r2_objects set expires_at=now()-interval '2 hours' where key=${quote(expired.key)}`);
 const slow=reserve(U.member); sql(`update r2_objects set expires_at=now()-interval '1 minute' where key=${quote(slow.key)}`); // 느린 올리기(PUT이 아직 끝나지 않았을 수 있다)
 const fresh=reserve(U.member);
 const stale=upload(U.member); sql(`update r2_objects set updated_at=now()-interval '2 hours' where key=${quote(stale.key)}`);
 const newUp=upload(U.member);
 sql(`insert into office_ocr_usage(user_id,hour,n) values(${quote(U.admin)},now()-interval '3 days',1)`);
 const keys=JSON.parse(svc(`office_storage_sweep(500)`)).keys;
 for(const k of [old.path,expired.key,stale.key]) assert.ok(keys.includes(k),`정리 대상: ${k}`);
 for(const k of [recent.path,live.path,fresh.key,newUp.key,slow.key]) assert.ok(!keys.includes(k),`남길 것: ${k}`);
 assert.equal(sql(`select count(*) from office_files where id=${quote(old.id)}`),'0','휴지통 30일 기록은 지운다(유건 승인 보존 기간)');
 assert.equal(sql(`select count(*) from office_files where id=${quote(recent.id)}`),'1');
 assert.equal(sql(`select count(*) from office_ocr_usage where hour < now()-interval '1 day'`),'0');
 svc(`r2_object_forget(${arr(keys)})`);
 const snap=()=>sql(`select string_agg(key||':'||xmin::text,',' order by key) from r2_objects`)+'|'+sql(`select string_agg(id||':'||xmin::text,',' order by id) from office_files`);
 const before=snap();
 assert.deepEqual(JSON.parse(svc(`office_storage_sweep(500)`)).keys,[]);
 assert.equal(snap(),before,'할 일이 없으면 정리도 아무 행을 바꾸지 않는다');
});

test('쓰기 0(총괄 결정 6): 목록·한 건·열기 판정·자리 판정을 여러 번 불러도 어떤 행도 바뀌지 않는다, 두 판정 함수는 stable', {skip}, ()=>{
 const f=newFile(U.member,{title:'열기.pdf'}); const p=reserve(U.member);
 const snap=()=>sql(`select string_agg(key||':'||xmin::text,',' order by key) from r2_objects`)+'|'+sql(`select string_agg(id||':'||xmin::text,',' order by id) from office_files`)+'|'+sql(`select count(*) from office_ocr_usage`);
 const before=snap();
 for(let i=0;i<3;i++){ list(U.member); call(U.member,`office_file_get(${org(ORG)},${quote(f.id)})`); grant(U.member,[f.path]); grant(U.admin,[f.path,p.key]); pending(U.member,p.key); }
 assert.equal(snap(),before);
 assert.equal(sql(`select string_agg(proname||'='||provolatile,',' order by proname) from pg_proc where proname in ('r2_object_read_grant','r2_object_pending_mine','r2_object_deleting')`),
  'r2_object_deleting=s,r2_object_pending_mine=s,r2_object_read_grant=s','stable 함수는 쓰기 문장을 실행하지 못한다(측정을 몰래 켜면 오류로 드러난다)');
 assert.equal(sql(`select count(*) from pg_class where relname='office_storage_usage'`),'0','다운로드 측정 표는 만들지 않았다(설계 주석만)');
 const lim=JSON.parse(sql(`select office_storage_limits()`));
 assert.deepEqual(Object.entries(lim).filter(([k])=>/^(daily|platform)_/.test(k)).map(([,v])=>v),[null,null,null,null,null,null],'하루 상한·플랫폼 예산은 미정(null)');
});

test('MEDIUM 1 올리기 자리: 같은 키 남의 자리는 file_conflict, 같은 요청 다시는 그대로, 사람당 열린 자리 50개 상한, 표는 직접 못 읽는다', {skip}, ()=>{
 const id=randomUUID();
 const a=write(U.member,'file.reserve',{id,filename:'a.pdf',size:5});
 assert.deepEqual(write(U.member,'file.reserve',{id,filename:'a.pdf',size:5}),a,'같은 요청 다시');
 assert.match(writeFail(U.admin,'file.reserve',{id,filename:'a.pdf',size:5}),/file_conflict/);
 assert.match(writeFail(U.member,'file.reserve',{id,filename:'a.pdf',size:6}),/file_conflict/,'크기가 다른 같은 키');
 assert.match(writeFail(U.member,'file.reserve',{id:randomUUID(),filename:'a.pdf',size:26214401}),/file_too_big/,'Free 파일 하나 25MB 상한');
 write(U.member,'file.reserve',{id:randomUUID(),filename:'a.pdf',size:26214400});
 const u=U.admin;
 sql(`delete from r2_objects where created_by=${quote(u)} and state='pending'`);
 sql(userSql(u,`do $x$ begin for i in 1..50 loop perform office_file_write(null,'file.reserve',jsonb_build_object('id',gen_random_uuid(),'filename','a.pdf','size',1)); end loop; end $x$;`));
 assert.match(writeFail(u,'file.reserve',{id:randomUUID(),filename:'a.pdf',size:1},null),/file_limit/);
 sql(`delete from r2_objects where created_by=${quote(u)} and state='pending'`);
 assert.notEqual(raw(userSql(U.member,`select * from r2_objects`)).status,0,'객체 목록은 직접 못 읽는다');
});

test('MEDIUM 1 용량: 범위(문서함+문서·서명 객체) 올라온 합 + 열린 자리 + 이번 크기가 상한(내 공간 1GiB)을 넘으면 거절, deleting은 빠진다, 등록 때 다시 센다', {skip}, ()=>{
 const u=U.owner, s=`u-${u}`, big=`${s}/docs/${randomUUID()}/${randomUUID()}.pdf`;
 svc(`r2_object_server_put(${quote(big)},${quote(s)},1073740000,'application/pdf','claimed','doc',${quote(randomUUID())})`);
 assert.match(writeFail(u,'file.reserve',{id:randomUUID(),filename:'a.pdf',size:5000},null),/file_quota/,'서버가 쓴 객체도 같은 범위 합에 든다');
 sql(`update r2_objects set state='deleting' where key=${quote(big)}`);
 const r=reserve(u,{o:null,size:5000}); commit(r.key,5000);
 sql(`update r2_objects set state='claimed' where key=${quote(big)}`); // 자리를 받은 뒤 범위가 찼다
 assert.match(writeFail(u,'file.create',{id:r.id,title:'a.pdf',storage_path:r.key},null),/file_quota/);
 svc(`r2_object_server_put(${quote(`${s}/esign/${randomUUID()}/final.pdf`)},${quote(s)},5,'application/pdf','claimed','esign',${quote(randomUUID())})`); // 가득 차도 서버 쓰기는 막지 않는다(총괄 결정 5)
 sql(`delete from r2_objects where seg=${quote(s)}`);
 const b=upload(u,{o:null,size:10}); sql(`update r2_objects set bytes=52428801 where key=${quote(b.key)}`);
 assert.match(writeFail(u,'file.create',{id:b.id,title:'b.pdf',storage_path:b.key},null),/file_input/,'50MB를 넘는 객체는 등록하지 않는다');
});

test('LOW 6 크기·출처는 서버가 정한다: 크기는 서버가 확인한 크기, esign·generated는 클라이언트가 붙일 수 없다', {skip}, ()=>{
 const r=reserve(U.member,{size:777}); commit(r.key,777);
 write(U.member,'file.create',{id:r.id,title:'real.pdf',storage_path:r.key,size:1,source:'esign'});
 assert.equal(sql(`select size||','||source from office_files where id=${quote(r.id)}`),'777,upload');
 const g=newFile(U.member,{title:'g.pdf',source:'generated'});
 assert.equal(sql(`select source from office_files where id=${quote(g.id)}`),'upload');
 const a=newFile(U.member,{title:'a.pdf',source:'agent'});
 assert.equal(sql(`select source from office_files where id=${quote(a.id)}`),'agent','크루가 올린 것은 agent');
});

test('플랜 숫자(총괄 결정 10/2): office_storage_limits 한 곳 — Free 풀 1GB·파일 25MB, Pro 좌석당 30GB·파일 50MB, Enterprise 좌석당 50GB, 판정 자리는 지금 모두 Free', {skip}, ()=>{
 const L=p=>JSON.parse(sql(`select office_storage_limits(${quote(p)})`));
 assert.deepEqual([L('free').pool_bytes,L('free').file_max_bytes],[1073741824,26214400]);
 assert.deepEqual([L('pro').seat_bytes,L('pro').file_max_bytes,L('pro').pool_bytes],[32212254720,52428800,null]);
 assert.deepEqual([L('enterprise').seat_bytes,L('enterprise').file_max_bytes],[53687091200,52428800]);
 assert.equal(L('모름').plan,'free');
 for(const g of [seg(ORG),`u-${U.member}`]){
  assert.deepEqual(JSON.parse(sql(`select office_seat_plan(${quote(g)})`)),{plan:'free',seats:1},'결제(Paddle) 연결 전에는 Free');
  assert.equal(sql(`select office_storage_quota(${quote(g)})`),'1073741824'); assert.equal(sql(`select office_storage_file_max(${quote(g)})`),'26214400');
 }
 assert.notEqual(raw(userSql(U.member,`select office_seat_plan(${quote(seg(ORG))})`)).status,0,'판정 함수는 내부용');
});

test('기존 초과분은 막지 않고 새로 올릴 때만 막는다: 한도를 넘은 조직도 보기·열기·휴지통·되살리기·영구 삭제는 그대로, 자리 받기만 file_quota', {skip}, ()=>{
 const keep=newFile(U.member,{title:'예전 파일.pdf'});
 const legacy=`${seg(ORG)}/files/${randomUUID()}.bin`;
 sql(`insert into r2_objects(bucket,key,seg,created_by,bytes,mime,state,ref_kind) values('argo-office',${quote(legacy)},${quote(seg(ORG))},${quote(U.admin)},5368709120,'application/octet-stream','claimed','file')`); // 옛 상한(10GiB) 때 쌓인 5GiB
 assert.ok(Number(sql(`select office_storage_used(${quote(seg(ORG))})`))>Number(sql(`select office_storage_quota(${quote(seg(ORG))})`)),'한도(Free 1GB)를 넘은 상태');
 assert.ok(list(U.member).files.some(x=>x.id===keep.id));
 assert.deepEqual(grant(U.member,[keep.path]),[keep.path],'열기 그대로');
 write(U.member,'file.trash',{ids:[keep.id]}); write(U.member,'file.restore',{ids:[keep.id]});
 write(U.member,'file.update',{id:keep.id,title:'예전 파일(이름 바꿈).pdf'});
 assert.equal(row(legacy).state,'claimed','넘친 데이터를 지우지 않는다');
 assert.match(writeFail(U.member,'file.reserve',{id:randomUUID(),filename:'a.pdf',size:1}),/file_quota/,'새로 올리기만 막는다');
 write(U.member,'file.trash',{ids:[keep.id]});
 assert.deepEqual(write(U.member,'file.purge',{ids:[keep.id]}).keys,[keep.path],'정리(영구 삭제)도 그대로');
 sql(`delete from r2_objects where key=${quote(legacy)}`);
});

test('귀속: 조직 공간 파일은 조직 풀 — 올린 직원이 나가도 조직 풀에 남고 그 사람 계정에는 안 잡힌다, 개인 공간·조직 밖 첨부는 올린 사람 계정', {skip}, ()=>{
 const who=randomUUID(); sql(`insert into auth.users(id,email) values(${quote(who)},'leaver@example.test')`);
 sql(`insert into msgr_org_members(org_id,user_id,role) values(${quote(ORG)},${quote(who)},'member')`);
 const used=g=>Number(sql(`select office_storage_used(${quote(g)})`));
 const org0=used(seg(ORG)), me0=used(`u-${who}`);
 const r=reserve(who,{size:7000}); commit(r.key,7000); write(who,'file.create',{id:r.id,title:'떠날 사람.pdf',storage_path:r.key});
 const p=reserve(who,{o:null,size:300}); commit(p.key,300);
 sql(`insert into r2_objects(bucket,key,seg,created_by,bytes,state) values('argo-msgr',${quote(`c-${randomUUID()}/a.png`)},${quote(`c-${randomUUID()}`)},${quote(who)},40,'claimed')`); // 메신저 개인 대화 첨부(조직 밖)
 assert.equal(used(seg(ORG))-org0,7000); assert.equal(used(`u-${who}`)-me0,340,'개인 공간 300 + 개인 대화 첨부 40, 조직 파일은 빠진다');
 sql(`update msgr_org_members set removed_at=now() where org_id=${quote(ORG)} and user_id=${quote(who)}`);
 assert.equal(used(seg(ORG))-org0,7000,'직원이 나가도 조직 풀에 남는다');
 assert.ok(list(U.admin).files.some(x=>x.id===r.id),'조직 파일도 그대로 보인다');
 assert.deepEqual(grant(U.admin,[r.key]),[r.key]);
});

test('검수 2: 기록이 가진 객체(claimed)는 오래돼도 정리 대상이 아니다 — 문서함 파일·문서 PDF·서명 원본·서명본·서명 그림', {skip}, ()=>{
 const f=newFile(U.member,{title:'오래 둔 파일.pdf'});
 const s=seg(ORG), e=randomUUID(), d=randomUUID();
 const others=[`${s}/docs/${d}/${randomUUID()}.pdf`,`${s}/esign/${e}/orig.pdf`,`${s}/esign/${e}/final-abcdef012345.pdf`,`${s}/esign/${e}/s-${randomUUID()}-0-abc.png`];
 for(const k of others) svc(`r2_object_server_put(${quote(k)},${quote(s)},10,'application/pdf','claimed',${k.includes('/docs/')?"'doc'":"'esign'"},${quote(k.includes('/docs/')?d:e)})`);
 const all=[f.path,...others];
 sql(`update r2_objects set updated_at=now()-interval '3 hours', created_at=now()-interval '3 hours' where key in (${all.map(quote).join(',')})`);
 const keys=JSON.parse(svc(`office_storage_sweep(1000)`)).keys;
 for(const k of all) assert.ok(!keys.includes(k),`claimed는 남긴다: ${k.split('/').slice(1,3).join('/')}`);
 assert.ok(all.every(k=>row(k).state==='claimed'));
});

test('검수 1: 서버 쓰기는 이미 기록이 가진(claimed) 행을 되돌리지 않는다 — 겹친 마무리가 서명본을 pending으로 바꿔 정리되게 하지 않는다', {skip}, ()=>{
 const s=seg(ORG), e=randomUUID(), k=`${s}/esign/${e}/final-0123456789ab.pdf`;
 svc(`r2_object_server_put(${quote(k)},${quote(s)},100,'application/pdf','claimed','esign',${quote(e)})`);
 assert.match(svcFail(`r2_object_server_put(${quote(k)},${quote(s)},200,'application/pdf','pending')`),/file_conflict/);
 assert.equal(row(k).state,'claimed'); assert.equal(row(k).bytes,100); assert.equal(row(k).ref,'esign');
});

test('검수 3: 자리 받기는 풀마다 줄을 세운다 — 남은 30MB 조직 풀에 20MB 두 자리를 동시에 받으면 하나만 된다', {skip}, async()=>{
 const s=seg(ORG2), filler=`${s}/files/${randomUUID()}.bin`;
 const room=30*1048576, quota=Number(sql(`select office_storage_quota(${quote(s)})`)), used=Number(sql(`select office_storage_used(${quote(s)})+office_storage_open(${quote(s)})`));
 sql(`insert into r2_objects(bucket,key,seg,bytes,state,ref_kind) values('argo-office',${quote(filler)},${quote(s)},${quota-used-room},'claimed','file')`);
 const { spawn } = await import('node:child_process');
 const run=(delay,sleep)=>new Promise(ok=>setTimeout(()=>{
  const id=randomUUID();
  const q=`begin; set role authenticated; select set_config('argo.uid',${quote(U.outsider)},true); select office_file_write(${quote(ORG2)}::uuid,'file.reserve',${j({id,filename:'a.bin',size:20*1048576,mime:'application/octet-stream'})}); select pg_sleep(${sleep}); commit;`;
  const p=spawn('psql',[DB,'-X','-q','-v','ON_ERROR_STOP=1','-c',q]); let err=''; p.stderr.on('data',d=>err+=d); p.on('close',code=>ok({code,err}));
 },delay));
 const [a,b]=await Promise.all([run(0,1.5),run(400,0)]);
 const okN=[a,b].filter(r=>r.code===0).length;
 assert.equal(okN,1,`하나만 성공해야 한다: ${[a,b].map(r=>r.code===0?'ok':(/file_\w+/.exec(r.err)?.[0]??'err')).join(',')}`);
 assert.match([a,b].find(r=>r.code!==0).err,/file_quota/);
 sql(`delete from r2_objects where seg=${quote(s)}`);
});

test('검수 9: 열기 판정은 형식도 준다(서버가 미리보기 대상이 아닌 형식은 내려받기로 서명한다)', {skip}, ()=>{
 const f=newFile(U.member,{title:'공용2.pdf'});
 assert.deepEqual(grantRows(U.member,[f.path]),[{key:f.path,mime:'application/pdf'}]);
});
