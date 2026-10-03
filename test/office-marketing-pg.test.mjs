import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-marketing-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','guest','gone','outsider'].map(k=>[k,randomUUID()]));
let ORG;
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const org=o=>o?quote(o):'null';
const userSql=(u,q)=>`set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last=s=>s.split('\n').filter(Boolean).at(-1);
const read=(u=U.owner,o=null)=>JSON.parse(last(sql(userSql(u,`select office_business_read(${org(o)})`))));
const query=(u,o,a,d,key=randomUUID())=>userSql(u,`select office_business_write(${org(o)},${quote(key)},${quote(a)},${quote(JSON.stringify(d))}::jsonb)`);
const write=(a,d,{u=U.owner,o=null,key=randomUUID()}={})=>JSON.parse(last(sql(query(u,o,a,d,key)))).id;
const fail=(a,d,opts={})=>{const r=raw(query(opts.u||U.owner,opts.o||null,a,d,opts.key));assert.notEqual(r.status,0);return r.stderr;};
const report=(customer,from='2000-01-01',to='2100-01-01',o=null,u=U.owner)=>JSON.parse(last(sql(userSql(u,`select office_business_report(${org(o)},${quote(from)},${quote(to)},${org(customer)})`))));
const customer=(opts={})=>write('customer.save',{name:'Customer',email:'fixture@example.test',notes:''},opts);
const item=(kind,price=100,opts={})=>write('item.save',{name:kind,kind,sku:'',price},opts);
const order=(c,lines,opts={})=>write('order.create',{customer_id:c,title:'Order',lines},opts);
const line=(id,q=1,price=100)=>({item_id:id,quantity:q,unit_price:price});
const entry=(id,kind,amount,opts={})=>write('entry.create',{order_id:id,kind,amount,note:''},opts);

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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260927144230_office_business.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql']){
  if(f==='20260928010000_office_marketing.sql')sql(`insert into office_business_settings(scope,enabled,version) values(${quote('u:'+U.owner)},'["customers"]',3)`);
  const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(r.stderr);
 }
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Business','business',${quote(U.owner)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k==='gone'?'member':k)})`);
 sql(`update msgr_org_members set removed_at=now() where user_id=${quote(U.gone)}`);
});

const mq=(u,o,a,d,key=randomUUID())=>userSql(u,`select office_marketing_write(${org(o)},${quote(key)},${quote(a)},${quote(JSON.stringify(d))}::jsonb)`);
const mw=(a,d,{u=U.owner,o=null,key=randomUUID()}={})=>JSON.parse(last(sql(mq(u,o,a,d,key)))).id;
const mf=(a,d,opts={})=>{const r=raw(mq(opts.u||U.owner,opts.o||null,a,d,opts.key));assert.notEqual(r.status,0);return r.stderr;};
const mr=(u=U.owner,o=null)=>JSON.parse(last(sql(userSql(u,`select office_marketing_read(${org(o)})`))));
const mp=(c=null,from='2026-09-01',to='2026-09-30',o=null,u=U.owner)=>JSON.parse(last(sql(userSql(u,`select office_marketing_report(${org(o)},${quote(from)},${quote(to)},${org(c)})`))));
const campaignData={name:'Campaign',channel:'search',starts_on:'2026-09-01',ends_on:'2026-09-30',budget:100000,status:'active',notes:''};
const campaign=(opts={})=>mw('campaign.save',campaignData,opts);
const daily=(c,patch={},opts={})=>mw('daily.save',{campaign_id:c,date:'2026-09-15',spend:100000,impressions:1000,clicks:100,leads:10,source:'manual',...patch},opts);
const goalData={name:'Sales target',starts_on:'2026-09-01',ends_on:'2026-09-30',metric:'sales',target:2000000};

