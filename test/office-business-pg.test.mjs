import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-business-pg.test.mjs';
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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260927144230_office_business.sql']){
  const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(r.stderr);
 }
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Business','business',${quote(U.owner)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k==='gone'?'member':k)})`);
 sql(`update msgr_org_members set removed_at=now() where user_id=${quote(U.gone)}`);
});

test('mixed order: reserve, service delivery, shipment, return, credit and refund reconcile', {skip},()=>{
 const c=customer(),s=item('service',1000000),p=item('product',100000);
 write('stock.receive',{item_id:p,quantity:10});
 const o=order(c,[line(s,1,1000000),line(p,2,100000)]);
 write('order.confirm',{id:o});
 let snapshot=read();let product=snapshot.items.find(x=>x.id===p);
 assert.equal(product.stock,10);assert.equal(product.reserved,2);
 const lines=snapshot.lines.filter(x=>x.order_id===o);
 write('line.fulfill',{id:lines.find(x=>x.kind==='service').id,quantity:1});
 write('line.fulfill',{id:lines.find(x=>x.kind==='product').id,quantity:2});
 entry(o,'invoice',1200000);entry(o,'payment',600000);
 write('line.return',{id:lines.find(x=>x.kind==='product').id,quantity:1});
 entry(o,'credit',100000);entry(o,'refund',100000);
 product=read().items.find(x=>x.id===p);assert.equal(product.stock,9);assert.equal(product.reserved,0);
 const r=report(c,'2026-01-01','2027-01-01');
 assert.deepEqual(r.metrics,{sales:1100000,invoiced:1100000,paid:500000,receivable:600000});
 assert.deepEqual(Object.fromEntries(r.mix.map(x=>[x.kind,x.amount])),{product:100000,service:1000000});
 assert.equal(r.orders[0].receivable,600000);
 assert.match(fail('order.cancel',{id:o}),/business_order_state/);
 assert.match(fail('line.return',{id:lines.find(x=>x.kind==='service').id,quantity:1}),/business_quantity/);
 assert.match(fail('line.return',{id:lines.find(x=>x.kind==='product').id,quantity:2}),/business_quantity/);
});

test('service-only flow changes no inventory; product cancellation releases reservation', {skip},()=>{
 const c=customer(),s=item('service'),p=item('product');const svc=order(c,[line(s)]);
 write('order.confirm',{id:svc});const l=read().lines.find(x=>x.order_id===svc);
 write('line.fulfill',{id:l.id,quantity:1});entry(svc,'invoice',100);entry(svc,'payment',40);
 assert.equal(read().movements.filter(x=>x.item_id===s).length,0);
 assert.match(fail('stock.receive',{item_id:s,quantity:1}),/business_product_only/);
 write('stock.receive',{item_id:p,quantity:2});const prod=order(c,[line(p,2)]);
 write('order.confirm',{id:prod});write('order.cancel',{id:prod});
 const got=read().items.find(x=>x.id===p);assert.equal(got.stock,2);assert.equal(got.reserved,0);
 assert.equal(report(c,'2026-01-01','2027-01-01').metrics.sales,100);
 assert.match(fail('entry.create',{order_id:svc,kind:'payment',amount:61}),/business_amount_exceeds_balance/);
 assert.match(fail('entry.create',{order_id:svc,kind:'invoice',amount:1}),/business_amount_exceeds_balance/);
 assert.match(fail('entry.create',{order_id:svc,kind:'refund',amount:41}),/business_amount_exceeds_balance/);
});

test('strict numeric validation, snapshot prices, optimistic versions and complete rollback', {skip},()=>{
 const c=customer(),p=item('product'),s=item('service');
 for(const q of [0,-1,1.5,1000001,'1',null])assert.match(fail('stock.receive',{item_id:p,quantity:q}),/business_number/);
 for(const price of [-1,0.1,1000000000001,'100',null])assert.match(fail('item.save',{name:'bad',kind:'product',price}),/business_number/);
 const before=read().orders.length;
 assert.match(fail('order.create',{customer_id:c,title:'bad',lines:[line(s,2,1000000000000)]}),/business_total_limit/);
 assert.equal(read().orders.length,before);
 write('stock.receive',{item_id:p,quantity:1});
 const o=order(c,[line(p),line(p)]);
 assert.match(fail('order.confirm',{id:o}),/business_insufficient_stock/);
 const snap=read();assert.equal(snap.items.find(x=>x.id===p).reserved,0);assert.equal(snap.movements.filter(x=>x.order_id===o).length,0);
 const id=order(c,[line(s)]);write('item.save',{id:s,version:1,name:'changed',kind:'service',price:500});
 assert.equal(read().lines.find(x=>x.order_id===id).unit_price,100);
 assert.match(fail('item.save',{id:s,version:1,name:'x',kind:'service',price:1}),/business_version_conflict/);
 assert.match(fail('item.save',{id:s,version:2,name:'x',kind:'product',price:1}),/business_kind_in_use/);
});

