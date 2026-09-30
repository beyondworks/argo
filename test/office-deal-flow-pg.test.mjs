import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-deal-flow-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','guest','gone','outsider'].map(k=>[k,randomUUID()]));
let ORG; const LEGACY={};
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
const mquery=(u,o,a,d,key=randomUUID())=>userSql(u,`select office_marketing_write(${org(o)},${quote(key)},${quote(a)},${quote(JSON.stringify(d))}::jsonb)`);
function mwrite(a,d,{u=U.owner,o=null}={}){return JSON.parse(last(sql(mquery(u,o,a,d)))).id;}
const mread=(u=U.owner,o=null)=>JSON.parse(last(sql(userSql(u,`select office_marketing_read(${org(o)})`))));
const mreport=(from,to,u=U.owner,o=null)=>JSON.parse(last(sql(userSql(u,`select office_marketing_report(${org(o)},${quote(from)},${quote(to)},null)`))));

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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260927144230_office_business.sql','20260928010000_office_marketing.sql']){
  const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(r.stderr);
 }
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Business','business',${quote(U.owner)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k==='gone'?'member':k)})`);
 sql(`update msgr_org_members set removed_at=now() where user_id=${quote(U.gone)}`);
 LEGACY.c=customer(); LEGACY.i=item('service',1000); LEGACY.o=order(LEGACY.c,[line(LEGACY.i,2,1000)]);
 write('order.confirm',{id:LEGACY.o}); entry(LEGACY.o,'invoice',2000); entry(LEGACY.o,'payment',2000);
 // 옛 마케팅 탭에서 캠페인에 연결해 둔 거래·성과 분석만 켜 둔 설정(분리 검수 M5·LOW9) — 거래 흐름 마이그레이션이 경로·탭을 맞춘다
 LEGACY.camp=mwrite('campaign.save',{name:'옛 캠페인',channel:'검색',starts_on:'2026-09-01',ends_on:'2026-09-30',budget:0,status:'active',notes:''});
 mwrite('attribution.save',{order_id:LEGACY.o,campaign_id:LEGACY.camp,version:0});
 write('settings.save',{...read().settings,enabled:['customers','orders','performance']});
 const r=psqlSpawn(DB,['-f',fileURLToPath(new URL('../supabase/migrations/20260929140000_office_deal_flow.sql',import.meta.url))]);if(r.status!==0)throw new Error(r.stderr);
});

const at=(o)=>JSON.parse(last(sql(`select jsonb_build_object('created',(created_at at time zone 'Asia/Seoul')::date,'confirmed',(confirmed_at at time zone 'Asia/Seoul')::date,'cancelled',(cancelled_at at time zone 'Asia/Seoul')::date,'status',status) from office_business_orders where id=${quote(o)}`)));
const deal=(c,i,supply,extra={},opts={})=>write('order.create',{customer_id:c,title:'Deal',lines:[{item_id:i,quantity:1,unit_price:supply,...extra}],...(opts.at?{at:opts.at}:{})});

// 분리 검수 HIGH: 옛 줄에 10%를 채우면 정산이 끝난 거래가 미수금 있음으로 되돌아가고 추가 청구가 열렸다
test('기존 데이터: 부가세 도입 전 거래는 세액 0 그대로 — 입금까지 끝난 거래는 추가 청구가 열리지 않는다', {skip}, ()=>{
 const d=read();
 assert.equal(d.lines.find(l=>l.order_id===LEGACY.o).vat,0);
 const inv=d.entries.find(e=>e.order_id===LEGACY.o&&e.kind==='invoice');
 assert.equal(inv.supply,2000); assert.equal(inv.vat,0);
 assert.match(fail('entry.create',{order_id:LEGACY.o,kind:'invoice',amount:200,note:''}),/business_amount_exceeds_balance/);
 assert.deepEqual(d.activity.filter(a=>a.order_id===LEGACY.o).map(a=>a.kind).sort(),['contract','invoice','payment','quote']);
});