test('canonical mixed ledger metrics, current attribution, nullable ratios and goal own period', {skip},()=>{
 const camp=campaign(), c=customer(),s=item('service',1000000),p=item('product',100000);
 write('stock.receive',{item_id:p,quantity:10});const o=order(c,[line(s,1,1000000),line(p,2,100000)]);
 write('order.confirm',{id:o});const ln=read().lines.find(x=>x.order_id===o&&x.kind==='product');
 write('line.fulfill',{id:ln.id,quantity:2});entry(o,'invoice',1200000);entry(o,'payment',600000);
 write('line.return',{id:ln.id,quantity:1});entry(o,'credit',100000);entry(o,'refund',100000);
 sql(`update office_business_orders set confirmed_at='2026-09-15' where id=${quote(o)}; update office_business_entries set at='2026-09-15' where order_id=${quote(o)}; update office_business_movements set at='2026-09-15' where order_id=${quote(o)}`);
 daily(camp);mw('attribution.save',{order_id:o,campaign_id:camp,version:0});
 const goal=mw('goal.save',{...goalData,campaign_id:camp});
 const got=mp(camp);
 assert.deepEqual(got.metrics,{spend:100000,impressions:1000,clicks:100,leads:10,orders:1,sales:1100000,paid:500000,roas:11,cpl:10000});
 assert.equal(got.orders[0].receivable,600000);assert.equal(got.orders[0].campaign_id,camp);
 assert.equal(got.goals.find(g=>g.id===goal).actual,1100000);assert.equal(got.goals.find(g=>g.id===goal).ratio,.55);
 const october=mp(camp,'2026-10-01','2026-10-02');assert.equal(october.metrics.sales,0);assert.equal(october.goals[0].actual,1100000);assert.equal(october.metrics.roas,null);assert.equal(october.metrics.cpl,null);
 const other=campaign();mw('attribution.save',{order_id:o,campaign_id:other,version:1});
 assert.equal(mp(camp).metrics.sales,0);assert.equal(mp(other).metrics.sales,1100000);
 mw('attribution.save',{order_id:o,campaign_id:null,version:2});
 assert.equal(mp(other).metrics.sales,0);assert.equal(mp().campaigns.find(c=>c.id===null).sales,1100000);
 assert.equal(mr().attributions.find(a=>a.order_id===o).version,3);assert.equal(mr().history.filter(h=>h.order_id===o).length,3);
 assert.match(mf('attribution.save',{order_id:o,campaign_id:camp,version:0}),/marketing_version_conflict/);
});

test('daily uniqueness, optimistic versions and idempotent receipt payload enforcement', {skip},()=>{
 const camp=campaign(), key=randomUUID(); const data={...campaignData,name:'Replay'};
 const first=mw('campaign.save',data,{key}); assert.equal(mw('campaign.save',data,{key}),first);
 assert.equal(mr().campaigns.filter(c=>c.id===first).length,1);
 assert.match(mf('campaign.save',{...data,name:'different'},{key}),/marketing_idempotency_conflict/);
 const d=daily(camp);assert.match(mf('daily.save',{campaign_id:camp,date:'2026-09-15',spend:1,impressions:1,clicks:1,leads:1}),/marketing_version_conflict/);
 daily(camp,{id:d,version:1,spend:50});assert.equal(mr().daily.find(r=>r.id===d).version,2);
 assert.match(mf('daily.save',{id:d,version:1,campaign_id:camp,date:'2026-09-15',spend:1,impressions:1,clicks:1,leads:1}),/marketing_version_conflict/);
 mw('campaign.save',{...campaignData,id:camp,version:1,status:'archived'});
 assert.equal(mr().campaigns.find(c=>c.id===camp).version,2);
 assert.match(mf('campaign.save',{...campaignData,id:camp,version:1}),/marketing_version_conflict/);
 const g=mw('goal.save',{...goalData,campaign_id:camp});mw('goal.save',{...goalData,id:g,version:1,campaign_id:null,target:500});
 assert.equal(mr().goals.find(x=>x.id===g).version,2);
 assert.equal(mp(camp).metrics.spend,50);
});

