import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 성과 기록 1단계(유건 9/29): 기한이 있는 할 일을 정식으로 저장하고, 거래에 담당자를 둔다.
// 기한 준수율·달성률과 담당 거래 매출이 사람에게 연결되는 바탕이다. 기록은 고치거나 지우지 않고 이력으로 쌓는다.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-tasks-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','member2','guest','gone','outsider'].map(k=>[k,randomUUID()]));
let ORG;
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const org=o=>o?quote(o):'null';
const userSql=(u,q)=>`set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last=s=>s.split('\n').filter(Boolean).at(-1);
const tq=(u,o,a,d)=>userSql(u,`select office_task_write(${org(o)},${quote(a)},${quote(JSON.stringify(d))}::jsonb)`);
const task=(a,d,{u=U.member,o=ORG}={})=>JSON.parse(last(sql(tq(u,o,a,d))));
const tfail=(a,d,{u=U.member,o=ORG}={})=>{const r=raw(tq(u,o,a,d)); assert.notEqual(r.status,0,`${a} should fail`); return r.stderr;};
const tasks=(u=U.member,o=ORG)=>JSON.parse(last(sql(userSql(u,`select office_task_list(${org(o)})`))));
const bwrite=(a,d,{u=U.owner,o=ORG}={})=>JSON.parse(last(sql(userSql(u,`select office_business_write(${org(o)},${quote(randomUUID())},${quote(a)},${quote(JSON.stringify(d))}::jsonb)`)))).id;
const bread=(u=U.owner,o=ORG)=>JSON.parse(last(sql(userSql(u,`select office_business_read(${org(o)})`))));
const setOwners=(order,owners,{u=U.owner,o=ORG,reason='담당 변경'}={})=>userSql(u,`select office_business_owners_set(${org(o)},${quote(order)},array[${owners.map(quote).join(',')}]::uuid[],${quote(reason)})`);
const newTask=(extra={},opts={})=>{const id=randomUUID(); task('task.create',{id,title:'견적서 보내기',due_on:'2026-10-10',...extra},opts); return id;};
const row=id=>JSON.parse(last(sql(`select to_jsonb(t) from office_tasks t where id=${quote(id)}`)));
const events=id=>sql(`select string_agg(kind,',' order by id) from office_task_events where task_id=${quote(id)}`);

const ORDERS={};
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
  const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(r.stderr);
 }
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Tasks','tasks',${quote(U.owner)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k==='gone'||k==='member2'?'member':k)})`);
 // 마이그레이션 전에 만든 거래 — 담당자는 첫 기록(견적)을 남긴 사람으로 채워져야 한다
 const c=bwrite('customer.save',{name:'Before',email:'',notes:''}), i=bwrite('item.save',{name:'svc',kind:'service',sku:'',price:1000});
 ORDERS.before=bwrite('order.create',{customer_id:c,title:'Before',lines:[{item_id:i,quantity:1,unit_price:1000}]},{u:U.admin});
 ORDERS.c=c; ORDERS.i=i;
 const r=psqlSpawn(DB,['-f',fileURLToPath(new URL('../supabase/migrations/20260929180000_office_tasks_owners.sql',import.meta.url))]);if(r.status!==0)throw new Error(r.stderr);
 sql(`update msgr_org_members set removed_at=now() where user_id=${quote(U.gone)}`);
});

test('할 일: 직원은 자기 할 일을 만들고 끝낸다 — 기한 안에 끝낸 날짜가 남는다', {skip}, ()=>{
 const id=newTask();
 let t=tasks().find(x=>x.id===id);
 assert.equal(t.assignee,U.member); assert.equal(t.created_by,U.member); assert.equal(t.due_on,'2026-10-10'); assert.equal(t.done_at,null);
 task('task.done',{id});
 t=row(id); assert.ok(t.done_at);
 assert.equal(events(id),'create,done');
 task('task.done',{id}); // 이미 끝낸 일을 다시 끝내도 기록이 늘지 않는다(두 번 눌림)
 assert.equal(events(id),'create,done');
});

test('할 일: 같은 id로 두 번 만들면 한 건 — 내용이 다르면 거절', {skip}, ()=>{
 const id=randomUUID(), d={id,title:'한 번만',due_on:null};
 task('task.create',d); task('task.create',d);
 assert.equal(sql(`select count(*) from office_tasks where id=${quote(id)}`),'1');
 assert.match(tfail('task.create',{...d,title:'다른 내용'}),/task_conflict/);
});

test('할 일: 다른 사람에게 배정은 관리자만 — 직원이 남에게 주면 거절, 손님·밖의 사람·나간 사람은 대상이 아니다', {skip}, ()=>{
 assert.match(tfail('task.create',{id:randomUUID(),title:'남에게',assignee:U.member2}),/task_forbidden/);
 const id=newTask({assignee:U.member2},{u:U.admin});
 assert.equal(row(id).assignee,U.member2); assert.equal(row(id).created_by,U.admin);
 for(const who of [U.guest,U.outsider,U.gone])assert.match(tfail('task.create',{id:randomUUID(),title:'x',assignee:who},{u:U.admin}),/task_assignee/);
 assert.match(tfail('task.create',{id:randomUUID(),title:'손님'},{u:U.guest}),/forbidden/);
 assert.match(tfail('task.create',{id:randomUUID(),title:'밖'},{u:U.outsider}),/forbidden/);
});