test('idempotent writes are atomic, actor-scoped and payload-consistent', {skip},()=>{
 const p=item('product',100,{o:ORG}),key=randomUUID(),data={item_id:p,quantity:3};
 const id=write('stock.receive',data,{o:ORG,key});
 assert.equal(write('stock.receive',data,{o:ORG,key}),id);
 assert.equal(read(U.owner,ORG).items.find(x=>x.id===p).stock,3);
 assert.match(fail('stock.receive',{...data,quantity:4},{o:ORG,key}),/business_idempotency_conflict/);
 write('stock.receive',data,{o:ORG,u:U.admin,key});assert.equal(read(U.owner,ORG).items.find(x=>x.id===p).stock,6);
});

test('scope boundaries: members read only, guests/removed/outsiders denied, personal and direct access isolated', {skip},()=>{
 const c=customer({o:ORG});assert.equal(read(U.member,ORG).can_write,false);assert.equal(read(U.admin,ORG).can_write,true);
 assert.match(fail('customer.save',{name:'x'},{o:ORG,u:U.member}),/business_forbidden/);
 for(const k of ['guest','gone','outsider']){
  assert.notEqual(raw(userSql(U[k],`select office_business_read(${quote(ORG)})`)).status,0);
  assert.notEqual(raw(userSql(U[k],`select office_business_report(${quote(ORG)},'2026-01-01','2027-01-01',null)`)).status,0);
 }
 assert.notEqual(raw(`set role anon;select office_business_read(null)`).status,0);
 assert.notEqual(raw(userSql(U.member,'select * from office_business_customers')).status,0);
 assert.notEqual(raw(userSql(U.owner,`insert into office_business_customers(scope,name)values('u:${U.owner}','bypass')`)).status,0);
 const personal=customer();assert.equal(read(U.outsider).customers.some(x=>x.id===personal),false);
 assert.match(fail('customer.save',{id:personal,version:1,name:'take'},{u:U.outsider}),/business_not_found/);
 assert.match(fail('order.create',{customer_id:c,title:'cross',lines:[line(item('service'))]}),/business_not_found/);
 const foreign=item('service',100,{u:U.outsider});assert.match(fail('order.create',{customer_id:personal,title:'cross',lines:[line(foreign)]}),/business_not_found/);
});

const asyncSql=q=>new Promise(resolve=>{
 const child=spawn('psql',[DB,'-X','-q','-v','ON_ERROR_STOP=1','-A','-t','-c',q]);let out='',err='';
 child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('close',status=>resolve({status,out,err}));
});
test('two actors confirming the last unit concurrently cannot oversell', {skip},async()=>{
 const opts={o:ORG},c=customer(opts),p=item('product',100,opts);write('stock.receive',{item_id:p,quantity:1},opts);
 const a=order(c,[line(p)],opts),b=order(c,[line(p)],opts);
 const results=await Promise.all([asyncSql(query(U.owner,ORG,'order.confirm',{id:a})),asyncSql(query(U.admin,ORG,'order.confirm',{id:b}))]);
 assert.equal(results.filter(x=>x.status===0).length,1);assert.match(results.find(x=>x.status!==0).err,/business_insufficient_stock/);
 assert.equal(read(U.owner,ORG).items.find(x=>x.id===p).reserved,1);
});