// 유건 9/29: 부가세는 따로 표기 — 나중에 세금 업무를 하기 편하게. 매출은 공급가액, 청구·입금·미수금은 부가세 포함.
test('부가세: 과세는 10% 원 미만 절사, 영세·면세는 0, 직접 준 세액은 그대로, 면세에 세액을 주면 거절', {skip}, ()=>{
 const c=customer(), i=item('service',0);
 const d1=deal(c,i,10000005), d2=deal(c,i,5000,{tax_type:'exempt'}), d3=deal(c,i,5000,{tax_type:'zero'}), d4=deal(c,i,10000000,{vat:999999});
 const lines=read().lines; const v=o=>lines.find(l=>l.order_id===o);
 assert.equal(v(d1).vat,1000000); assert.equal(v(d2).vat,0); assert.equal(v(d2).tax_type,'exempt'); assert.equal(v(d3).vat,0); assert.equal(v(d4).vat,999999);
 assert.match(fail('order.create',{customer_id:c,title:'x',lines:[{item_id:i,quantity:1,unit_price:5000,tax_type:'exempt',vat:500}]}),/business_input/);
 assert.match(fail('order.create',{customer_id:c,title:'x',lines:[{item_id:i,quantity:1,unit_price:5000,tax_type:'vat10'}]}),/business_input/);
 assert.match(fail('order.create',{customer_id:c,title:'x',lines:[{item_id:i,quantity:1,unit_price:5000,vat:999999999}]}),/business_input/,'직접 준 세액이 10%를 크게 넘으면 거절(오타 방지)');
 deal(c,i,5000,{vat:510}); // 10% + 여유 10원까지는 받는다(원본 반올림 차이)
});

test('청구 한도는 부가세 포함 총액이고, 청구 기록에 공급가액·세액이 나뉘어 남는다 · 매출세액은 청구일 기준', {skip}, ()=>{
 const c=customer(), i=item('service',0), o=deal(c,i,10000000,{},{at:'2026-07-01'});
 write('order.confirm',{id:o,at:'2026-07-05'});
 assert.match(fail('entry.create',{order_id:o,kind:'invoice',amount:11000001,note:''}),/business_amount_exceeds_balance/);
 write('entry.create',{order_id:o,kind:'invoice',amount:11000000,note:'',at:'2026-07-10'});
 write('entry.create',{order_id:o,kind:'payment',amount:11000000,note:'',at:'2026-07-20'});
 const inv=read().entries.find(e=>e.order_id===o&&e.kind==='invoice');
 assert.equal(inv.supply,10000000); assert.equal(inv.vat,1000000);
 const m=report(c,'2026-07-01','2026-07-31').metrics;
 assert.deepEqual([m.sales,m.invoiced,m.paid,m.receivable,m.vat],[10000000,11000000,11000000,0,1000000]);
 assert.equal(report(c,'2026-08-01','2026-08-31').metrics.vat,0,'다른 기간에는 세액이 잡히지 않는다');
 // 분리 검수 MEDIUM: 한국 새벽 청구가 UTC로 전날에 잡히면 부가세 신고 기간이 틀어진다
 const o2=deal(c,i,1000,{},{at:'2026-06-01'}); write('order.confirm',{id:o2,at:'2026-06-01'});
 write('entry.create',{order_id:o2,kind:'invoice',amount:1100,note:'',at:'2026-07-01T01:00:00+09:00'});
 assert.equal(report(c,'2026-07-01','2026-07-01').metrics.vat,100,'한국 7/1 새벽 청구는 7/1 집계');
 assert.equal(report(c,'2026-06-30','2026-06-30').metrics.vat,0);
 assert.deepEqual(at(o),{created:'2026-07-01',confirmed:'2026-07-05',cancelled:null,status:'confirmed'});
});

