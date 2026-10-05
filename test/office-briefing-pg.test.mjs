import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 브리핑(유건 10/5): 받는 사람의 내 공간에 모인다 — 조직 단위로 모두 보면 큰 조직에서 양이 감당 안 된다. 조직 업무는 개인 브리핑을 보고 한다.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-briefing-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','member2','guest','outsider','gone'].map(k=>[k,randomUUID()]));
let ORG, ORG2;
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const userSql=(u,q)=>`set timezone to 'UTC'; set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last=s=>s.split('\n').filter(Boolean).at(-1);
const call=(u,fn,args)=>JSON.parse(last(sql(userSql(u,`select ${fn}(${args})`))));
const callFail=(u,fn,args)=>{const r=raw(userSql(u,`select ${fn}(${args})`)); assert.notEqual(r.status,0,`${fn} should fail`); return r.stderr;};
const j=d=>`${quote(JSON.stringify(d))}::jsonb`;
const org=o=>o?quote(o):'null';
const write=(u,o,d)=>call(u,'office_briefing_write',`${org(o)},'briefing.create',${j({id:randomUUID(),title:'t',body:'b',...d})}`);
const writeFail=(u,o,d)=>callFail(u,'office_briefing_write',`${org(o)},'briefing.create',${j({id:randomUUID(),title:'t',...d})}`);
const del=(u,id)=>call(u,'office_briefing_write',`null,'briefing.delete',${j({id})}`);
const delFail=(u,id)=>callFail(u,'office_briefing_write',`null,'briefing.delete',${j({id})}`);
const list=(u,a='')=>call(u,'office_briefing_list',a||'null');
const ids=(u,a)=>list(u,a).map(b=>b.id);
const get=(u,id)=>call(u,'office_briefing_get',quote(id));
const imp=(u,d,o=ORG)=>call(u,'office_briefing_import',`${quote(o)},${j({id:randomUUID(),title:'옛 브리핑',body:'본문',kind:'daily',period:'2026-09-01',author_name:'pepper',recipient:U.owner,created_at:'2026-09-01T03:00:00Z',source:{kind:'intranet',id:'1'},...d})}`);

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
 const files=['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260909003000_msgr_message_meta.sql','20260927144230_office_business.sql','20260927170000_office_pages.sql','20260927171000_office_mail.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20260929190000_office_perf.sql','20261007100000_office_briefings.sql'];
 for(const f of files){const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);}
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Co','co',${quote(U.owner)}) returning id`)));
 ORG2=last(sql(userSql(U.outsider,`insert into msgr_orgs(name,slug,owner_user_id)values('Other','other',${quote(U.outsider)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role,display_name)values(${quote(ORG)},${quote(U[k])},${quote(k==='member2'||k==='gone'?'member':k)},${quote(k)})`);
 sql(`update msgr_org_members set removed_at=now() where user_id=${quote(U.gone)}`);
});

test('기본 받는 사람은 쓴 사람 본인이고, 다른 구성원·관리자에게는 보이지 않는다', {skip}, ()=>{
 // 유건: 남에게 온 브리핑은 관리자도 못 본다
 const b=write(U.member,ORG,{title:'멤버 아침 브리핑',author_kind:'agent',author_name:'페퍼'});
 assert.equal(b.org_wide,false); assert.equal(b.org_name,'Co'); assert.equal(b.author_name,'페퍼');
 assert.ok(ids(U.member).includes(b.id));
 for(const k of ['member2','admin','owner','outsider'])assert.ok(!ids(U[k]).includes(b.id),`${k}에게 보이면 안 된다`);
 assert.match(callFail(U.admin,'office_briefing_get',quote(b.id)),/briefing_missing/);
 assert.equal(get(U.member,b.id).body,'b');
});

test('남에게·조직 전체로는 관리자만 보낼 수 있고, 조직 전체 글은 구성원 모두(손님·나간 사람 제외)에게 보인다', {skip}, ()=>{
 // 유건: 조직 전체 글이 마구 쌓이지 않게 관리자 요청일 때만
 assert.match(writeFail(U.member,ORG,{recipient:U.member2}),/briefing_forbidden/);
 assert.match(writeFail(U.member,ORG,{recipient:'org'}),/briefing_forbidden/);
 assert.match(writeFail(U.admin,ORG,{recipient:U.outsider}),/briefing_recipient/);
 const to=write(U.admin,ORG,{recipient:U.member2,title:'관리자가 보낸 것'});
 assert.ok(ids(U.member2).includes(to.id)); assert.ok(!ids(U.admin).includes(to.id));
 const all=write(U.owner,ORG,{recipient:'org',title:'조직 주간 현황',kind:'weekly'});
 assert.equal(all.org_wide,true);
 for(const k of ['owner','admin','member','member2'])assert.ok(ids(U[k]).includes(all.id),`${k}에게 보여야 한다`);
 for(const k of ['guest','gone','outsider'])assert.ok(!ids(U[k]).includes(all.id),`${k}에게 보이면 안 된다`);
});

