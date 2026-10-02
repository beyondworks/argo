import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 문서함·거래처 파일(유건 10/2, 트랙 B): 조직 파일은 손님을 뺀 멤버만, 내 공간 파일은 본인만. 올린 Storage 객체가 그 범위·그 id 자리에 있어야 등록된다.
// 휴지통 30일 뒤 정리 — Storage 객체가 남아 있으면 행을 지우지 않는다(파일을 잃지 않게). 드라이브 토큰은 본인 것만.
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
const call=(u,q)=>JSON.parse(last(sql(userSql(u,`select ${q}`))));
const fails=(u,q)=>{const r=raw(userSql(u,`select ${q}`)); assert.notEqual(r.status,0,`should fail: ${q}`); return r.stderr;};
const write=(u,a,d,o=ORG)=>call(u,`office_file_write(${org(o)},${quote(a)},${j(d)})`);
const writeFail=(u,a,d,o=ORG)=>fails(u,`office_file_write(${org(o)},${quote(a)},${j(d)})`);
const list=(u,o=ORG,extra='')=>call(u,`office_file_list(${org(o)}${extra})`);
const seg=o=>o?`o-${o}`:null;
// 올리기 = 자리 받기(file.reserve) → 사용자 권한으로 Storage에 넣기(정책이 자리를 본다). metadata.size = 실제 크기(Supabase Storage가 채우는 값)
const scopeOf=name=>{const s=name.split('/')[0]; return s.startsWith('o-')?s.slice(2):null;};
const reserve=(u,name,size=1234)=>write(u,'file.reserve',{id:name.split('/')[1],storage_path:name,size},scopeOf(name));
const put=(u,name,size=1234)=>sql(userSql(u,`insert into storage.objects(bucket_id,name,owner,metadata) values('office-files',${quote(name)},${quote(u)},${j({size})})`));
const putFails=(u,name)=>assert.notEqual(raw(userSql(u,`insert into storage.objects(bucket_id,name,owner) values('office-files',${quote(name)},${quote(u)})`)).status,0,`insert should fail: ${name}`);
const upload=(u,name,size=1234)=>{reserve(u,name,size); put(u,name,size);};
const newFile=(u,{o=ORG,title='견적서.pdf',...rest}={})=>{
  const id=randomUUID(), path=`${o?seg(o):`u-${u}`}/${id}/${title}`;
  upload(u,path);
  write(u,'file.create',{id,title,filename:title,mime:'application/pdf',size:1234,storage_path:path,...rest},o);
  return {id,path};
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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260927144230_office_business.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20261002100000_office_files.sql','20261002100000_office_files.sql']){ // 마지막 파일은 두 번 — 다시 적용해도 깨지지 않는다
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

test('올리기: 멤버가 올린 객체를 등록하면 목록에 보이고, 다른 조직·손님에게는 안 보인다', {skip}, ()=>{
 const {id}=newFile(U.member,{title:'한빛 견적서.pdf',category:'quote',customer_id:CUST,tags:['견적서','한빛']});
 const l=list(U.admin);
 const f=l.files.find(x=>x.id===id);
 assert.equal(f.category,'quote'); assert.equal(f.customer_id,CUST); assert.deepEqual(f.tags.sort(),['견적서','한빛'].sort());
 assert.equal(l.manager,true); assert.equal(list(U.member).manager,false);
 assert.match(fails(U.guest,`office_file_list(${org(ORG)})`),/file_forbidden/);
 assert.match(fails(U.outsider,`office_file_list(${org(ORG)})`),/file_forbidden/);
 assert.equal(list(U.outsider,ORG2).files.length,0);
});

test('Storage 정책: 손님·남은 조직 경로에 못 올리고, 남의 조직 객체를 못 읽는다', {skip}, ()=>{
 const id=randomUUID();
 assert.notEqual(raw(userSql(U.guest,`insert into storage.objects(bucket_id,name,owner) values('office-files','${seg(ORG)}/${id}/a.pdf',${quote(U.guest)})`)).status,0);
 assert.notEqual(raw(userSql(U.outsider,`insert into storage.objects(bucket_id,name,owner) values('office-files','${seg(ORG)}/${id}/a.pdf',${quote(U.outsider)})`)).status,0);
 assert.notEqual(raw(userSql(U.member,`insert into storage.objects(bucket_id,name,owner) values('office-files','u-${U.owner}/${id}/a.pdf',${quote(U.member)})`)).status,0); // 남의 내 공간
 newFile(U.member,{title:'비밀.pdf'});
 assert.equal(sql(userSql(U.outsider,`select count(*) from storage.objects where bucket_id='office-files' and name like '${seg(ORG)}/%'`)).split('\n').at(-1),'0');
 assert.notEqual(sql(userSql(U.member,`select count(*) from storage.objects where bucket_id='office-files' and name like '${seg(ORG)}/%'`)).split('\n').at(-1),'0');
});

test('등록 검사: 객체가 없거나, 다른 범위·다른 id 자리이거나, 남의 거래처면 거절', {skip}, ()=>{
 const id=randomUUID();
 assert.match(writeFail(U.member,'file.create',{id,title:'x.pdf',storage_path:`${seg(ORG)}/${id}/x.pdf`}),/file_missing/);
 const other=randomUUID(); upload(U.member,`${seg(ORG)}/${other}/y.pdf`);
 assert.match(writeFail(U.member,'file.create',{id,title:'y.pdf',storage_path:`${seg(ORG)}/${other}/y.pdf`}),/file_input/); // id 자리가 다르다
 const mine=randomUUID(); upload(U.member,`u-${U.member}/${mine}/z.pdf`);
 assert.match(writeFail(U.member,'file.create',{id:mine,title:'z.pdf',storage_path:`u-${U.member}/${mine}/z.pdf`}),/file_input/); // 조직 범위로 내 공간 객체 등록
 const id3=randomUUID(); upload(U.member,`${seg(ORG)}/${id3}/c.pdf`);
 assert.match(writeFail(U.member,'file.create',{id:id3,title:'c.pdf',storage_path:`${seg(ORG)}/${id3}/c.pdf`,customer_id:CUST2}),/file_input/); // 남의 조직 거래처
 const id4=randomUUID(); upload(U.admin,`${seg(ORG)}/${id4}/d.pdf`);
 assert.match(writeFail(U.member,'file.create',{id:id4,title:'d.pdf',storage_path:`${seg(ORG)}/${id4}/d.pdf`}),/file_forbidden/); // 남이 올린 객체
 // 같은 요청 다시 보내기는 그대로 통과(재시도)
 const ok=newFile(U.member,{title:'재시도.pdf'});
 assert.equal(write(U.member,'file.create',{id:ok.id,title:'재시도.pdf',storage_path:ok.path}).id,ok.id);
});

test('내 공간: 본인만 읽고 쓴다', {skip}, ()=>{
 const {id}=newFile(U.member,{o:null,title:'영수증.png'});
 assert.ok(list(U.member,null).files.some(x=>x.id===id));
 assert.ok(!list(U.owner,null).files.some(x=>x.id===id));
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

test('휴지통 → 복원 → 영구 삭제: 객체가 남아 있으면 행을 지우지 않고, 멤버는 남의 파일을 영구 삭제 못 한다', {skip}, ()=>{
 const {id,path}=newFile(U.admin,{title:'지울것.pdf'});
 write(U.member,'file.trash',{ids:[id]});
 assert.ok(!list(U.member).files.some(x=>x.id===id));
 assert.ok(list(U.member,ORG,`,null,true`).files.some(x=>x.id===id));
 write(U.member,'file.restore',{ids:[id]});
 assert.ok(list(U.member).files.some(x=>x.id===id));
 write(U.member,'file.trash',{ids:[id]});
 assert.deepEqual(write(U.admin,'file.purge',{ids:[id]}).ids,[]); // 객체가 아직 있다
 assert.notEqual(raw(userSql(U.member,`delete from storage.objects where bucket_id='office-files' and name=${quote(path)} returning 1`)).stdout.trim().split('\n').at(-1),'1'); // 남이 올린 객체는 멤버가 못 지운다
 sql(userSql(U.admin,`delete from storage.objects where bucket_id='office-files' and name=${quote(path)}`));
 assert.deepEqual(write(U.member,'file.purge',{ids:[id]}).ids,[]); // 멤버는 남의 파일 영구 삭제 불가
 assert.deepEqual(write(U.admin,'file.purge',{ids:[id]}).ids,[id]);
 assert.equal(sql(`select count(*) from office_files where id=${quote(id)}`),'0');
});

test('정리 대상: 30일 지난 휴지통 파일과 하루 지난 행 없는 객체(관리자에게만)', {skip}, ()=>{
 const {id,path}=newFile(U.member,{title:'오래된.pdf'});
 write(U.member,'file.trash',{ids:[id]});
 sql(`update office_files set deleted_at=now()-interval '31 days' where id=${quote(id)}`);
 const orphan=`${seg(ORG)}/${randomUUID()}/orphan.pdf`; upload(U.member,orphan);
 sql(`update storage.objects set created_at=now()-interval '2 days' where name=${quote(orphan)}`);
 assert.ok(!call(U.admin,`office_file_expired(${org(ORG)})`).orphans.includes(orphan),'열린 올리기 자리가 있는 동안은 정리 대상이 아니다');
 sql(`update office_storage_slots set expires_at=now()-interval '1 minute' where path=${quote(orphan)}`);
 const ex=call(U.admin,`office_file_expired(${org(ORG)})`);
 assert.ok(ex.files.some(x=>x.id===id&&x.path===path));
 assert.ok(ex.orphans.includes(orphan));
 const exm=call(U.member,`office_file_expired(${org(ORG)})`);
 assert.ok(exm.files.some(x=>x.id===id)); // 올린 사람은 자기 것
 assert.deepEqual(exm.orphans,[]);
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

test('MEDIUM 1 올리기 자리: 자리 없이는 내 범위에도 못 올리고, 남의 자리·지난 자리로도 못 올린다, 등록하면 자리는 없어진다', {skip}, ()=>{
 const p=`${seg(ORG)}/${randomUUID()}/a.pdf`;
 putFails(U.member,p); // 경로만 맞는다고 올릴 수 없다
 reserve(U.admin,p); putFails(U.member,p); // 남의 자리
 const p2=`${seg(ORG)}/${randomUUID()}/b.pdf`; reserve(U.member,p2);
 sql(`update office_storage_slots set expires_at=now()-interval '1 second' where path=${quote(p2)}`); putFails(U.member,p2); // 지난 자리
 const p3=`u-${U.member}/${randomUUID()}/c.pdf`; putFails(U.member,p3); // 내 공간도 같다
 reserve(U.member,p3); put(U.member,p3);
 assert.match(writeFail(U.member,'file.reserve',{id:randomUUID(),storage_path:`${seg(ORG)}/${randomUUID()}/x.pdf`,size:1}),/file_input/); // id 자리가 다르다
 assert.match(writeFail(U.guest,'file.reserve',{id:randomUUID(),storage_path:`${seg(ORG)}/${randomUUID()}/x.pdf`,size:1}),/file_forbidden/);
 const id=p3.split('/')[1];
 write(U.member,'file.create',{id,title:'c.pdf',storage_path:p3,size:1},null);
 assert.equal(sql(`select count(*) from office_storage_slots where path=${quote(p3)}`),'0');
 assert.notEqual(raw(userSql(U.member,`select * from office_storage_slots`)).status,0,'자리 표는 직접 못 읽는다');
});

test('MEDIUM 1 사람당 열린 자리 50개 상한(행 없는 객체가 무한히 쌓이지 않게)', {skip}, ()=>{
 const u=U.admin;
 sql(`delete from office_storage_slots where created_by=${quote(u)}`); // 앞 테스트가 남긴 열린 자리
 sql(userSql(u,`do $x$ begin for i in 1..50 loop perform office_file_write(null,'file.reserve',jsonb_build_object('id',g,'storage_path','u-'||${quote(u)}||'/'||g||'/a.pdf','size',1)) from (select gen_random_uuid() g) s; end loop; end $x$;`));
 const id=randomUUID();
 assert.match(writeFail(u,'file.reserve',{id,storage_path:`u-${u}/${id}/a.pdf`,size:1},null),/file_limit/);
 sql(`delete from office_storage_slots where created_by=${quote(u)}`);
});

test('MEDIUM 1 용량: 범위(두 버킷) 실제 객체 크기 합 + 열린 자리 + 이번 크기가 상한(내 공간 1GiB)을 넘으면 거절', {skip}, ()=>{
 const u=U.owner, big=`u-${u}/${randomUUID()}/big.bin`, id=randomUUID(), path=`u-${u}/${id}/a.pdf`;
 sql(`insert into storage.objects(bucket_id,name,owner,metadata) values('office-files',${quote(big)},${quote(u)},'{"size":1073740000}')`);
 assert.match(writeFail(u,'file.reserve',{id,storage_path:path,size:5000},null),/file_quota/);
 sql(`delete from storage.objects where name=${quote(big)}`);
 sql(`insert into storage.objects(bucket_id,name,owner,metadata) values('office-docs',${quote(`u-${u}/docs/${randomUUID()}.pdf`)},${quote(u)},'{"size":1073740000}')`);
 assert.match(writeFail(u,'file.reserve',{id,storage_path:path,size:5000},null),/file_quota/,'문서 버킷도 같은 범위 합에 든다');
 sql(`delete from storage.objects where bucket_id='office-docs' and name like ${quote(`u-${u}/%`)}`);
 write(u,'file.reserve',{id,storage_path:path,size:5000},null);
 // 등록 때는 실제 크기로 다시 센다 — 자리를 받은 뒤 범위가 찼으면(다른 경로로 들어온 객체 포함) 등록을 거절한다
 put(u,path,5000);
 const filler=`u-${u}/docs/${randomUUID()}.pdf`;
 sql(`insert into storage.objects(bucket_id,name,owner,metadata) values('office-docs',${quote(filler)},${quote(u)},'{"size":1073740000}')`);
 assert.match(writeFail(u,'file.create',{id,title:'a.pdf',storage_path:path,size:5000},null),/file_quota/);
 sql(`delete from storage.objects where name in (${quote(path)},${quote(filler)})`);
 // 50MB를 넘는 실제 객체는 등록하지 않는다(버킷 상한과 같은 값)
 const id2=randomUUID(), p2=`u-${u}/${id2}/b.pdf`; reserve(u,p2,10); put(u,p2,52428801);
 assert.match(writeFail(u,'file.create',{id:id2,title:'b.pdf',storage_path:p2,size:10},null),/file_input/);
});

test('LOW 6 크기·출처는 서버가 정한다: 크기는 실제 객체 크기, esign·generated는 클라이언트가 붙일 수 없다', {skip}, ()=>{
 const id=randomUUID(), p=`${seg(ORG)}/${id}/real.pdf`;
 reserve(U.member,p,10); put(U.member,p,777);
 write(U.member,'file.create',{id,title:'real.pdf',storage_path:p,size:1,source:'esign'});
 assert.equal(sql(`select size||','||source from office_files where id=${quote(id)}`),'777,upload');
 const g=newFile(U.member,{title:'g.pdf',source:'generated'});
 assert.equal(sql(`select source from office_files where id=${quote(g.id)}`),'upload');
 const a=newFile(U.member,{title:'a.pdf',source:'agent'});
 assert.equal(sql(`select source from office_files where id=${quote(a.id)}`),'agent','크루가 올린 것은 agent');
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