test('report separates event periods from cumulative receivable and uses inclusive UTC end date', {skip},()=>{
 const c=customer(),s=item('service'),o=order(c,[line(s,1,1000)]);write('order.confirm',{id:o});
 const inv=entry(o,'invoice',1000),payment=entry(o,'payment',400);
 sql(`update office_business_orders set confirmed_at='2026-01-01 00:00:00+00' where id=${quote(o)};
 update office_business_entries set at='2026-01-01 23:59:59+00' where id=${quote(inv)};
 update office_business_entries set at='2026-02-01 23:59:59.999999+00' where id=${quote(payment)}`);
 const jan=report(c,'2026-01-01','2026-01-31');assert.deepEqual(jan.metrics,{sales:1000,invoiced:1000,paid:0,receivable:1000});
 const feb=report(c,'2026-02-01','2026-02-01');assert.deepEqual(feb.metrics,{sales:0,invoiced:0,paid:400,receivable:600});
 assert.equal(feb.orders[0].receivable,600);assert.deepEqual(feb.daily,[{date:'2026-02-01',sales:0,invoiced:0,paid:400}]);
 assert.equal(report(c,'2026-02-02','2026-02-02').metrics.receivable,600);
});

test('settings persist validated module/widget definitions and reports do not truncate at 100 rows', {skip},()=>{
 const c=customer();const dashboard={id:randomUUID(),name:'Sales',widgets:[{id:randomUUID(),type:'line',metric:'sales',size:'full'}],filters:{from:'2026-01-01',to:'2027-01-01',customer:c}};
 write('settings.save',{version:1,enabled:['customers','analytics'],dashboards:[dashboard]});assert.deepEqual(read().settings.dashboards,[dashboard]);
 assert.equal(read().settings.version,2);
 assert.match(fail('settings.save',{version:1,enabled:[],dashboards:[]}),/business_version_conflict/);
 assert.match(fail('settings.save',{version:2,enabled:['evil'],dashboards:[]}),/business_settings/);
 assert.match(fail('settings.save',{version:2,enabled:[],dashboards:[dashboard,dashboard]}),/business_settings_duplicate/);
 assert.match(fail('settings.save',{version:2,enabled:[],dashboards:[{...dashboard,widgets:[dashboard.widgets[0],dashboard.widgets[0]]}]}),/business_settings_duplicate/);
 assert.match(fail('settings.save',{version:2,enabled:[],dashboards:[{...dashboard,widgets:[{...dashboard.widgets[0],type:'donut',metric:'paid'}]}]}),/business_settings/);
 assert.match(fail('settings.save',{version:2,enabled:[],dashboards:[{...dashboard,filters:{from:'2027-01-01',to:'2026-01-01'}}]}),/business_dates/);
 assert.match(fail('settings.save',{version:2,enabled:[],dashboards:[{...dashboard,widgets:[{...dashboard.widgets[0],size:'giant'}]}]}),/business_settings/);
 assert.match(fail('settings.save',{version:2,enabled:[],dashboards:[{...dashboard,widgets:[{...dashboard.widgets[0],hidden:'false'}]}]}),/business_settings/);
 const resized={...dashboard,widgets:['s','m','l','full'].map((size)=>({...dashboard.widgets[0],id:randomUUID(),size,hidden:true}))};
 write('settings.save',{version:2,enabled:['customers','analytics'],dashboards:[resized]});
 assert.deepEqual(read().settings.dashboards,[resized]);
 const restored={...resized,widgets:resized.widgets.map(widget=>({...widget,hidden:false}))};
 write('settings.save',{version:3,enabled:['customers','analytics'],dashboards:[restored]});
 assert.deepEqual(read().settings.dashboards,[restored]);
 const s=item('service');
 sql(userSql(U.owner,`do $$declare i integer; o uuid; begin for i in 1..105 loop
 o:=(office_business_write(null,gen_random_uuid(),'order.create',jsonb_build_object('customer_id',${quote(c)},'title','bulk','lines',jsonb_build_array(jsonb_build_object('item_id',${quote(s)},'quantity',1,'unit_price',1))))->>'id')::uuid;
 perform office_business_write(null,gen_random_uuid(),'order.confirm',jsonb_build_object('id',o)); end loop; end$$`));
 const r=report(c,'2026-01-01','2027-01-01');assert.equal(r.metrics.sales,105);assert.equal(r.orders.length,105);assert.equal(read().orders.filter(x=>x.customer_id===c).length,105);
});
