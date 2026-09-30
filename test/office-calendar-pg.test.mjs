import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 오피스 일정(유건 9/30 확정 명세): 원본은 office_events 한 표. 개인 일정은 주인만, 조직 일정은 멤버에게(나만이면 주인·참석자만).
// 같은 행이 개인 달력과 조직 달력에 보이고, 고치는 사람은 주인과 조직 관리자뿐 — 에이전트(crew)는 주인 일정만.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-calendar-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','member2','guest','gone','outsider'].map(k=>[k,randomUUID()]));
let ORG, ORG2; const C={};
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const userSql=(u,q)=>`set timezone to 'UTC'; set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`; // 운영 Supabase와 같은 UTC 세션
const last=s=>s.split('\n').filter(Boolean).at(-1);
const j=d=>`${quote(JSON.stringify(d))}::jsonb`;
const write=(u,a,d)=>JSON.parse(last(sql(userSql(u,`select office_event_write(${quote(a)},${j(d)})`))));
const writeFail=(u,a,d)=>{const r=raw(userSql(u,`select office_event_write(${quote(a)},${j(d)})`)); assert.notEqual(r.status,0,`${a} should fail`); return r.stderr;};
const list=(u,from='2026-10-01T00:00:00+09:00',to='2026-11-01T00:00:00+09:00')=>JSON.parse(last(sql(userSql(u,`select office_event_list(${quote(from)}::timestamptz,${quote(to)}::timestamptz)`))));
const ids=(u,...r)=>list(u,...r).events.map(e=>e.id);
const row=id=>JSON.parse(last(sql(`select coalesce(to_jsonb(e)||jsonb_build_object('xmin',e.xmin::text),'null') from (select xmin,* from office_events where id=${quote(id)}) e`))||'null');
const ev=(over={})=>({id:randomUUID(),title:'회의',starts_at:'2026-10-14T10:00:00+09:00',ends_at:'2026-10-14T11:00:00+09:00',...over});

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
 const files=['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260909003000_msgr_message_meta.sql','20260927144230_office_business.sql','20260927170000_office_pages.sql','20260927171000_office_mail.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20260929190000_office_perf.sql','20260930150000_office_perf_tie_order.sql','20260930190000_office_calendar.sql'];
 for(const f of files){const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);}
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 sql(`insert into msgr_profiles(user_id,display_name)values(${quote(U.member)},'멤버')`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Cal','cal',${quote(U.owner)}) returning id`)));
 ORG2=last(sql(userSql(U.outsider,`insert into msgr_orgs(name,slug,owner_user_id)values('Other','other',${quote(U.outsider)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role,display_name)values(${quote(ORG)},${quote(U[k])},${quote(k==='member2'||k==='gone'?'member':k)},${quote(k)})`);
 sql(`update msgr_org_members set removed_at=now() where org_id=${quote(ORG)} and user_id=${quote(U.gone)}`);
 const cust=(u,org,name)=>JSON.parse(last(sql(userSql(u,`select office_business_write(${org?quote(org):'null'},${quote(randomUUID())},'customer.save',${j({name,email:'',notes:''})})`)))).id;
 C.org=cust(U.owner,ORG,'조직 거래처'); C.mine=cust(U.member,null,'멤버 개인 거래처'); C.other=cust(U.outsider,ORG2,'남의 조직 거래처');
});

// 이유: 개인 일정은 개인 공간 것이라 같은 조직의 관리자에게도 새면 안 된다
test('개인 일정은 주인만 본다 — 같은 조직 관리자·멤버에게도 안 보인다', {skip}, ()=>{
 const e=ev({title:'개인'}); const r=write(U.member,'save',e);
 assert.equal(r.event.org_id,null); assert.equal(r.event.visibility,'private'); assert.equal(r.event.owner_name,'멤버');
 assert.ok(ids(U.member).includes(e.id));
 for(const k of ['owner','admin','member2','outsider'])assert.ok(!ids(U[k]).includes(e.id),k);
 // 개인 일정에 'org'를 보내도 항상 나만, 참석자도 비운다
 const f=ev({visibility:'org',attendees:[U.member2]}); const g=write(U.member,'save',f).event;
 assert.equal(g.visibility,'private'); assert.deepEqual(g.attendees,[]);
});

// 이유: 조직 전체 일정은 팀 달력의 기본 — 멤버는 다 보지만 손님·나간 사람·밖의 사람은 못 본다. '나만'은 주인·참석자만
test('조직 전체 일정은 멤버 모두, 손님·나간 멤버는 제외 — 나만 일정은 주인·참석자만', {skip}, ()=>{
 const pub=ev({org_id:ORG,title:'전체 회의'}); write(U.member,'save',pub);
 assert.equal(row(pub.id).visibility,'org'); // 기본값
 for(const k of ['owner','admin','member','member2'])assert.ok(ids(U[k]).includes(pub.id),k);
 for(const k of ['guest','gone','outsider'])assert.ok(!ids(U[k]).includes(pub.id),k);
 const priv=ev({org_id:ORG,visibility:'private',attendees:[U.member2],title:'둘만'}); write(U.member,'save',priv);
 for(const k of ['member','member2'])assert.ok(ids(U[k]).includes(priv.id),k);
 for(const k of ['owner','admin','guest','gone','outsider'])assert.ok(!ids(U[k]).includes(priv.id),k);
 // 손님·나간 사람은 조직 일정을 만들 수도 없다
 for(const k of ['guest','gone','outsider'])assert.match(writeFail(U[k],'save',ev({org_id:ORG})),/calendar_forbidden/,k);
 const orgs=list(U.member).orgs; assert.deepEqual(orgs.map(o=>[o.id,o.role]),[[ORG,'member']]);
 assert.deepEqual(list(U.guest).orgs,[]);
});

// 이유: 개인 공간에서 캘린더를 조직으로 고르면 저장 행은 하나 — 조직 달력과 개인 달력이 같은 id를 본다
test('개인 공간에서 org_id로 저장한 일정은 조직 목록에도 같은 id로 나온다(한 행)', {skip}, ()=>{
 const e=ev({org_id:ORG,title:'양방향'}); const saved=write(U.member,'save',e).event;
 const mine=list(U.member).events.filter(x=>x.id===e.id), theirs=list(U.admin).events.filter(x=>x.id===e.id);
 assert.equal(mine.length,1); assert.equal(theirs.length,1);
 assert.equal(mine[0].org_id,ORG); assert.deepEqual(theirs[0],{...mine[0],can_edit:true}); // 관리자도 같은 행(고칠 수 있음만 다름)
 assert.equal(Number(sql(`select count(*) from office_events where id=${quote(e.id)}`)),1);
 assert.deepEqual(Object.keys(saved).sort(),Object.keys(mine[0]).sort()); // 쓰기 결과와 목록이 같은 모양
 // 옮기기(조직→개인)는 주인만 — 관리자가 남의 일정을 개인 공간으로 빼앗지 못한다
 assert.match(writeFail(U.admin,'save',{...e,org_id:null}),/calendar_forbidden/);
 write(U.member,'save',{...e,org_id:null});
 assert.ok(!ids(U.admin).includes(e.id)); assert.equal(row(e.id).visibility,'private');
});

// 이유: 시원 기본값 — 주인과 조직 관리자(owner·admin)만 고친다. 참석자·다른 멤버는 보기만
test('수정 권한: 주인·관리자만, 일반 멤버·참석자는 calendar_forbidden', {skip}, ()=>{
 const e=ev({org_id:ORG,attendees:[U.member2],title:'권한'}); write(U.member,'save',e);
 const by=u=>list(u).events.find(x=>x.id===e.id).can_edit;
 assert.equal(by(U.member),true); assert.equal(by(U.admin),true); assert.equal(by(U.owner),true); assert.equal(by(U.member2),false);
 assert.match(writeFail(U.member2,'save',{...e,title:'참석자가 고침'}),/calendar_forbidden/);
 assert.match(writeFail(U.member2,'delete',{id:e.id}),/calendar_forbidden/);
 const other=ev({org_id:ORG,title:'남의 일정'}); write(U.member2,'save',other);
 assert.match(writeFail(U.member,'save',{...other,title:'멤버가 고침'}),/calendar_forbidden/);
 assert.equal(write(U.admin,'save',{...e,title:'관리자가 고침'}).event.title,'관리자가 고침');
 assert.equal(write(U.owner,'save',{...e,title:'대표가 고침'}).event.title,'대표가 고침');
 assert.equal(row(e.id).owner,U.member); // 관리자가 고쳐도 주인은 그대로
 // 개인 일정은 관리자도 못 고친다
 const p=ev({title:'개인'}); write(U.member,'save',p);
 assert.match(writeFail(U.admin,'save',{...p,title:'x'}),/calendar_forbidden/);
 write(U.admin,'delete',{id:other.id}); assert.equal(row(other.id),null);
});

// 이유: 에이전트는 주인의 일정만 만들고 고친다 — 관리자의 크루가 관리자 권한으로 남의 일정을 바꾸면 안 된다
test('crew가 있으면 관리자라도 남의 일정은 못 고치고, 주인 일정은 고치며 crew 열에 남는다', {skip}, ()=>{
 const e=ev({org_id:ORG,title:'에이전트'}); write(U.member,'save',e);
 assert.match(writeFail(U.admin,'save',{...e,title:'크루가 고침',crew:'admin-crew'}),/calendar_forbidden/);
 assert.match(writeFail(U.admin,'delete',{id:e.id,crew:'admin-crew'}),/calendar_forbidden/);
 assert.equal(row(e.id).title,'에이전트');
 const r=write(U.member,'save',{...e,title:'내 크루가 고침',crew:'my-crew'}).event;
 assert.equal(r.crew,'my-crew'); assert.equal(row(e.id).crew,'my-crew');
 write(U.member,'save',{...e,title:'사람이 고침'}); assert.equal(row(e.id).crew,'my-crew'); // 사람이 고치면 그대로
 const made=write(U.member,'save',{...ev({title:'크루가 만듦'}),crew:'my-crew'}).event;
 assert.equal(made.crew,'my-crew'); assert.equal(made.owner,U.member);
});

// 이유: DB 위생 — 화면이 같은 내용을 다시 저장해도 행을 다시 쓰지 않는다(updated_at·xmin 불변)
test('같은 값 저장은 행을 다시 쓰지 않는다(xmin·updated_at 불변)', {skip}, ()=>{
 const e=ev({org_id:ORG,attendees:[U.member2],rrule:'FREQ=WEEKLY;UNTIL=20261231',exdates:['2026-10-21'],customer_id:C.org,note:'메모',location:'회의실',category:'회의'});
 write(U.member,'save',e); const a=row(e.id);
 write(U.member,'save',e); write(U.member,'save',{...e,crew:'my-crew'}); // 크루가 같은 값을 보내도 고친 게 아니다
 const b=row(e.id); assert.equal(b.xmin,a.xmin); assert.equal(b.updated_at,a.updated_at); assert.equal(b.crew,null);
 write(U.member,'save',{...e,note:'바뀜'}); assert.notEqual(row(e.id).xmin,a.xmin);
});

// 이유: 반복의 한 회차 지우기·'이 일정 및 이후' 수정이 원래 행을 올바르게 줄이고 새 행을 만든다
test('skip은 exdates에 한 번만, split은 원래 행 UNTIL을 전날로·새 행 생성(첫 회차면 원래 행 삭제)', {skip}, ()=>{
 const e=ev({org_id:ORG,title:'주간',starts_at:'2026-10-05T10:00:00+09:00',ends_at:'2026-10-05T11:00:00+09:00',rrule:'FREQ=WEEKLY'}); write(U.member,'save',e);
 write(U.member,'skip',{id:e.id,day:'2026-10-12'}); const a=row(e.id);
 write(U.member,'skip',{id:e.id,day:'2026-10-12'});
 assert.deepEqual(row(e.id).exdates,['2026-10-12']); assert.equal(row(e.id).xmin,a.xmin);
 // 회차 수정 행 → 부모 exdates에 들어가고, 그 뒤 split하면 이후 회차 수정 행은 지워진다
 const o=ev({org_id:ORG,title:'이번만',parent_id:e.id,recur_on:'2026-11-02',starts_at:'2026-11-02T15:00:00+09:00',ends_at:'2026-11-02T16:00:00+09:00'});
 write(U.admin,'save',o); assert.equal(row(o.id).owner,U.member); assert.deepEqual(row(e.id).exdates,['2026-10-12','2026-11-02']);
 const next=ev({org_id:ORG,title:'주간(바뀜)',starts_at:'2026-10-26T14:00:00+09:00',ends_at:'2026-10-26T15:00:00+09:00',rrule:'FREQ=WEEKLY'});
 const n=write(U.admin,'split',{id:e.id,day:'2026-10-26',next}).event;
 assert.equal(row(e.id).rrule,'FREQ=WEEKLY;UNTIL=20261025'); assert.deepEqual(row(e.id).exdates,['2026-10-12']);
 assert.equal(row(o.id),null); assert.equal(n.id,next.id); assert.equal(n.owner,U.member); // 관리자가 나눠도 주인은 원래 주인
 // 첫 회차에서 split = 원래 행 삭제
 const f=ev({org_id:ORG,title:'매일',starts_at:'2026-10-05T09:00:00+09:00',ends_at:'2026-10-05T09:30:00+09:00',rrule:'FREQ=DAILY;UNTIL=20261010'}); write(U.member,'save',f);
 const g=ev({org_id:ORG,title:'매일(바뀜)',starts_at:'2026-10-05T10:00:00+09:00',ends_at:'2026-10-05T10:30:00+09:00',rrule:'FREQ=DAILY;UNTIL=20261010'});
 write(U.member,'split',{id:f.id,day:'2026-10-05',next:g});
 assert.equal(row(f.id),null); assert.equal(row(g.id).title,'매일(바뀜)');
 assert.match(writeFail(U.member,'skip',{id:g.id,day:'2026-09-01'}),/calendar_invalid/); // 시작 전 날짜
});

// 이유: 반복 일정은 시작이 범위 앞이어도 회차가 범위 안에 있으면 목록에 와야 하고, 이미 끝난 반복은 오지 않아야 한다
test('반복 기간: 과거 시작·UNTIL이 범위 안이면 나오고, UNTIL이 범위 앞이면 안 나온다', {skip}, ()=>{
 const inside=ev({title:'UNTIL 범위 안',starts_at:'2026-01-05T10:00:00+09:00',ends_at:'2026-01-05T11:00:00+09:00',rrule:'FREQ=WEEKLY;UNTIL=20261015'});
 const before_=ev({title:'UNTIL 범위 앞',starts_at:'2026-01-05T10:00:00+09:00',ends_at:'2026-01-05T11:00:00+09:00',rrule:'FREQ=WEEKLY;UNTIL=20260930'});
 const open=ev({title:'끝 없음',starts_at:'2025-01-06T10:00:00+09:00',ends_at:'2025-01-06T11:00:00+09:00',rrule:'FREQ=MONTHLY;INTERVAL=2'});
 const past=ev({title:'지난 한 번',starts_at:'2026-09-30T10:00:00+09:00',ends_at:'2026-09-30T11:00:00+09:00'});
 const later=ev({title:'범위 뒤 시작',starts_at:'2026-11-01T00:00:00+09:00',ends_at:'2026-11-01T01:00:00+09:00',rrule:'FREQ=DAILY'});
 for(const x of [inside,before_,open,past,later])write(U.member2,'save',x);
 const got=ids(U.member2);
 assert.ok(got.includes(inside.id)); assert.ok(got.includes(open.id));
 assert.ok(!got.includes(before_.id)); assert.ok(!got.includes(past.id)); assert.ok(!got.includes(later.id));
 // 종일 = KST 자정 기준
 const d=write(U.member2,'save',ev({all_day:true,starts_at:'2026-10-20T00:00:00+09:00',ends_at:'2026-10-22T00:00:00+09:00'})).event;
 assert.equal(d.all_day,true);
 assert.match(writeFail(U.member2,'save',ev({all_day:true,starts_at:'2026-10-20T00:00:00Z',ends_at:'2026-10-21T00:00:00Z'})),/calendar_invalid/);
 assert.match(writeFail(U.member2,'save',ev({rrule:'FREQ=YEARLY'})),/calendar_invalid/);
 assert.match(writeFail(U.member2,'save',ev({rrule:'FREQ=DAILY;UNTIL=20261399'})),/calendar_invalid/);
 assert.match(writeFail(U.member2,'save',ev({starts_at:'2026-10-14T10:00:00'})),/calendar_invalid/); // 오프셋 없는 시각
});

// 이유: 거래처는 일정과 같은 공간 것만 — 남의 조직·다른 공간 거래처 이름이 새지 않게. 참석자도 그 조직 멤버만
test('다른 scope 거래처·비멤버 참석자는 calendar_invalid', {skip}, ()=>{
 const ok=write(U.member,'save',ev({org_id:ORG,customer_id:C.org})).event; assert.equal(ok.customer_name,'조직 거래처');
 assert.equal(write(U.member,'save',ev({customer_id:C.mine})).event.customer_name,'멤버 개인 거래처');
 assert.match(writeFail(U.member,'save',ev({org_id:ORG,customer_id:C.mine})),/calendar_invalid/); // 개인 거래처를 조직 일정에
 assert.match(writeFail(U.member,'save',ev({customer_id:C.org})),/calendar_invalid/);              // 조직 거래처를 개인 일정에
 assert.match(writeFail(U.member,'save',ev({org_id:ORG,customer_id:C.other})),/calendar_invalid/);  // 남의 조직 거래처
 for(const k of ['outsider','guest','gone'])assert.match(writeFail(U.member,'save',ev({org_id:ORG,attendees:[U[k]]})),/calendar_invalid/,k);
});

// 이유: 범위가 크면 한 번에 너무 많이 읽는다(최대 400일). 로그인 안 한 호출은 표에 닿지 않는다
test('범위 400일 초과는 거절, anon 호출은 거절', {skip}, ()=>{
 assert.match(raw(userSql(U.member,`select office_event_list('2026-01-01T00:00:00+09:00','2027-02-06T00:00:00+09:00')`)).stderr,/calendar_invalid/);
 assert.equal(list(U.member,'2026-01-01T00:00:00+09:00','2027-02-05T00:00:00+09:00').orgs.length,1); // 400일은 된다
 for(const q of [`select office_event_list(now(),now()+interval '1 day')`,`select office_event_write('save','{}'::jsonb)`,`select count(*) from office_events`]){
  const r=raw(`set role anon; ${q}`); assert.notEqual(r.status,0,q); assert.match(r.stderr,/permission denied/,q);
 }
 const r=raw(`set role authenticated; select count(*) from office_events`); assert.match(r.stderr,/permission denied/); // 표 직접 읽기 금지
 for(const q of [`select office_event_save('{}'::jsonb,${quote(U.member)},null,null)`,`select office_event_role(${quote(ORG)},${quote(U.member)})`]){
  assert.match(raw(userSql(U.member,q)).stderr,/permission denied/,q); // 내부 함수는 정의자 함수 안에서만
 }
});

// 이유: 같은 사람이 담당자 목록(office_org_people)과 달력에서 다른 이름으로 보이면 안 된다 — 조직 일정은 조직 안 표시 이름 먼저
test('owner_name: 조직 일정은 office_org_people과 같은 이름, 개인 일정은 프로필 이름', {skip}, ()=>{
 const o=write(U.member,'save',ev({org_id:ORG,title:'이름'})).event;
 const people=JSON.parse(last(sql(userSql(U.member,`select office_org_people(${quote(ORG)})`))));
 assert.equal(o.owner_name,people.find(p=>p.user_id===U.member).name); assert.equal(o.owner_name,'member');
 assert.ok(list(U.admin).events.some(e=>e.id===o.id&&e.owner_name==='member'));
 assert.equal(write(U.member,'save',ev({title:'개인 이름'})).event.owner_name,'멤버');
});

// 이유: 종료일(UNTIL) 당일에 시작해 다음 날까지 이어지는 마지막 회차가 범위 첫날에 걸치면 달력에 보여야 한다
test('반복 기간: UNTIL이 범위 시작 전날이어도 마지막 회차가 범위 시작을 넘으면 포함', {skip}, ()=>{
 const night=ev({title:'야간',starts_at:'2026-09-01T22:00:00+09:00',ends_at:'2026-09-02T02:00:00+09:00',rrule:'FREQ=DAILY;UNTIL=20260930'});
 const done=ev({title:'야간 끝남',starts_at:'2026-09-01T22:00:00+09:00',ends_at:'2026-09-02T02:00:00+09:00',rrule:'FREQ=DAILY;UNTIL=20260929'});
 const short=ev({title:'범위 첫날 오전에 끝남',starts_at:'2026-09-01T10:00:00+09:00',ends_at:'2026-09-01T11:00:00+09:00',rrule:'FREQ=DAILY;UNTIL=20261001'});
 for(const x of [night,done,short])write(U.admin,'save',x);
 const got=ids(U.admin);
 assert.ok(got.includes(night.id)); // 9/30 22:00 ~ 10/1 02:00
 assert.ok(!got.includes(done.id)); // 9/29 22:00 ~ 9/30 02:00
 assert.ok(!ids(U.admin,'2026-10-01T12:00:00+09:00','2026-10-02T00:00:00+09:00').includes(short.id)); // 마지막 회차가 범위 시작 전에 끝남
});
