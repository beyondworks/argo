import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 4단계(유건 9/29): 노하우(스킬)·업무 세트(하네스)가 일을 할수록 쌓여 개인과 회사의 자산이 된다.
// 개인 노하우는 사람에게 속하고(퇴사해도 본인 것), 관리자가 승인하면 회사 노하우로 사본이 올라간다. 고칠 때마다 버전이 남고 사용 횟수를 센다.
// 같은 종류 일 3번 → 후보(AI 없음): 끝낸 할 일 제목에서 거래처 이름·날짜·숫자·문장부호를 빼고 같은 것.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-assets-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','member2','guest','outsider'].map(k=>[k,randomUUID()]));
let ORG, ORG2;
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const org=o=>o?quote(o):'null';
const userSql=(u,q)=>`set timezone to 'UTC'; set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last=s=>s.split('\n').filter(Boolean).at(-1);
const j=d=>`${quote(JSON.stringify(d))}::jsonb`;
const call=(u,fn,args)=>JSON.parse(last(sql(userSql(u,`select ${fn}(${args})`))));
const callFail=(u,fn,args)=>{const r=raw(userSql(u,`select ${fn}(${args})`)); assert.notEqual(r.status,0,`${fn} should fail`); return r.stderr;};
const write=(u,a,d,o=ORG)=>call(u,'office_asset_write',`${org(o)},${quote(a)},${j(d)}`);
const writeFail=(u,a,d,o=ORG)=>callFail(u,'office_asset_write',`${org(o)},${quote(a)},${j(d)}`);
const manage=(u,a,d)=>call(u,'office_asset_manage',`${quote(ORG)},${quote(a)},${j(d)}`);
const manageFail=(u,a,d)=>callFail(u,'office_asset_manage',`${quote(ORG)},${quote(a)},${j(d)}`);
const list=(u,o=ORG)=>call(u,'office_asset_list',`${org(o)}`);
const task=(u,a,d,o=ORG)=>call(u,'office_task_write',`${org(o)},${quote(a)},${j(d)}`);
const bwrite=(a,d)=>call(U.owner,'office_business_write',`${quote(ORG)},${quote(randomUUID())},${quote(a)},${j(d)}`).id;
const done=(u,title,note='')=>{const id=randomUUID(); task(u,'task.create',{id,title,due_on:null,note}); task(u,'task.done',{id}); return id;};

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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260927144230_office_business.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20260929200000_office_assets.sql']){
  const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);
 }
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Assets','assets',${quote(U.owner)}) returning id`)));
 ORG2=last(sql(userSql(U.outsider,`insert into msgr_orgs(name,slug,owner_user_id)values('Other','other',${quote(U.outsider)}) returning id`)));
 for(const o of [ORG,ORG2])sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(o)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest'])sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k==='member2'?'member':k)})`);
 bwrite('customer.save',{name:'한빛상사',email:'',notes:''}); bwrite('customer.save',{name:'대한무역',email:'',notes:''});
});

test('후보: 거래처 이름·날짜·숫자를 뺀 제목이 같은 일을 3번 끝내면 노하우 후보 — 2번은 아니다', {skip}, ()=>{
 done(U.member,'한빛상사 견적서 보내기','단가표 최신본 확인 후 PDF로'); done(U.member,'대한무역 견적서 보내기');
 assert.equal(list(U.member).suggestions.length,0);
 done(U.member,'8월 견적서 보내기 (2차)','부가세 별도 표기');
 const s=list(U.member).suggestions;
 assert.equal(s.length,1); assert.equal(s[0].key,'견적서 보내기'); assert.equal(s[0].count,3);
 assert.deepEqual(s[0].tasks.map(t=>t.note).filter(Boolean).sort(),['단가표 최신본 확인 후 PDF로','부가세 별도 표기']); // 초안 재료 = 그 일들의 제목·메모
 assert.equal(list(U.member2).suggestions.length,0); // 남의 일은 내 후보가 아니다
});