test('단계 날짜: 날짜만 주면 한국 날짜 그대로, 계약일이 견적일보다 앞서거나 20년 밖·미래면 거절', {skip}, ()=>{
 const c=customer(), i=item('service',0), o=deal(c,i,1000,{},{at:'2026-09-10'});
 assert.match(fail('order.confirm',{id:o,at:'2026-09-09'}),/business_dates/);
 assert.match(fail('order.create',{customer_id:c,title:'x',at:'1990-01-01',lines:[{item_id:i,quantity:1,unit_price:1}]}),/business_dates/);
 assert.match(fail('order.create',{customer_id:c,title:'x',at:'2999-01-01',lines:[{item_id:i,quantity:1,unit_price:1}]}),/business_dates/);
 const tomorrow=last(sql(`select ((clock_timestamp() at time zone 'Asia/Seoul')::date+1)::text`)), after=last(sql(`select ((clock_timestamp() at time zone 'Asia/Seoul')::date+2)::text`));
 write('order.create',{customer_id:c,title:'내일 견적',at:tomorrow,lines:[{item_id:i,quantity:1,unit_price:1}]});
 assert.match(fail('order.create',{customer_id:c,title:'x',at:after,lines:[{item_id:i,quantity:1,unit_price:1}]}),/business_dates/);
 assert.match(fail('order.create',{customer_id:c,title:'x',at:'not-a-date',lines:[{item_id:i,quantity:1,unit_price:1}]}),/business_dates/);
 write('order.confirm',{id:o,at:'2026-09-10'}); assert.equal(at(o).confirmed,'2026-09-10');
});

// 실사고(화면 확인, 9/29): 오늘 만든 견적을 오늘 날짜로 계약하면 정오로 기록돼 '견적보다 이른 계약'으로 거절됐다
test('오늘 날짜: 오늘 만든 견적을 오늘 날짜로 계약·청구·입금할 수 있다', {skip}, ()=>{
 const today=last(sql(`select (clock_timestamp() at time zone 'Asia/Seoul')::date`));
 const c=customer(), i=item('service',0), o=deal(c,i,1000);
 write('order.confirm',{id:o,at:today}); write('entry.create',{order_id:o,kind:'invoice',amount:1100,note:'',at:today}); write('entry.create',{order_id:o,kind:'payment',amount:1100,note:'',at:today});
 assert.equal(at(o).confirmed,today);
});

test('되돌리기: 계약 → 견적은 청구 전에만, 기록이 남는다', {skip}, ()=>{
 const c=customer(), i=item('service',0), o=deal(c,i,1000);
 write('order.confirm',{id:o}); write('order.reopen',{id:o});
 assert.equal(at(o).status,'draft'); assert.equal(at(o).confirmed,null);
 write('order.confirm',{id:o}); write('entry.create',{order_id:o,kind:'invoice',amount:100,note:''});
 assert.match(fail('order.reopen',{id:o}),/business_order_state/);
 assert.deepEqual(read().activity.filter(a=>a.order_id===o).map(a=>a.kind),['quote','contract','reopen','contract','invoice']);
});

// 유건 9/29: 취소된 거래는 '취소 거래'에서만 본다 — 청구만 된 거래는 취소하면서 청구를 감액으로 되돌린다. 입금된 거래는 먼저 환불.
test('취소: 입금 전이면 남은 청구를 감액(세액 포함)하고 취소, 입금이 있으면 거절', {skip}, ()=>{
 const c=customer(), i=item('service',0), o=deal(c,i,10000000,{},{at:'2026-09-01'});
 write('order.confirm',{id:o,at:'2026-09-01'}); write('entry.create',{order_id:o,kind:'invoice',amount:11000000,note:'',at:'2026-09-15'});
 assert.match(fail('order.cancel',{id:o,at:'2026-09-14'}),/business_dates/,'청구일보다 앞선 취소는 거절');
 write('order.cancel',{id:o,at:'2026-09-20'});
 const es=read().entries.filter(e=>e.order_id===o);
 assert.deepEqual(es.map(e=>[e.kind,e.amount,e.supply,e.vat]),[['invoice',11000000,10000000,1000000],['credit',11000000,10000000,1000000]]);
 assert.equal(at(o).status,'cancelled'); assert.equal(at(o).cancelled,'2026-09-20');
 const p=deal(c,i,1000); write('order.confirm',{id:p}); write('entry.create',{order_id:p,kind:'invoice',amount:1100,note:''}); write('entry.create',{order_id:p,kind:'payment',amount:1,note:''});
 assert.match(fail('order.cancel',{id:p}),/business_order_state/);
 write('entry.create',{order_id:p,kind:'refund',amount:1,note:''}); write('order.cancel',{id:p});
 assert.equal(at(p).status,'cancelled');
});