test('할 일: 보이는 범위 — 담당자·만든 사람·관리자만, 다른 직원의 할 일은 안 보인다', {skip}, ()=>{
 const id=newTask({assignee:U.member2},{u:U.admin});
 assert.ok(tasks(U.member2).some(x=>x.id===id));
 assert.ok(tasks(U.admin).some(x=>x.id===id));
 assert.ok(tasks(U.owner).some(x=>x.id===id));
 assert.ok(!tasks(U.member).some(x=>x.id===id));
 // 표를 직접 읽어도 막힌다(함수를 거치지 않는 길)
 const direct=raw(userSql(U.member,`select count(*) from office_tasks where id=${quote(id)}`));
 assert.ok(direct.status!==0 || last(direct.stdout)==='0');
});

test('할 일: 기한 바꾸기는 이력이 남고, 끝낸 일의 기한은 바꿀 수 없다 — 지우기는 없고 취소만', {skip}, ()=>{
 const id=newTask();
 task('task.due',{id,due_on:'2026-10-20'});
 assert.equal(row(id).due_on,'2026-10-20');
 assert.equal(sql(`select from_value||'>'||to_value from office_task_events where task_id=${quote(id)} and kind='due'`),'2026-10-10>2026-10-20');
 task('task.done',{id});
 assert.match(tfail('task.due',{id,due_on:'2026-12-31'}),/task_done/);
 assert.match(tfail('task.cancel',{id}),/task_done/);
 task('task.reopen',{id}); assert.equal(row(id).done_at,null);
 task('task.cancel',{id}); assert.ok(row(id).cancelled_at);
 assert.match(tfail('task.done',{id}),/task_cancelled/);
 assert.equal(events(id),'create,due,done,reopen,cancel');
 assert.notEqual(raw(userSql(U.member,`delete from office_tasks where id=${quote(id)}`)).status,0); // 지우는 길 자체가 없다
 assert.equal(row(id).id,id);
});

test('할 일: 다른 직원은 남의 할 일을 끝내거나 기한을 바꿀 수 없다', {skip}, ()=>{
 const id=newTask({},{u:U.member2});
 assert.match(tfail('task.done',{id}),/task_forbidden/);
 assert.match(tfail('task.due',{id,due_on:'2026-11-01'}),/task_forbidden/);
 task('task.done',{id},{u:U.admin}); // 관리자는 된다
 assert.ok(row(id).done_at);
});

test('할 일: 내 공간 할 일은 나만 — 조직 없이도 쓴다', {skip}, ()=>{
 const id=randomUUID(); task('task.create',{id,title:'개인',due_on:null},{u:U.outsider,o:null});
 assert.ok(tasks(U.outsider,null).some(x=>x.id===id));
 assert.ok(!tasks(U.member,null).some(x=>x.id===id));
 assert.match(tfail('task.create',{id:randomUUID(),title:'x',assignee:U.member},{u:U.outsider,o:null}),/task_forbidden/);
});

test('거래 담당자: 마이그레이션 전 거래는 견적을 남긴 사람, 새 거래는 만든 사람이 담당자다', {skip}, ()=>{
 assert.deepEqual(bread().orders.find(o=>o.id===ORDERS.before).owners,[U.admin]);
 const o=bwrite('order.create',{customer_id:ORDERS.c,title:'After',lines:[{item_id:ORDERS.i,quantity:1,unit_price:500}]});
 assert.deepEqual(bread().orders.find(x=>x.id===o).owners,[U.owner]);
});

test('거래 담당자: 관리자만 바꾸고, 여러 명 가능, 바꿀 때마다 사유와 함께 이력이 남는다', {skip}, ()=>{
 const o=bwrite('order.create',{customer_id:ORDERS.c,title:'Owners',lines:[{item_id:ORDERS.i,quantity:1,unit_price:500}]});
 sql(setOwners(o,[U.member,U.member2],{reason:'공동 영업'}));
 assert.deepEqual(bread().orders.find(x=>x.id===o).owners.sort(),[U.member,U.member2].sort());
 assert.equal(sql(`select count(*) from office_business_owner_history where order_id=${quote(o)}`),'1');
 assert.equal(sql(`select reason from office_business_owner_history where order_id=${quote(o)}`),'공동 영업');
 assert.notEqual(raw(setOwners(o,[U.member],{u:U.member})).status,0); // 직원은 못 바꾼다
 assert.notEqual(raw(setOwners(o,[U.guest])).status,0);             // 손님·밖의 사람은 담당자가 될 수 없다
 assert.notEqual(raw(setOwners(o,[U.outsider])).status,0);
 assert.notEqual(raw(setOwners(o,[U.member],{reason:''})).status,0);  // 사유 없이 못 바꾼다
 sql(setOwners(o,[U.member2,U.member2],{reason:'중복 정리'}));       // 같은 사람 두 번은 한 번으로
 assert.deepEqual(bread().orders.find(x=>x.id===o).owners,[U.member2]);
});