test('후보에서 만들기: 내 노하우(개인 자산)로 — 같은 후보는 다시 뜨지 않고, 숨긴 후보도 안 뜬다', {skip}, ()=>{
 const id=randomUUID();
 write(U.member,'asset.create',{id,kind:'knowhow',scope:'me',title:'견적서 보내는 순서',body:'1. 단가표 확인\n2. 부가세 별도 표기\n3. PDF로 보내기',source_key:'견적서 보내기'});
 const l=list(U.member);
 assert.equal(l.suggestions.length,0);
 assert.deepEqual(l.mine.map(a=>[a.id,a.version,a.uses]),[[id,1,0]]);
 done(U.member,'한빛상사 계약서 보내기'); done(U.member,'대한무역 계약서 보내기'); done(U.member,'9월 계약서 보내기');
 assert.equal(list(U.member).suggestions[0].key,'계약서 보내기');
 write(U.member,'suggest.dismiss',{key:'계약서 보내기'});
 assert.equal(list(U.member).suggestions.length,0);
 assert.equal(list(U.admin).mine.length,0); // 개인 노하우는 본인만
});

test('고치면 버전이 남는다 — 낡은 버전으로 고치면 거절, 남의 개인 노하우는 못 고친다', {skip}, ()=>{
 const id=list(U.member).mine[0].id;
 write(U.member,'asset.update',{id,version:1,title:'견적서 보내는 순서',body:'1. 단가표 확인\n2. 부가세 별도\n3. PDF\n4. 보낸 뒤 할 일 등록',spec:{}});
 assert.equal(list(U.member).mine[0].version,2);
 assert.match(writeFail(U.member,'asset.update',{id,version:1,title:'x',body:'y',spec:{}}),/asset_version/);
 assert.match(writeFail(U.admin,'asset.update',{id,version:2,title:'x',body:'y',spec:{}}),/asset_forbidden|asset_not_found/);
 assert.equal(sql(`select string_agg(version::text,',' order by version) from office_asset_versions where asset_id=${quote(id)}`),'1,2');
 assert.notEqual(raw(userSql(U.member,`update office_assets set title='x'`)).status,0); // 표를 직접 고치는 길은 없다
});

test('회사 노하우로 올리기: 직원이 요청 → 관리자 승인 → 회사 쪽 사본(직원 것은 그대로), 회사 노하우는 조직 사람 모두가 본다', {skip}, ()=>{
 const mine=list(U.member).mine[0];
 const req=randomUUID(); write(U.member,'asset.promote',{id:req,asset_id:mine.id});
 const pending=list(U.admin).promotions;
 assert.equal(pending.length,1); assert.equal(pending[0].title,mine.title); // 관리자는 올리려는 내용만 본다
 assert.match(manageFail(U.member,'promotion.decide',{id:req,approve:true}),/asset_forbidden/);
 manage(U.admin,'promotion.decide',{id:req,approve:true});
 const company=list(U.member2).company;
 assert.equal(company.length,1); assert.equal(company[0].title,mine.title); assert.equal(company[0].promoted_from,mine.id);
 assert.equal(list(U.member).mine[0].id,mine.id); // 개인 것은 남는다
 assert.match(callFail(U.guest,'office_asset_list',`${quote(ORG)}`),/forbidden/);
 assert.match(callFail(U.outsider,'office_asset_list',`${quote(ORG)}`),/forbidden/);
 // 회사 노하우는 관리자만 고치고, 직원은 못 고친다
 assert.match(writeFail(U.member,'asset.update',{id:company[0].id,version:1,title:'x',body:'y',spec:{}}),/asset_forbidden/);
 write(U.admin,'asset.update',{id:company[0].id,version:1,title:company[0].title,body:company[0].body+'\n5. 회사 양식 사용',spec:{}});
});

test('업무 세트: 노하우 여러 개 + 도구 + 끝나기 전 점검 목록 — 볼 수 있는 노하우만 묶고, 쓰면 세트와 노하우 사용 횟수가 오른다', {skip}, ()=>{
 const k=list(U.admin).company[0].id, other=randomUUID();
 write(U.outsider,'asset.create',{id:other,kind:'knowhow',scope:'me',title:'남의 것',body:'x'},null);
 assert.match(writeFail(U.admin,'asset.create',{id:randomUUID(),kind:'set',scope:'org',title:'잘못된 세트',body:'',spec:{knowhow:[other],tools:[],checks:[]}}),/asset_input/);
 const set=randomUUID();
 write(U.admin,'asset.create',{id:set,kind:'set',scope:'org',title:'견적 대응',body:'견적 요청이 오면',spec:{knowhow:[k],tools:['메일','거래 칸반'],checks:['부가세 표기 확인','할 일 등록']}});
 assert.match(writeFail(U.member,'asset.create',{id:randomUUID(),kind:'set',scope:'org',title:'직원이 회사 세트',body:'',spec:{knowhow:[],tools:[],checks:[]}}),/asset_forbidden/);
 const used=write(U.member,'asset.use',{id:set});
 assert.equal(used.knowhow.length,1); assert.equal(used.knowhow[0].id,k); // 맡기는 글에 실을 노하우 본문을 같이 돌려준다
 const l=list(U.member);
 assert.equal(l.company.find(a=>a.id===set).uses,1);
 assert.equal(l.company.find(a=>a.id===k).uses,1);
});