test('strict date, source and integer validation rolls back invalid writes', {skip},()=>{
 const c=campaign();
 for(const bad of [-1,.5,'5',null,1000000000001]) assert.match(mf('daily.save',{campaign_id:c,date:'2026-09-12',spend:bad,impressions:1,clicks:1,leads:1}),/business_number/);
 for(const date of ['2026-02-30','2026-9-01','infinity','0001-01-01'])assert.match(mf('daily.save',{campaign_id:c,date,spend:0,impressions:0,clicks:0,leads:0}),/marketing_dates/);
 assert.match(mf('campaign.save',{...campaignData,ends_on:'2026-08-01'}),/marketing_dates/);
 assert.match(mf('daily.save',{campaign_id:c,date:'2026-09-12',spend:0,impressions:0,clicks:0,leads:0,source:'google'}),/marketing_input/);
 assert.match(mf('goal.save',{...goalData,target:0}),/business_number/);
 assert.equal(mr().daily.filter(x=>x.campaign_id===c).length,0);
 assert.throws(()=>mp(c,'2026-09-30','2026-09-01'),/marketing_dates/);
});

test('scope guard protects campaign references, aggregates, direct tables and removed members', {skip},()=>{
 const c=campaign({o:ORG});daily(c,{}, {o:ORG});
 assert.equal(mr(U.member,ORG).can_write,false);assert.equal(mp(c,'2026-09-01','2026-09-30',ORG,U.member).metrics.spend,100000);
 mw('campaign.save',{...campaignData,id:c,version:1},{o:ORG,u:U.admin});
 for(const u of [U.member,U.guest,U.gone,U.outsider])assert.match(mf('campaign.save',campaignData,{o:ORG,u}),/business_forbidden/);
 for(const u of [U.guest,U.gone,U.outsider]){assert.throws(()=>mr(u,ORG),/business_forbidden/);assert.throws(()=>mp(c,'2026-09-01','2026-09-30',ORG,u),/business_forbidden/);}
 assert.match(mf('daily.save',{campaign_id:c,date:'2026-09-20',spend:0,impressions:0,clicks:0,leads:0}),/marketing_not_found/);
 assert.match(mf('goal.save',{...goalData,campaign_id:c}),/marketing_not_found/);
 const pc=customer(),pi=item('service'),po=order(pc,[line(pi)]);
 assert.match(mf('attribution.save',{order_id:po,campaign_id:c,version:0}),/marketing_not_found/);
 assert.match(mf('attribution.save',{order_id:po,campaign_id:c,version:0},{o:ORG}),/marketing_not_found/);
 assert.throws(()=>sql(userSql(U.owner,'select * from office_marketing_campaigns')),/permission denied/);
 assert.throws(()=>sql('set role anon; select office_marketing_read(null)'),/permission denied/);
 assert.throws(()=>sql(userSql(U.owner,"select office_marketing_period(null,'2026-09-01','2026-09-30',null)")),/permission denied/);
 assert.equal(mr(U.outsider).campaigns.length,0);
});

// 거래 흐름 마이그레이션부터 기간 집계는 한국 날짜 기준(분리 검수 9/29) — 경계는 한국 자정
test('previous equal-length period and KST cancellation order-count events', {skip},()=>{
 const camp=campaign(),c=customer(),it=item('service'),o=order(c,[line(it)]);
 write('order.confirm',{id:o});mw('attribution.save',{order_id:o,campaign_id:camp,version:0});write('order.cancel',{id:o});
 sql(`update office_business_orders set confirmed_at='2026-08-31 23:59:59+09',cancelled_at='2026-09-01 00:00:00+09' where id=${quote(o)}`);
 daily(camp,{date:'2026-08-31',spend:20});daily(camp,{date:'2026-09-01',spend:40});
 const r=mp(camp,'2026-09-01','2026-09-01');
 assert.equal(r.metrics.orders,-1);assert.equal(r.metrics.sales,-100);assert.equal(r.metrics.spend,40);
 assert.equal(r.previous.orders,1);assert.equal(r.previous.sales,100);assert.equal(r.previous.spend,20);
});