test('거래 담당자: 내 공간 거래는 담당자를 두지 않는다', {skip}, ()=>{
 const c=bwrite('customer.save',{name:'Me',email:'',notes:''},{o:null}), i=bwrite('item.save',{name:'s',kind:'service',sku:'',price:1},{o:null});
 const o=bwrite('order.create',{customer_id:c,title:'Mine',lines:[{item_id:i,quantity:1,unit_price:1}]},{o:null});
 assert.deepEqual(bread(U.owner,null).orders.find(x=>x.id===o).owners,[]);
});

// 기한 준수율을 지키려면 맡은 사람이 남이 맡긴 일의 기한·제목을 바꾸거나 취소할 수 없어야 한다 — 끝내기·다시 열기만(9/29 화면 확인에서 발견)
test('할 일: 관리자가 맡긴 일은 직원이 기한·제목·취소를 못 하고 끝내기만 한다', {skip}, ()=>{
 const id=newTask({assignee:U.member},{u:U.admin});
 assert.match(tfail('task.due',{id,due_on:'2026-12-31'}),/task_forbidden/);
 assert.match(tfail('task.title',{id,title:'바꾼 제목'}),/task_forbidden/);
 assert.match(tfail('task.cancel',{id}),/task_forbidden/);
 task('task.done',{id}); task('task.reopen',{id});
 task('task.due',{id,due_on:'2026-10-15'},{u:U.admin}); // 맡긴 관리자는 바꾼다
 assert.equal(row(id).due_on,'2026-10-15');
});

test('할 일: 관리자가 다른 사람에게 다시 맡긴 일은 처음 만든 직원도 기한·제목·취소를 못 한다', {skip}, ()=>{
 const id=newTask();
 task('task.assign',{id,assignee:U.member2},{u:U.admin});
 assert.match(tfail('task.due',{id,due_on:'2027-01-01'}),/task_forbidden/);
 assert.match(tfail('task.cancel',{id}),/task_forbidden/);
 task('task.done',{id},{u:U.member2});
});

test('할 일: 기한은 YYYY-MM-DD 형식·2000~2100년만 — infinity·today·다른 형식은 거절', {skip}, ()=>{
 for(const due_on of ['infinity','-infinity','today','10/11/2026','5874897-12-31','1999-12-31'])assert.match(tfail('task.create',{id:randomUUID(),title:'기한',due_on}),/task_input/,due_on);
});

test('할 일: 사람마다 한 범위에 5000개까지 — 넘으면 task_limit', {skip}, ()=>{
 const who=U.member2;
 sql(`insert into office_tasks(id,scope,title,assignee,created_by) select gen_random_uuid(),'o:${ORG}','x',${quote(who)},${quote(who)} from generate_series(1,5000)`);
 assert.match(tfail('task.create',{id:randomUUID(),title:'하나 더',due_on:null},{u:who}),/task_limit/);
 sql(`delete from office_tasks where created_by=${quote(who)} and title='x'`);
});

test('거래 담당자: 담당자 목록이 null이면 거절(모두 지우기는 빈 배열로만)', {skip}, ()=>{
 const o=ORDERS.before;
 const r=raw(userSql(U.owner,`select office_business_owners_set(${quote(ORG)},${quote(o)},null,'실수')`));
 assert.notEqual(r.status,0); assert.match(r.stderr,/business_input/);
});

test('거래 담당자: 마이그레이션을 다시 적용해도 관리자가 비운 담당자를 되살리지 않는다', {skip}, ()=>{
 const o=ORDERS.before;
 sql(setOwners(o,[],{reason:'담당 없음으로'}));
 const r=psqlSpawn(DB,['-f',fileURLToPath(new URL('../supabase/migrations/20260929180000_office_tasks_owners.sql',import.meta.url))]); if(r.status!==0)throw new Error(r.stderr);
 assert.equal(sql(`select cardinality(owners) from office_business_orders where id=${quote(o)}`),'0');
});

test('할 일 상한: 취소한 일과 1년 넘은 끝낸 일은 세지 않는다', {skip}, ()=>{
 const who=U.member2;
 sql(`insert into office_tasks(id,scope,title,assignee,created_by,cancelled_at) select gen_random_uuid(),'o:${ORG}','x',${quote(who)},${quote(who)},now() from generate_series(1,3000);
  insert into office_tasks(id,scope,title,assignee,created_by,done_at) select gen_random_uuid(),'o:${ORG}','x',${quote(who)},${quote(who)},now()-interval '400 days' from generate_series(1,2500)`);
 task('task.create',{id:randomUUID(),title:'아직 된다',due_on:null},{u:who});
 sql(`delete from office_tasks where created_by=${quote(who)} and title='x'`);
});