test('보관: 지우지 않고 목록에서만 빠진다, 버전은 남는다', {skip}, ()=>{
 const id=list(U.member).mine[0].id;
 write(U.member,'asset.archive',{id});
 assert.equal(list(U.member).mine.length,0);
 assert.equal(sql(`select count(*) from office_assets where id=${quote(id)}`),'1');
 assert.ok(Number(sql(`select count(*) from office_asset_versions where asset_id=${quote(id)}`))>=2);
});

// 5단계(유건 9/29): 도구함 — 회사가 쓰는 도구(이름·종류·주소·사용법·켜짐·배정 크루)를 등록한다.
// 오피스가 봇에 도구를 설치하지는 못하므로, 크루에게 일을 맡길 때 그 크루에게 배정·켜진 도구의 사용법이 글에 실린다. 업무 세트도 도구를 묶는다.
test('도구: 회사 도구는 관리자가 등록하고, 배정 크루는 같은 조직 크루만, 주소는 http(s)만', {skip}, ()=>{
 const crew=last(sql(`insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name)values(${quote(ORG)},${quote(U.admin)},'ws','ogilvy','오길비') returning id`));
 const alien=last(sql(`insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name)values(${quote(ORG2)},${quote(U.outsider)},'ws','x','남의 크루') returning id`));
 const tool=randomUUID();
 const spec=(extra={})=>({tool_kind:'service',url:'https://app.bolta.io',enabled:true,crews:[crew],...extra});
 assert.match(writeFail(U.member,'asset.create',{id:randomUUID(),kind:'tool',scope:'org',title:'볼타',body:'',spec:spec()}),/asset_forbidden/);
 assert.match(writeFail(U.admin,'asset.create',{id:randomUUID(),kind:'tool',scope:'org',title:'볼타',body:'',spec:spec({crews:[alien]})}),/asset_input/);
 assert.match(writeFail(U.admin,'asset.create',{id:randomUUID(),kind:'tool',scope:'org',title:'볼타',body:'',spec:spec({url:'javascript:alert(1)'})}),/asset_input/);
 write(U.admin,'asset.create',{id:tool,kind:'tool',scope:'org',title:'볼타 세금계산서',body:'발행은 계약 완료 뒤. 테스트 키로 먼저 확인',spec:spec()});
 const t=list(U.member).company.find(a=>a.id===tool);
 assert.equal(t.kind,'tool'); assert.equal(t.spec.url,'https://app.bolta.io'); assert.deepEqual(t.spec.crews,[crew]);
 // 크루에게 맡길 때: 그 크루에게 배정되고 켜진 도구만 사용법과 함께
 const got=write(U.member,'crew.tools',{id:randomUUID(),crew_id:crew});
 assert.deepEqual(got.tools.map(x=>[x.title,x.url,x.guide]),[['볼타 세금계산서','https://app.bolta.io','발행은 계약 완료 뒤. 테스트 키로 먼저 확인']]);
 write(U.admin,'asset.update',{id:tool,version:1,title:'볼타 세금계산서',body:t.body,spec:spec({enabled:false})}); // 끄면 빠지고 버전이 남는다
 assert.equal(write(U.member,'crew.tools',{id:randomUUID(),crew_id:crew}).tools.length,0);
 assert.equal(sql(`select count(*) from office_asset_versions where asset_id=${quote(tool)}`),'2');
 write(U.admin,'asset.update',{id:tool,version:2,title:'볼타 세금계산서',body:t.body,spec:spec()});
 // 업무 세트가 도구를 묶으면 쓸 때 사용법이 같이 온다(꺼진 도구는 빠진다)
 const set=randomUUID();
 write(U.admin,'asset.create',{id:set,kind:'set',scope:'org',title:'세금계산서 발행',body:'',spec:{knowhow:[],tools:[],checks:['공급가액 확인'],tool_ids:[tool]}});
 const used=write(U.member,'asset.use',{id:set});
 assert.deepEqual(used.tool_list.map(x=>x.title),['볼타 세금계산서']);
 assert.ok(list(U.member).company.find(a=>a.id===tool).uses>=2);
});
