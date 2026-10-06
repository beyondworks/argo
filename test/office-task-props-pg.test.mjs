import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 할 일 속성(유건 10/4 확정 — 오피스 14차 트랙 T, PARITY-ALL 10-1절 2번): 상태(할 일·진행 중·보류)·중요도·분류·시작일, 메모 고치기, 분류 관리, 바뀐 기록 보기.
// 실제 Postgres에서 본다: 권한(맡은 사람은 상태만, 내용은 만든 사람·관리자), 200번 상한이 새 동작까지 덮는지, 같은 값은 다시 쓰지 않는지(xmin 그대로),
// 성과 기록은 '끝냄'만 센다(상태·중요도·분류를 바꿔도 성과 계산이 그대로), 이관(office_task_import)이 Notion 값을 칸으로 옮기는지.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-task-props-pg.test.mjs';
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
const task=(a,d,{u=U.member,o=ORG}={})=>call(u,'office_task_write',`${org(o)},${quote(a)},${j(d)}`);
const tfail=(a,d,{u=U.member,o=ORG}={})=>callFail(u,'office_task_write',`${org(o)},${quote(a)},${j(d)}`);
const list=(u=U.member,o=ORG)=>call(u,'office_task_list',org(o));
const cats=(u=U.admin,o=ORG)=>call(u,'office_task_category_list',org(o));
const cat=(a,d,{u=U.admin,o=ORG}={})=>call(u,'office_task_category_write',`${org(o)},${quote(a)},${j(d)}`);
const catFail=(a,d,{u=U.admin,o=ORG}={})=>callFail(u,'office_task_category_write',`${org(o)},${quote(a)},${j(d)}`);
const hist=(id,{u=U.member,o=ORG}={})=>call(u,'office_task_history',`${org(o)},${quote(id)}`);
const row=id=>JSON.parse(last(sql(`select to_jsonb(t) from office_tasks t where id=${quote(id)}`)));
const xmin=id=>sql(`select xmin::text from office_tasks where id=${quote(id)}`);
const kinds=id=>sql(`select coalesce(string_agg(kind,',' order by id),'') from office_task_events where task_id=${quote(id)}`);
const newTask=(extra={},opts={})=>{const id=randomUUID(); task('task.create',{id,title:'견적서 보내기',due_on:'2026-10-20',...extra},opts); return id;};
const imp=(u,d,o=ORG)=>call(u,'office_task_import',`${org(o)},${j(d)}`);
const impFail=(u,d,o=ORG)=>callFail(u,'office_task_import',`${org(o)},${j(d)}`);
const kst=d=>new Date(d.getTime()+9*3600e3).toISOString().slice(0,10);
const TODAY=kst(new Date());
const THIS=TODAY.slice(0,7);
const endOf=p=>{const [y,m]=p.split('-').map(Number); return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
const MIG=f=>fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url));
const apply=f=>{const r=psqlSpawn(DB,['-f',MIG(f)]); if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);};
let OLD;

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
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260909003000_msgr_message_meta.sql','20260927144230_office_business.sql','20260927170000_office_pages.sql','20260927171000_office_mail.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20260929190000_office_perf.sql','20260930150000_office_perf_tie_order.sql','20261002201800_office_company.sql'])apply(f);
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Props','props',${quote(U.owner)}) returning id`)));
 ORG2=last(sql(userSql(U.outsider,`insert into msgr_orgs(name,slug,owner_user_id)values('Other','other-props',${quote(U.outsider)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest'])sql(`insert into msgr_org_members(org_id,user_id,role,display_name)values(${quote(ORG)},${quote(U[k])},${quote(k==='member2'?'member':k)},${quote(k)})`);
 // 마이그레이션 전에 만든 할 일 — 새 칸은 기본값(할 일·보통·미분류·시작일 없음)이어야 한다
 OLD=randomUUID(); task('task.create',{id:OLD,title:'옛 할 일',due_on:'2026-10-15'});
 apply('20261004100000_office_task_props.sql');
 apply('20261004100000_office_task_props.sql'); // 다시 적용해도 깨지지 않는다
});

test('마이그레이션: 옛 할 일은 기본값, 목록이 새 칸과 분류 이름을 준다', {skip}, ()=>{
 const t=list().find(x=>x.id===OLD);
 assert.deepEqual([t.status,t.priority,t.category_id,t.category,t.starts_on],['todo',2,null,null,null]);
 assert.ok(!('scope' in t));
 assert.equal(kinds(OLD),'create');
});

test('상태: 맡은 사람은 관리자가 맡긴 일의 상태를 바꾼다(할 일↔진행 중↔보류), 다른 직원은 못 한다, 모르는 값은 거절', {skip}, ()=>{
 const id=newTask({assignee:U.member},{u:U.admin});
 assert.equal(task('task.status',{id,status:'doing'}).status,'doing');
 assert.equal(task('task.status',{id,status:'hold'}).status,'hold');
 assert.match(tfail('task.status',{id,status:'doing'},{u:U.member2}),/task_forbidden/);
 for(const status of ['done','cancelled','',null])assert.match(tfail('task.status',{id,status}),/task_input/,String(status));
 assert.match(tfail('task.status',{id}),/task_input/,'상태를 빠뜨리면 거절');
 assert.equal(kinds(id),'create,status,status');
 assert.equal(sql(`select string_agg(from_value||'>'||to_value,',' order by id) from office_task_events where task_id=${quote(id)} and kind='status'`),'todo>doing,doing>hold');
});

test('같은 값은 다시 쓰지 않는다 — 상태·중요도·분류·시작일·메모, 행(xmin)과 이력 그대로', {skip}, ()=>{
 const c=randomUUID(); cat('category.create',{id:c,name:'같은값'},{u:U.member,o:null});
 const id=newTask({status:'doing',priority:1,category_id:c,starts_on:'2026-10-01',note:'메모'},{o:null});
 const x=xmin(id), k=kinds(id);
 task('task.status',{id,status:'doing'},{o:null}); task('task.priority',{id,priority:1},{o:null}); task('task.category',{id,category_id:c},{o:null});
 task('task.start',{id,starts_on:'2026-10-01'},{o:null}); task('task.note',{id,note:'메모'},{o:null}); task('task.due',{id,due_on:'2026-10-20'},{o:null}); task('task.title',{id,title:'견적서 보내기'},{o:null});
 assert.equal(xmin(id),x,'같은 값 쓰기가 행을 다시 쓰지 않는다');
 assert.equal(kinds(id),k);
});

test('내용(중요도·분류·시작일·메모)은 제목·기한과 같은 권한 — 남이 맡긴 일은 못 고치고, 만든 사람=맡은 사람·관리자는 고친다', {skip}, ()=>{
 const c=randomUUID(); cat('category.create',{id:c,name:'영업'});
 const given=newTask({assignee:U.member},{u:U.admin});
 assert.match(tfail('task.priority',{id:given,priority:1}),/task_forbidden/);
 assert.match(tfail('task.category',{id:given,category_id:c}),/task_forbidden/);
 assert.match(tfail('task.start',{id:given,starts_on:'2026-10-01'}),/task_forbidden/);
 assert.match(tfail('task.note',{id:given,note:'몰래'}),/task_forbidden/);
 const mine=newTask();
 const t=task('task.category',{id:mine,category_id:c}); task('task.priority',{id:mine,priority:3}); task('task.start',{id:mine,starts_on:'2026-10-02'}); task('task.note',{id:mine,note:'내 메모'});
 assert.equal(t.category_id,c);
 const r=row(mine); assert.deepEqual([r.priority,r.starts_on,r.note],[3,'2026-10-02','내 메모']);
 assert.equal(list().find(x=>x.id===mine).category,'영업','목록에 분류 이름이 붙는다');
 task('task.priority',{id:given,priority:1},{u:U.admin}); assert.equal(row(given).priority,1,'관리자는 고친다');
 assert.equal(sql(`select from_value is null and to_value is null from office_task_events where task_id=${quote(mine)} and kind='note'`),'t','메모 값은 기록에 남기지 않는다');
 assert.equal(sql(`select coalesce(from_value,'-')||'>'||to_value from office_task_events where task_id=${quote(mine)} and kind='category'`),'->영업','분류는 이름으로 남긴다');
 assert.match(tfail('task.note',{id:mine,note:'x'.repeat(4001)}),/task_input/);
 assert.match(tfail('task.note',{id:mine}),/task_input/,'메모를 빠뜨린 요청은 메모를 지우지 않고 거절');
 assert.equal(row(mine).note,'내 메모');
 for(const priority of [0,4,'high',null])assert.match(tfail('task.priority',{id:mine,priority}),/task_input/,String(priority));
});

test('끝낸 일·취소한 일은 바꾸지 않는다 — 상태·내용 모두, 다시 열기는 된다', {skip}, ()=>{
 const id=newTask(); task('task.status',{id,status:'doing'}); task('task.done',{id});
 for(const [a,d] of [['task.status',{status:'hold'}],['task.note',{note:'x'}],['task.priority',{priority:1}],['task.category',{category_id:null}],['task.start',{starts_on:'2026-10-01'}]])
  assert.match(tfail(a,{id,...d}),/task_done/,a);
 task('task.reopen',{id}); assert.equal(row(id).status,'doing','다시 열면 저장된 상태로');
 task('task.cancel',{id});
 assert.match(tfail('task.status',{id,status:'todo'}),/task_cancelled/);
 assert.match(tfail('task.note',{id,note:'x'}),/task_cancelled/);
});

test('시작일은 기한보다 늦을 수 없다 — 만들기·시작일·기한 모두', {skip}, ()=>{
 assert.match(tfail('task.create',{id:randomUUID(),title:'x',due_on:'2026-10-05',starts_on:'2026-10-06'}),/task_dates/);
 const id=newTask({starts_on:'2026-10-10'});
 assert.match(tfail('task.start',{id,starts_on:'2026-10-21'}),/task_dates/);
 assert.match(tfail('task.due',{id,due_on:'2026-10-09'}),/task_dates/);
 task('task.due',{id,due_on:null}); assert.equal(row(id).due_on,null,'기한을 비우는 것은 된다');
 task('task.start',{id,starts_on:'2026-12-31'}); assert.equal(row(id).starts_on,'2026-12-31','기한이 없으면 시작일은 자유');
 for(const starts_on of ['today','1999-12-31','2026/10/01'])assert.match(tfail('task.start',{id,starts_on}),/task_input/,starts_on);
});

test('분류: 다른 공간의 분류는 못 붙인다(task_category), 만들 때 상태·중요도·분류·시작일을 함께 받는다', {skip}, ()=>{
 const other=randomUUID(); cat('category.create',{id:other,name:'남의 분류'},{u:U.outsider,o:ORG2});
 const mine=randomUUID(); cat('category.create',{id:mine,name:'개인'},{u:U.member,o:null});
 assert.match(tfail('task.create',{id:randomUUID(),title:'x',category_id:other}),/task_category/);
 assert.match(tfail('task.create',{id:randomUUID(),title:'x',category_id:mine}),/task_category/,'내 개인 분류도 조직 할 일에는 못 붙인다');
 const id=newTask();
 assert.match(tfail('task.category',{id,category_id:other}),/task_category/);
 const p=randomUUID(); const t=task('task.create',{id:p,title:'개인 일',status:'hold',priority:3,category_id:mine,starts_on:'2026-10-01',due_on:'2026-10-03'},{o:null});
 assert.deepEqual([t.status,t.priority,t.category_id,t.starts_on],['hold',3,mine,'2026-10-01']);
 task('task.create',{id:p,title:'개인 일',status:'hold',priority:3,category_id:mine,starts_on:'2026-10-01',due_on:'2026-10-03'},{o:null}); // 같은 요청 두 번 = 한 건
 assert.match(tfail('task.create',{id:p,title:'개인 일',status:'hold',priority:1,category_id:mine,starts_on:'2026-10-01',due_on:'2026-10-03'},{o:null}),/task_conflict/);
 for(const status of ['done','x'])assert.match(tfail('task.create',{id:randomUUID(),title:'x',status}),/task_input/,status);
});

test('200번 상한: 내용 고치기(기한·제목·중요도·분류·시작일·메모)는 합쳐 200번, 상태 바꾸기는 따로 200번 — 끝내기는 막지 않는다', {skip}, ()=>{
 const id=newTask();
 const ev=(kinds,n)=>sql(`insert into office_task_events(task_id,kind,actor) select ${quote(id)},(array[${kinds.map(quote).join(',')}])[1+g%${kinds.length}],${quote(U.member)} from generate_series(1,${n}) g`);
 const CONTENT=[['task.priority',{priority:1}],['task.category',{category_id:null}],['task.start',{starts_on:'2026-10-01'}],['task.note',{note:'201'}],['task.due',{due_on:'2026-10-21'}],['task.title',{title:'바꿈'}]];
 ev(['due','title','priority','category','start','note'],199); ev(['status'],150);
 task('task.note',{id,note:'200번째'}); // 내용 199 + 1 = 200
 for(const [a,d] of CONTENT)assert.match(tfail(a,{id,...d}),/task_limit/,a);
 task('task.status',{id,status:'doing'}); // 상태는 따로 센다 — 내용 고치기 몫을 다 써도 상태는 바꾼다
 assert.equal(row(id).status,'doing');
 ev(['status'],48); // 상태 150 + 1 + 48 = 199
 task('task.status',{id,status:'hold'}); // 200번째
 assert.match(tfail('task.status',{id,status:'todo'}),/task_limit/,'상태 바꾸기도 200번까지');
 assert.equal(row(id).status,'hold');
 for(const [a,d] of CONTENT)assert.match(tfail(a,{id,...d}),/task_limit/,a);
 task('task.done',{id}); task('task.reopen',{id}); // 끝내기·다시 열기는 된다
 assert.equal(Number(sql(`select count(*) from office_task_events where task_id=${quote(id)}`)),1+200+200+2);
});

test('상태 상한은 내용 고치기 몫을 쓰지 않는다: 상태를 200번 바꾼 일도 제목·기한은 고친다', {skip}, ()=>{
 const id=newTask();
 sql(`insert into office_task_events(task_id,kind,actor) select ${quote(id)},'status',${quote(U.member)} from generate_series(1,200)`);
 assert.match(tfail('task.status',{id,status:'doing'}),/task_limit/);
 task('task.title',{id,title:'상태와 따로'}); task('task.due',{id,due_on:'2026-10-25'});
 assert.deepEqual([row(id).title,row(id).due_on],['상태와 따로','2026-10-25']);
});

test('분류 관리: 조직은 관리자만, 개인은 본인 — 같은 이름(대소문자 무시) 거절, 이름 바꾸기·순서·지우기(소속 할 일은 미분류)', {skip}, ()=>{
 const a=randomUUID(), b=randomUUID(), c=randomUUID();
 assert.match(catFail('category.create',{id:a,name:'디자인'},{u:U.member}),/task_forbidden/);
 assert.match(catFail('category.create',{id:a,name:'디자인'},{u:U.guest}),/forbidden/);
 assert.match(catFail('category.create',{id:a,name:'디자인'},{u:U.outsider}),/forbidden/);
 cat('category.create',{id:a,name:'Design'}); cat('category.create',{id:b,name:'세무'}); cat('category.create',{id:c,name:'기타'});
 cat('category.create',{id:a,name:'Design'}); // 같은 요청 두 번 = 한 건
 assert.match(catFail('category.create',{id:randomUUID(),name:'design'}),/task_category_name/);
 assert.match(catFail('category.create',{id:randomUUID(),name:' '}),/task_input/);
 assert.match(catFail('category.create',{id:randomUUID(),name:'x'.repeat(41)}),/task_input/);
 assert.match(catFail('category.rename',{id:b,name:'DESIGN'}),/task_category_name/);
 const before=sql(`select xmin::text from office_task_categories where id=${quote(a)}`);
 cat('category.rename',{id:a,name:'Design'}); // 같은 이름은 다시 쓰지 않는다
 assert.equal(sql(`select xmin::text from office_task_categories where id=${quote(a)}`),before);
 cat('category.rename',{id:a,name:'디자인'});
 const all=cats().map(x=>x.id);
 const order=[c,...all.filter(x=>x!==c)];
 assert.deepEqual(cat('category.order',{ids:order}).map(x=>x.id),order);
 const xs=sql(`select string_agg(xmin::text,',' order by id) from office_task_categories where scope=${quote(`o:${ORG}`)}`);
 cat('category.order',{ids:order}); // 같은 순서는 다시 쓰지 않는다
 assert.equal(sql(`select string_agg(xmin::text,',' order by id) from office_task_categories where scope=${quote(`o:${ORG}`)}`),xs);
 assert.match(catFail('category.order',{ids:order.slice(1)}),/task_input/,'일부만 보내면 거절');
 assert.match(catFail('category.order',{ids:[...order.slice(1),order[1]]}),/task_input/,'중복 거절');
 assert.match(catFail('category.order',{ids:'x'}),/task_input/);
 assert.match(catFail('category.rename',{id:randomUUID(),name:'없음'}),/task_category/);
 // 지우면 그 분류의 할 일은 미분류 — 할 일은 그대로 남는다
 const t1=newTask({category_id:b}), t2=newTask({category_id:b});
 assert.equal(cats().find(x=>x.id===b).tasks,2,'관리자는 할 일 수를 본다');
 assert.equal(cats(U.member).find(x=>x.id===b).tasks,null,'직원은 이름만(안 보이는 일의 수는 내지 않는다)');
 cat('category.delete',{id:b});
 assert.equal(row(t1).category_id,null); assert.equal(row(t2).category_id,null); assert.equal(row(t1).cancelled_at,null);
 assert.ok(!cats().some(x=>x.id===b));
 assert.match(catFail('category.delete',{id:b}),/task_category/);
 assert.match(catFail('category.zzz',{id:a}),/task_input/);
 // 개인 공간 분류는 본인만, 남의 개인 분류는 지울 수 없다
 const mine=randomUUID(); cat('category.create',{id:mine,name:'개인 분류'},{u:U.member2,o:null});
 assert.match(catFail('category.delete',{id:mine},{u:U.member,o:null}),/task_category/);
 assert.ok(cats(U.member2,null).some(x=>x.id===mine));
 assert.ok(!cats(U.member,null).some(x=>x.id===mine));
});

test('분류 상한: 공간마다 200개', {skip}, ()=>{
 const who=U.outsider;
 sql(`insert into office_task_categories(id,scope,name,position,created_by) select gen_random_uuid(),'u:${who}','c'||g,g,${quote(who)} from generate_series(1,200) g`);
 assert.match(catFail('category.create',{id:randomUUID(),name:'하나 더'},{u:who,o:null}),/task_limit/);
 sql(`delete from office_task_categories where scope='u:${who}'`);
});

test('바뀐 기록: 담당자·만든 사람·관리자만 읽는다, 사람 이름과 맡은 사람 바꾸기의 앞뒤 이름', {skip}, ()=>{
 const id=newTask({},{u:U.admin});
 task('task.assign',{id,assignee:U.member},{u:U.admin}); task('task.status',{id,status:'doing'});
 const h=hist(id);
 assert.deepEqual(h.map(x=>x.kind),['status','assign','create']);
 assert.equal(h[0].name,'member'); assert.deepEqual([h[1].from,h[1].to],['admin','member']);
 assert.equal(hist(id,{u:U.owner}).length,3);
 assert.match(callFail(U.member2,'office_task_history',`${quote(ORG)},${quote(id)}`),/task_not_found/);
 assert.match(callFail(U.guest,'office_task_history',`${quote(ORG)},${quote(id)}`),/forbidden/);
 assert.match(callFail(U.member,'office_task_history',`null,${quote(id)}`),/task_not_found/,'다른 공간 이름으로는 못 읽는다');
});

// 유건 10/4 확정: 성과 기록은 '끝냄'만 센다 — 진행 중·보류·중요도·분류·시작일·메모를 바꿔도 성과 계산(office_perf_compute)이 한 글자도 달라지지 않는다
test('성과 기록 불변: 상태·중요도·분류·시작일·메모를 바꿔도 성과 계산이 같고, 끝내야만 끝낸 수가 오른다', {skip}, ()=>{
 const c=randomUUID(); cat('category.create',{id:c,name:'성과 확인'});
 const due=`${THIS}-${TODAY.slice(8)}`, a=newTask({due_on:due}), b=newTask({due_on:due});
 const report=()=>call(U.member,'office_perf_report',`${quote(ORG)},${quote(`${THIS}-01`)}::date,${quote(endOf(THIS))}::date`);
 const keep=r=>JSON.stringify({totals:r.totals,tasks:[...r.tasks].sort((x,y)=>x.id.localeCompare(y.id))}); // 같은 기한끼리의 순서는 정해져 있지 않다(행을 고치면 바뀔 수 있다) — 내용만 비교
 const base=report();
 task('task.status',{id:a,status:'doing'}); task('task.status',{id:b,status:'hold'});
 task('task.priority',{id:a,priority:1}); task('task.category',{id:a,category_id:c}); task('task.start',{id:a,starts_on:`${THIS}-01`}); task('task.note',{id:b,note:'보류 사유'});
 assert.equal(keep(report()),keep(base),'진행 중·보류는 끝낸 일이 아니다');
 task('task.done',{id:a});
 const after=report();
 assert.equal(after.totals.tasks_done,base.totals.tasks_done+1,'끝내야 센다');
 assert.equal(after.totals.tasks_done_due,base.totals.tasks_done_due+1);
});

test('이관: Notion 상태·우선순위·분류 이름·시작일을 칸으로 — 분류는 이름으로 찾고 없으면 한 번만 만든다, 다시 불러도 한 건', {skip}, ()=>{
 const id=randomUUID();
 const t=imp(U.admin,{id,title:'제안서 초안',note:'1차 초안까지',status:'doing',priority:1,category:'제안서',starts_on:'2026-09-20',due_on:'2026-09-25',source:{kind:'notion',id:'n-props-1'}});
 assert.deepEqual([t.status,t.priority,t.starts_on,t.due_on,t.note],['doing',1,'2026-09-20','2026-09-25','1차 초안까지']);
 const cid=t.category_id; assert.ok(cid);
 const t2=imp(U.admin,{id:randomUUID(),title:'두 번째',category:'  제안서 ',status:'hold',source:{kind:'notion',id:'n-props-2'}});
 assert.equal(t2.category_id,cid,'같은 이름은 같은 분류(앞뒤 공백 무시)');
 const t3=imp(U.admin,{id:randomUUID(),title:'세 번째',category:'제안서'.toUpperCase()+'X',source:{kind:'notion',id:'n-props-3'}});
 assert.notEqual(t3.category_id,cid);
 const n=cats().length;
 assert.equal(imp(U.admin,{id,title:'제안서 초안',category:'새 이름',source:{kind:'notion',id:'n-props-1'}}).category_id,cid,'다시 부르면 그대로 — 분류도 새로 만들지 않는다');
 assert.equal(cats().length,n);
 const old=imp(U.admin,{id:randomUUID(),title:'옛 모양',note:'[노션에서 옮김]',source:{kind:'notion',id:'n-props-4'}});
 assert.deepEqual([old.status,old.priority,old.category_id,old.starts_on],['todo',2,null,null],'새 칸 없는 옛 요청도 된다(기본값)');
 assert.match(impFail(U.admin,{id:randomUUID(),title:'x',status:'done',source:{kind:'notion',id:'n-props-5'}}),/task_input/);
 assert.match(impFail(U.admin,{id:randomUUID(),title:'x',priority:7,source:{kind:'notion',id:'n-props-6'}}),/task_input/);
 assert.match(impFail(U.admin,{id:randomUUID(),title:'x',starts_on:'2026-09-26',due_on:'2026-09-25',source:{kind:'notion',id:'n-props-7'}}),/task_dates/);
 assert.match(impFail(U.admin,{id:randomUUID(),title:'x',category:'x'.repeat(41),source:{kind:'notion',id:'n-props-8'}}),/task_input/);
 assert.match(impFail(U.member,{id:randomUUID(),title:'x',category:'직원',source:{kind:'notion',id:'n-props-9'}}),/task_forbidden/,'조직 이관은 관리자만(분류도 만들지 않는다)');
 assert.ok(!cats().some(x=>x.name==='직원'));
});

test('이관 재실행: 평가를 끝낸 달이 있어도 이미 옮긴 줄은 그대로 돌려준다 — 잠긴 달에 새 줄은 넣지 못한다', {skip}, ()=>{
 const o=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Locked','locked-props',${quote(U.owner)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(o)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 const id=randomUUID(), src={kind:'notion',id:'n-lock-1'};
 const first=imp(U.owner,{id,title:'8월 일',status:'doing',created_at:'2026-08-10T01:00:00Z',done_at:'2026-08-12T01:00:00Z',source:src},o);
 sql(`insert into office_perf_reviews(org_id,user_id,period,status,done_at)values(${quote(o)},${quote(U.owner)},'2026-08','done',now())`); // 8월 평가를 끝냄
 const again=imp(U.owner,{id,title:'8월 일',status:'doing',created_at:'2026-08-10T01:00:00Z',done_at:'2026-08-12T01:00:00Z',source:src},o);
 assert.equal(again.id,first.id,'같은 줄 다시 부르기는 잠금에 막히지 않는다');
 assert.equal(imp(U.owner,{id:randomUUID(),title:'8월 일',created_at:'2026-08-10T01:00:00Z',source:src},o).id,first.id,'같은 원본(다른 id)도 그대로');
 assert.match(impFail(U.owner,{id:randomUUID(),title:'잠긴 달 새 일',created_at:'2026-08-20T01:00:00Z',source:{kind:'notion',id:'n-lock-2'}},o),/task_locked/);
 assert.equal(imp(U.owner,{id:randomUUID(),title:'9월 새 일',created_at:'2026-09-02T01:00:00Z',source:{kind:'notion',id:'n-lock-3'}},o).title,'9월 새 일');
});

test('표·함수 경계: 분류 표는 직접 못 읽고, 새 함수는 로그인한 사람만 실행한다', {skip}, ()=>{
 const direct=raw(userSql(U.admin,`select count(*) from office_task_categories`));
 assert.ok(direct.status!==0 || last(direct.stdout)==='0');
 for(const fn of ['office_task_category_list(uuid)','office_task_category_write(uuid,text,jsonb)','office_task_history(uuid,uuid)','office_task_write(uuid,text,jsonb)','office_task_list(uuid)','office_task_import(uuid,jsonb)']){
  assert.equal(sql(`select has_function_privilege('anon','public.${fn}','execute')`),'f',fn);
  assert.equal(sql(`select has_function_privilege('authenticated','public.${fn}','execute')`),'t',fn);
 }
 for(const fn of ['office_task_category_list(uuid)','office_task_category_write(uuid,text,jsonb)','office_task_history(uuid,uuid)'])assert.equal(sql(`select prosecdef from pg_proc where oid='public.${fn}'::regprocedure`),'t',`${fn}: 정의자 함수`);
 assert.equal(sql(`select relrowsecurity from pg_class where oid='public.office_task_categories'::regclass`),'t','분류 표 RLS 켜짐');
});
