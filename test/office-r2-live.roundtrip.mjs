// 실제 R2 한 바퀴(로컬 PG 드릴 + 개발 버킷 argo-office-dev) — 운영 Supabase·운영 버킷은 쓰지 않는다(R2_OFFICE_DEV_*, 운영 이름이면 거절).
// 키는 무작위 시험 조직(o-<새 uuid>/) 아래만 쓰고 끝에 지운 뒤 LIST로 비었는지 본다.
// 실행: ( set -a; . <레포>/.env.local; set +a; bash scripts/billing-pg-drill.sh test/office-r2-live.roundtrip.mjs )
// 서버 함수(api/storage·server/sweep)의 Supabase 호출은 이 파일의 다리(http://sb → psql, 토큰으로 역할을 정한다)로 로컬 PG에 보낸다. R2 요청은 진짜.
// 출력에는 상태 코드만 — 서명 주소·키 값은 남기지 않는다. 파일 이름이 .test.mjs·pg가 아니라서 npm test·전체 드릴에는 들어가지 않는다.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB=process.env.ARGO_PG_TEST_URL;
if(!DB) throw new Error('ARGO_PG_TEST_URL이 필요하다(드릴)');
const { devR2Env } = await import('../apps/office/scripts/r2-dev-env.mjs');
Object.assign(process.env, devR2Env(process.env)); // 앱 이름(R2_OFFICE_*)을 개발 버킷 값으로 덮는다 — 운영 버킷이면 여기서 거절
const { r2FromEnv } = await import('../apps/office/server/r2.js');
const { POST } = await import('../apps/office/api/storage/[op].js');
const { sweepStorage } = await import('../apps/office/server/sweep.js');
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
const write=(u,a,d,o=ORG)=>call(u,`office_file_write(${org(o)},${quote(a)},${j(d)})`);
const dwrite=(u,a,d)=>call(u,`office_docs_write(${org(ORG)},${quote(a)},${j(d)})`);
const r2=r2FromEnv(process.env);

/** 다리: 서버 함수의 Supabase REST 호출 → 로컬 PG(서비스 키 = service_role, 'jwt-<uuid>' = 그 사람) */
const realFetch=globalThis.fetch;
const lit=v=>v===null||v===undefined?'null':Array.isArray(v)?`array[${v.map(quote).join(',')}]::text[]`:typeof v==='number'?String(v):typeof v==='object'?j(v):quote(v);
globalThis.fetch=async(url,init={})=>{
  const u=String(url);
  if(!u.startsWith('http://sb/')) return realFetch(url,init);
  const tok=/^Bearer (.+)$/.exec(init.headers?.authorization??'')?.[1]??'';
  if(u.includes('/auth/v1/user')) return tok.startsWith('jwt-')?new Response(JSON.stringify({id:tok.slice(4)})):new Response('{}',{status:401});
  const fn=/rpc\/(\w+)/.exec(u)[1], args=JSON.parse(init.body??'{}');
  const callSql=`select coalesce(to_jsonb(${fn}(${Object.entries(args).map(([k,v])=>`${k} => ${lit(v)}`).join(', ')})),'null'::jsonb)`;
  const q=tok==='svc-key'?`set role service_role; ${callSql}`:tok.startsWith('jwt-')?userSql(tok.slice(4),callSql):null;
  if(!q) return new Response('{}',{status:401});
  const r=raw(q);
  if(r.status!==0) return new Response(JSON.stringify({message:(/ERROR:\s+(\S+)/.exec(r.stderr)??[])[1]??'error'}),{status:400});
  return new Response(last(r.stdout.trim())??'null');
};
Object.assign(process.env,{VITE_SUPABASE_URL:'http://sb',VITE_SUPABASE_ANON_KEY:'anon',OFFICE_SUPABASE_SERVICE_KEY:'svc-key'});
const api=async(op,body,u=U.member)=>{const r=await POST(new Request(`http://x/api/storage/${op}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer jwt-${u}`},body:JSON.stringify(body)})); return {status:r.status,body:await r.json()};};
const bytes=(n,f=65)=>new Uint8Array(n).fill(f);
/** 화면과 같은 순서: upload-url → R2 PUT → commit */
const upload=async(key,data,u=U.member)=>{const up=await api('upload-url',{key},u); assert.equal(up.status,200); const put=await realFetch(up.body.url,{method:'PUT',headers:up.body.headers,body:data}); return {put:put.status,commit:await api('commit',{key},u)};};