// 유건 9/29: 거래처 정보 강화 + 민감 정보는 우클릭으로 부분 가림
test('거래처: 강화된 항목 저장·검사, 가림 표시는 항목 단위로 켜고 끈다', {skip}, ()=>{
 const id=write('customer.save',{name:'비욘드웍스',email:'a@b.test',notes:'',ceo:'김',biz_no:'123-45-67890',manager:'박',phone:'010-0000-0000',address:'서울',account:'국민 000',category:'partner',status:'hold',redacted:['account','biz_no']});
 let c=read().customers.find(x=>x.id===id);
 assert.deepEqual([c.ceo,c.biz_no,c.category,c.status],['김','123-45-67890','partner','hold']);
 assert.deepEqual(c.redacted.sort(),['account','biz_no']);
 write('redact.set',{entity:'customer',id,field:'phone',on:true}); write('redact.set',{entity:'customer',id,field:'account',on:false});
 c=read().customers.find(x=>x.id===id); assert.deepEqual(c.redacted.sort(),['biz_no','phone']);
 assert.match(fail('redact.set',{entity:'customer',id,field:'name',on:true}),/business_input/);
 assert.match(fail('customer.save',{name:'x',email:'',notes:'',biz_no:'12a'}),/business_input/);
 assert.match(fail('customer.save',{name:'x',email:'',notes:'',status:'deleted'}),/business_input/);
 const o=deal(id,item('service',0),1000); write('redact.set',{entity:'order',id:o,field:'amount',on:true});
 assert.deepEqual(read().orders.find(x=>x.id===o).redacted,['amount']);
 assert.match(fail('redact.set',{entity:'customer',id,field:'phone',on:true},{u:U.member,o:ORG}),/business_forbidden|business_not_found/);
});

// 유건 9/29: 단계가 바뀌어도 관련 문서·내용이 카드를 계속 따라간다(칸반)
test('카드 자료: 메모·페이지 연결을 붙이고 떼며, 읽기 결과에 자료와 기록이 함께 온다', {skip}, ()=>{
 const c=customer(), i=item('service',0), o=deal(c,i,1000);
 const note=write('link.add',{order_id:o,kind:'note',body:'견적 협의 메모'});
 write('link.add',{order_id:o,kind:'page',ref:'page-1',title:'견적서'});
 assert.match(fail('link.add',{order_id:o,kind:'note',body:'  '}),/business_input/);
 assert.match(fail('link.add',{order_id:o,kind:'page',ref:''}),/business_input/);
 write('order.confirm',{id:o});
 assert.deepEqual(read().links.filter(l=>l.order_id===o).map(l=>l.kind),['note','page'],'계약으로 넘어가도 자료는 그대로');
 write('link.remove',{id:note});
 assert.deepEqual(read().links.filter(l=>l.order_id===o).map(l=>l.kind),['page']);
});

test('조직 공간: 멤버는 읽기만, 관리자는 쓰기 — 새 동작도 같은 권한', {skip}, ()=>{
 const c=customer({o:ORG,u:U.admin}), i=item('service',0,{o:ORG,u:U.admin});
 const o=write('order.create',{customer_id:c,title:'Org',lines:[line(i,1,1000)]},{o:ORG,u:U.admin});
 assert.match(fail('link.add',{order_id:o,kind:'note',body:'x'},{u:U.member,o:ORG}),/business_forbidden/);
 assert.equal(read(U.member,ORG).orders.length,1);
});