test('손님·나간 사람·밖의 사람은 그 조직 이름으로 쓸 수 없다', {skip}, ()=>{
 for(const k of ['guest','gone','outsider'])assert.match(writeFail(U[k],ORG,{}),/briefing_forbidden/);
});

test('지우기는 받는 사람 본인만, 조직 전체 글은 관리자만', {skip}, ()=>{
 const mine=write(U.member,ORG,{});
 assert.match(delFail(U.admin,mine.id),/briefing_missing/);
 del(U.member,mine.id); assert.ok(!ids(U.member).includes(mine.id));
 const all=write(U.admin,ORG,{recipient:'org'});
 assert.match(delFail(U.member,all.id),/briefing_forbidden/);
 del(U.owner,all.id); assert.ok(!ids(U.member).includes(all.id));
});

test('조직을 나가면 그 조직에서 받은 글도 더는 안 보인다(개인 공간 글은 남는다)', {skip}, ()=>{
 const g=randomUUID();
 sql(`insert into auth.users(id,email)values(${quote(g)},'leaver@example.test')`);
 sql(`insert into msgr_org_members(org_id,user_id,role,display_name)values(${quote(ORG)},${quote(g)},'member','leaver')`);
 const fromOrg=write(g,ORG,{}); const personal=write(g,null,{});
 sql(`update msgr_org_members set removed_at=now() where user_id=${quote(g)}`);
 assert.deepEqual(ids(g).filter(id=>[fromOrg.id,personal.id].includes(id)),[personal.id]);
 assert.match(writeFail(g,null,{recipient:U.owner}),/briefing_forbidden/); // 개인 공간 글은 본인에게만
});

test('같은 id를 다시 보내면 한 건, 본문 32KB 넘으면 거절, 받는 사람당 하루 50건', {skip}, ()=>{
 // DB 위생: 쓰기 폭주가 표를 채우지 않게
 const id=randomUUID();
 const a=call(U.member2,'office_briefing_write',`${quote(ORG)},'briefing.create',${j({id,title:'x'})}`);
 const b=call(U.member2,'office_briefing_write',`${quote(ORG)},'briefing.create',${j({id,title:'x'})}`);
 assert.equal(a.id,b.id); assert.equal(ids(U.member2).filter(x=>x===id).length,1);
 assert.match(writeFail(U.member2,ORG,{body:'가'.repeat(32769)}),/briefing_input/);
 assert.match(writeFail(U.member2,ORG,{title:'가'.repeat(301)}),/briefing_input/); // 제목은 300자까지(인트라넷 최장 300자를 자르지 않고)
 assert.equal(write(U.member2,ORG,{title:'가'.repeat(300)}).title.length,300);
 const n=Number(last(sql(`select count(*) from office_briefings where recipient=${quote(U.member2)} and created_at>now()-interval '1 day'`)));
 sql(`insert into office_briefings(id,org_id,recipient,title,created_by) select gen_random_uuid(),${quote(ORG)},${quote(U.member2)},'채움',${quote(U.member2)} from generate_series(1,${50-n})`);
 assert.match(writeFail(U.member2,ORG,{}),/briefing_limit/);
});

test('목록은 최신순·커서로 끊어 읽고, 제목·본문으로 찾는다', {skip}, ()=>{
 const u=U.admin;
 const made=[...Array(5)].map((_,i)=>write(u,ORG,{title:`페이지 ${i}`,body:i===3?'특별한 단어 Needle':'보통'}));
 const first=list(u,`null,null,null,2`); assert.equal(first.length,2);
 const lastOne=first.at(-1);
 const next=list(u,`${quote(lastOne.created_at)},${quote(lastOne.id)},null,2`);
 assert.equal(next.length,2); assert.ok(!next.some(x=>first.some(y=>y.id===x.id)));
 assert.deepEqual(list(u,`null,null,'needle'`).map(b=>b.id),[made[3].id]);
 assert.equal(list(u,`null,null,null,1,false`)[0].body,undefined);
 assert.equal(typeof list(u,`null,null,null,1,true`)[0].body,'string');
});

test('이관: 관리자만, 원본 시각·작성자 유지, 같은 원본은 한 번만, 받는 사람은 구성원', {skip}, ()=>{
 assert.match(callFail(U.member,'office_briefing_import',`${quote(ORG)},${j({id:randomUUID(),title:'x',recipient:U.member,created_at:'2026-09-01T00:00:00Z',source:{kind:'intranet',id:'z'}})}`),/briefing_forbidden/);
 const a=imp(U.owner,{source:{kind:'intranet',id:'b-1'}});
 const again=imp(U.owner,{source:{kind:'intranet',id:'b-1'}});
 assert.equal(a.id,again.id);
 assert.equal(a.created_at.slice(0,19),'2026-09-01T03:00:00'); assert.equal(a.author_name,'pepper'); assert.equal(a.author_kind,'agent');
 assert.ok(ids(U.owner).includes(a.id)); assert.ok(!ids(U.admin).includes(a.id));
 assert.throws(()=>imp(U.owner,{recipient:U.outsider,source:{kind:'intranet',id:'b-2'}}),/briefing_recipient/);
});