test('module enablement supports new modules and full campaign rows are never truncated', {skip},()=>{
 // 유건 9/29: 광고 기록이 없는 공간은 마케팅·성과 분석을 끈 채로 시작한다(거래 흐름 마이그레이션이 꺼 둠) — 켜면 그대로 쓴다
 let state=read();assert.deepEqual(state.settings.enabled,['customers']);assert.equal(state.settings.version,5);
 assert.equal(read(U.outsider).settings.enabled.includes('marketing'),false);
 write('settings.save',{...state.settings,enabled:['marketing','performance']});assert.deepEqual(read().settings.enabled,['marketing','performance']);
 sql(userSql(U.outsider,`do $$begin for i in 1..105 loop perform office_marketing_write(null,gen_random_uuid(),'campaign.save',${quote(JSON.stringify(campaignData))}::jsonb);end loop;end$$`));
 assert.equal(mr(U.outsider).campaigns.length,105);assert.equal(mp(null,'2026-09-01','2026-09-30',null,U.outsider).campaigns.length,106);
});

test('concurrent attribution writers cannot overwrite the same expected version', {skip},async()=>{
 const c=customer({o:ORG}),it=item('service',100,{o:ORG}),o=order(c,[line(it)],{o:ORG});
 const ca=campaign({o:ORG}),cb=campaign({o:ORG});
 const run=(u,campaign_id)=>new Promise(resolve=>{
  const probe=psqlSpawn(DB,['--version']);assert.equal(probe.status,0);
  const child=spawn('psql',[DB,'-X','-v','ON_ERROR_STOP=1','-At','-c',mq(u,ORG,'attribution.save',{order_id:o,campaign_id,version:0})],{env:process.env});
  // 'close' — 'exit'는 stderr를 다 읽기 전에 올 수 있다(리눅스 CI에서 빈 문자열, 10/3 #813)
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('close',(code,signal)=>resolve({code,signal,stderr}));
 });
 const replies=await Promise.all([run(U.owner,ca),run(U.admin,cb)]);
 assert.equal(replies.filter(r=>r.code===0).length,1);assert.match(replies.find(r=>r.code!==0).stderr,/marketing_version_conflict/,JSON.stringify(replies));
 const snapshot=mr(U.owner,ORG);assert.equal(snapshot.attributions.find(a=>a.order_id===o).version,1);assert.equal(snapshot.history.filter(h=>h.order_id===o).length,1);
});

test('performance layout persists sizes, order and hiding while legacy writes preserve it', {skip},()=>{
 const performance={items:[{id:'spend',size:'s',hidden:false},{id:'sourceOrders',size:'full',hidden:true}]};
 const initial=read().settings;
 write('settings.save',{...initial,performance});
 assert.deepEqual(read().settings.performance,performance);
 const legacy={...read().settings};delete legacy.performance;
 write('settings.save',legacy);
 const restored=read().settings;assert.deepEqual(restored.performance,performance);assert.deepEqual(restored.enabled,initial.enabled);assert.deepEqual(restored.dashboards,initial.dashboards);
 assert.equal(restored.version,initial.version+2);
 const optional=read(U.admin).settings;assert.deepEqual(optional.performance,{});
 write('settings.save',optional,{u:U.admin});assert.deepEqual(read(U.admin).settings.performance,{});
});

test('performance layout rejects duplicate ids, arbitrary modules and malformed values atomically', {skip},()=>{
 const settings=read().settings, item={id:'spend',size:'m',hidden:false};
 for(const performance of [null,[],{extra:true},{items:null},{items:[item,item]},{items:[{...item,id:'script'}]},{items:[{...item,size:'huge'}]},{items:[{...item,hidden:'false'}]},{items:[{id:'paid',size:'s'}]},{items:[{...item,code:'alert(1)'}]}]) {
  assert.match(fail('settings.save',{...settings,performance}),/business_settings/);
  assert.equal(read().settings.version,settings.version);
 }
 assert.deepEqual(read().settings.performance,settings.performance);
});