before(()=>{
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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260927144230_office_business.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20261002201700_office_files.sql','20260927171000_office_mail.sql','20261002201900_office_docs.sql']){ // 마지막 파일은 두 번 — 다시 적용해도 깨지지 않는다
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

after(async()=>{ // 정리 — 시험 조직 접두 아래를 모두 지우고 비었는지
  const left=await r2.list(`o-${ORG}/`); for(const k of left) await r2.del(k);
  const now=await r2.list(`o-${ORG}/`);
  console.log(`# 정리: 남아 있던 객체 ${left.length}개를 지움, 지금 남은 객체 ${now.length}개`);
  assert.equal(now.length,0);
});

test('실제 R2: 올리기 → 확인 → 등록 → 열기(바이트 같음) → 영구 삭제 → flush로 R2에서 지워짐', async()=>{
  const id=randomUUID(), data=bytes(1500);
  const {key}=write(U.member,'file.reserve',{id,filename:'실측.pdf',size:data.length,mime:'application/pdf'});
  assert.ok(key.startsWith(`o-${ORG}/files/`));
  const up=await upload(key,data);
  assert.equal(up.put,200); assert.deepEqual(up.commit,{status:200,body:{key,bytes:1500}});
  write(U.member,'file.create',{id,title:'실측.pdf',storage_path:key});
  const ru=await api('read-url',{keys:[key]},U.admin);
  const got=new Uint8Array(await (await realFetch(ru.body.urls[key])).arrayBuffer());
  assert.equal(got.length,1500); assert.ok(got.every(b=>b===65));
  assert.deepEqual((await api('read-url',{keys:[key]},U.outsider)).body.urls,{},'밖 사람에게는 서명하지 않는다');
  write(U.member,'file.trash',{ids:[id]});
  const p=write(U.admin,'file.purge',{ids:[id]});
  assert.deepEqual(p.keys,[key]);
  assert.deepEqual((await api('flush',{keys:p.keys},U.admin)).body,{deleted:1,left:0});
  assert.equal(await r2.head(key),null,'R2에서 지워졌다');
  assert.equal(sql(`select count(*) from r2_objects where key=${quote(key)}`),'0');
  console.log('# 한 바퀴: PUT 200 · commit 200 · GET 1500바이트 일치 · flush 1개 · HEAD 없음 · 행 없음');
});

test('실제 R2: 자리보다 큰 몸체 PUT은 R2가 403, commit은 file_missing(등록 불가), 정리 크론은 만료 뒤 유예 1시간이 지난 자리만 지운다', async()=>{
  const id=randomUUID();
  const {key}=write(U.member,'file.reserve',{id,filename:'a.pdf',size:10,mime:'application/pdf'});
  const up=await upload(key,bytes(11));
  assert.equal(up.put,403); assert.equal(up.commit.status,409); assert.equal(up.commit.body.error,'file_missing');
  sql(`update r2_objects set expires_at=now()-interval '1 minute' where key=${quote(key)}`);
  assert.equal((await sweepStorage({url:'http://sb',key:'svc-key',r2})).objects,0,'검수 4: 만료 직후(유예 1시간 안)에는 지우지 않는다');
  sql(`update r2_objects set expires_at=now()-interval '2 hours' where key=${quote(key)}`);
  const out=await sweepStorage({url:'http://sb',key:'svc-key',r2});
  assert.ok(out.objects>=1); assert.equal(out.left,0);
  assert.equal(sql(`select count(*) from r2_objects where key=${quote(key)}`),'0');
  console.log(`# 크기 다름: PUT ${up.put} · commit ${up.commit.status} ${up.commit.body.error} · 크론 지움 ${out.objects}`);
});

test('실제 R2: 같은 문서를 PDF와 함께 다시 저장 — 판마다 새 키, 옛 판은 지우지 않고 남는다(검수 7), 사람이 문서를 지우면 모든 판을 flush로 R2에서 지운다', async()=>{
  const id=randomUUID();
  const k1=dwrite(U.admin,'doc.reserve',{id,size:300}).path; assert.equal((await upload(k1,bytes(300),U.admin)).put,200);
  dwrite(U.admin,'doc.save',{id,kind:'quote',title:'v1',pdf_path:k1});
  const k2=dwrite(U.admin,'doc.reserve',{id,size:320}).path; assert.notEqual(k2,k1); assert.equal((await upload(k2,bytes(320),U.admin)).put,200);
  const v2=dwrite(U.admin,'doc.save',{id,kind:'quote',title:'v2',pdf_path:k2});
  assert.deepEqual([v2.pdf_path,v2.pdf_size],[k2,320]);
  await sweepStorage({url:'http://sb',key:'svc-key',r2});
  assert.equal((await r2.head(k1))?.bytes,300,'옛 판은 크론이 지우지 않는다'); assert.equal((await r2.head(k2))?.bytes,320);
  const del=dwrite(U.admin,'doc.delete',{id});
  assert.deepEqual(del.keys,[k1,k2].sort());
  assert.deepEqual((await api('flush',{keys:del.keys},U.admin)).body,{deleted:2,left:0});
  assert.equal(await r2.head(k1),null); assert.equal(await r2.head(k2),null);
  console.log('# 문서 다시 저장: 새 키 · 크론 뒤에도 옛 판 300바이트 유지 · 문서 삭제 flush 2개 · R2에서 없어짐');
});

test('실제 R2: html 파일은 내려받기로 서명된다(검수 9) — 응답 content-disposition: attachment, 바이트는 그대로', async()=>{
  const id=randomUUID(), data=new TextEncoder().encode('<b>hi</b>');
  const {key}=write(U.member,'file.reserve',{id,filename:'a.html',size:data.length,mime:'text/html'});
  assert.equal((await upload(key,data)).put,200);
  write(U.member,'file.create',{id,title:'a.html',storage_path:key});
  const ru=await api('read-url',{keys:[key]});
  const r=await realFetch(ru.body.urls[key]);
  const got=await r.text();
  assert.equal(r.headers.get('content-disposition'),'attachment'); assert.equal(got,'<b>hi</b>');
  write(U.member,'file.trash',{ids:[id]}); const p=write(U.member,'file.purge',{ids:[id]});
  assert.deepEqual((await api('flush',{keys:p.keys})).body,{deleted:1,left:0});
  console.log(`# html: GET ${r.status} · content-disposition ${r.headers.get('content-disposition')} · flush 1개`);
});