// 유건 9/29: 마케팅을 안 하는 사업도 많다 — 캠페인 없이 "들어온 경로"(소개·기존 고객·직접 문의·검색·SNS·기타)를 고르고, 소개면 누가 소개했는지 남긴다
test('들어온 경로: 캠페인 없이 고르고, 소개면 소개한 거래처·사람을 남기며, 경로별 매출로 모인다', {skip}, ()=>{
 const c=customer(), ref=customer(), i=item('service',0);
 const a=deal(c,i,1000000,{},{at:'2026-05-01'}); write('order.confirm',{id:a,at:'2026-05-02'});
 const b=deal(c,i,3000000,{},{at:'2026-05-01'}); write('order.confirm',{id:b,at:'2026-05-03'});
 const n=deal(c,i,500000,{},{at:'2026-05-01'}); write('order.confirm',{id:n,at:'2026-05-04'});
 write('order.source',{id:a,source:'referral',referrer_customer_id:ref,referrer_name:'한 대표'});
 write('order.source',{id:b,source:'returning'});
 const o=read().orders.find(x=>x.id===a);
 assert.deepEqual([o.source,o.referrer_customer_id,o.referrer_name],['referral',ref,'한 대표']);
 write('order.source',{id:a,source:'inbound',referrer_customer_id:ref,referrer_name:'x'});
 assert.deepEqual((({source,referrer_customer_id,referrer_name})=>[source,referrer_customer_id,referrer_name])(read().orders.find(x=>x.id===a)),['inbound',null,''],'소개가 아니면 소개한 사람은 지운다');
 write('order.source',{id:a,source:'referral',referrer_customer_id:ref});
 assert.match(fail('order.source',{id:a,source:'tv'}),/business_input/);
 assert.match(fail('order.source',{id:a,source:'referral',referrer_customer_id:'00000000-0000-0000-0000-000000000000'}),/business_not_found/);
 const src=Object.fromEntries(report(c,'2026-05-01','2026-05-31').sources.map(r=>[r.source,Number(r.sales)]));
 assert.deepEqual(src,{referral:1000000,returning:3000000,unknown:500000});
 write('order.source',{id:b,source:null});
 assert.equal(read().orders.find(x=>x.id===b).source,null,'경로 지우기(모름)');
});

test('마케팅 기본값: 광고 기록이 없는 공간은 마케팅·성과 분석이 꺼진 채로 시작한다', {skip}, ()=>{
 const s=read(U.guest).settings; // 설정을 저장한 적 없는 사용자의 기본값
 assert.equal(s.enabled.includes('marketing'),false); assert.equal(s.enabled.includes('performance'),false);
 assert.equal(s.enabled.includes('analytics'),true);
});

// 분리 검수 M5·LOW9: 이미 연결된 거래의 경로를 채우고, 성과 분석만 켜 둔 공간은 마케팅을 켠다(성과 분석은 마케팅 탭으로 합침)
test('옛 데이터: 캠페인에 연결된 거래는 경로가 캠페인, 성과 분석만 켜 둔 설정은 마케팅도 켜진다', {skip}, ()=>{
 assert.equal(read().orders.find(x=>x.id===LEGACY.o).source,'campaign');
 assert.equal(read().settings.enabled.includes('marketing'),true);
});

// 분리 검수 M1: 거래 연결은 한 번의 쓰기로 경로와 캠페인 연결을 함께 바꾼다 — 중간 실패로 화면마다 다른 경로가 보이지 않게
test('캠페인 연결·다른 경로: 한 번의 쓰기로 경로와 캠페인 연결이 함께 바뀐다', {skip}, ()=>{
 const c=customer(), ref=customer(), i=item('service',0), camp=mwrite('campaign.save',{name:'네이버',channel:'검색',starts_on:'2026-09-01',ends_on:'2026-09-30',budget:0,status:'active',notes:''});
 const o=deal(c,i,1000,{},{at:'2026-09-02'});
 write('order.source',{id:o,source:'referral',referrer_customer_id:ref,referrer_name:'한 대표'});
 mwrite('attribution.save',{order_id:o,campaign_id:camp,version:0});
 let row=read().orders.find(x=>x.id===o);
 assert.deepEqual([row.source,row.referrer_customer_id,row.referrer_name],['campaign',null,''],'캠페인에 연결하면 경로도 캠페인');
 write('order.source',{id:o,source:'inbound'});
 const att=mread().attributions.find(x=>x.order_id===o);
 assert.equal(att.campaign_id,null,'다른 경로를 고르면 캠페인 연결이 풀린다'); assert.equal(att.version,2);
 mwrite('attribution.save',{order_id:o,campaign_id:camp,version:2});
 mwrite('attribution.save',{order_id:o,campaign_id:null,version:3});
 assert.equal(read().orders.find(x=>x.id===o).source,null,'캠페인 연결을 풀면 경로는 모름');
 write('order.source',{id:o,source:'returning'});
 mwrite('attribution.save',{order_id:o,campaign_id:null,version:4});
 assert.equal(read().orders.find(x=>x.id===o).source,'returning','캠페인이 아닌 경로는 연결 풀기로 지우지 않는다');
});

// 분리 검수 M4: '전체 캠페인' 목표는 광고와 연결된 거래만 센다 — 소개 매출이 광고 목표를 채우지 않게
test('전체 캠페인 목표: 캠페인에 연결된 거래만 실적에 들어간다', {skip}, ()=>{
 const u=U.member, c=customer({u}), i=item('service',0,{u});
 const camp=mwrite('campaign.save',{name:'인스타',channel:'SNS',starts_on:'2026-07-01',ends_on:'2026-07-31',budget:0,status:'active',notes:''},{u});
 const linked=write('order.create',{customer_id:c,title:'광고 거래',at:'2026-07-02',lines:[{item_id:i,quantity:1,unit_price:200}]},{u});
 const other=write('order.create',{customer_id:c,title:'소개 거래',at:'2026-07-02',lines:[{item_id:i,quantity:1,unit_price:5000}]},{u});
 write('order.confirm',{id:linked,at:'2026-07-03'},{u}); write('order.confirm',{id:other,at:'2026-07-03'},{u});
 mwrite('attribution.save',{order_id:linked,campaign_id:camp,version:0},{u});
 mwrite('goal.save',{name:'7월 광고 매출',starts_on:'2026-07-01',ends_on:'2026-07-31',campaign_id:null,metric:'sales',target:1000},{u});
 const goal=mreport('2026-07-01','2026-07-31',u).goals[0];
 assert.equal(Number(goal.actual),200); assert.equal(Number(goal.ratio),0.2);
});

// 표에서 여러 칸을 끌어 고른 뒤 한 번에 가리기(유건 9/29) — 칸마다 요청하지 않고 한 번의 쓰기로, 하나라도 틀리면 하나도 바꾸지 않는다
test('여러 칸 가리기: 한 번의 쓰기로 여러 거래처·항목을 켜고 끄며, 잘못된 칸이 있으면 모두 되돌린다', {skip}, ()=>{
 const u=U.guest, a=write('customer.save',{name:'가',email:'a@example.test',notes:''},{u}), b=write('customer.save',{name:'나',email:'b@example.test',notes:''},{u});
 const items=[{entity:'customer',id:a,field:'phone',on:true},{entity:'customer',id:a,field:'email',on:true},{entity:'customer',id:b,field:'phone',on:true}];
 write('redact.bulk',{items},{u});
 const hidden=()=>Object.fromEntries(read(u).customers.map(c=>[c.name,[...(c.redacted??[])].sort()]));
 assert.deepEqual(hidden(),{가:['email','phone'],나:['phone']});
 write('redact.bulk',{items:[{entity:'customer',id:a,field:'phone',on:false},{entity:'customer',id:b,field:'phone',on:false}]},{u});
 assert.deepEqual(hidden(),{가:['email'],나:[]});
 assert.match(fail('redact.bulk',{items:[{entity:'customer',id:b,field:'email',on:true},{entity:'customer',id:a,field:'name',on:true}]},{u}),/business_input/);
 assert.deepEqual(hidden(),{가:['email'],나:[]},'잘못된 칸이 섞이면 앞의 칸도 바뀌지 않는다');
 assert.match(fail('redact.bulk',{items:Array.from({length:501},()=>items[0])},{u}),/business_input/);
 assert.match(fail('redact.bulk',{items:[{entity:'customer',id:a,field:'phone',on:true}]},{u:U.outsider}),/business_not_found/,'남의 거래처는 가릴 수 없다');
});
