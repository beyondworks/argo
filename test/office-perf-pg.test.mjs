import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 성과 기록 2단계(유건 9/29): 사람 직원의 일과 성과를 매일 자동으로 쌓는 개인 기록.
// 본인만 보고, 월말·연말에 본인이 공유하면 관리자가 그 사본을 보고 메모 → 본인 답·이의 → 평가 완료(잠금).
// 고치기·지우기는 없고 추가만. 성과 한 줄 수정은 관리자가 허용한 고치기 요청으로 한 번, 원본은 남는다.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-perf-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','member2','guest','outsider'].map(k=>[k,randomUUID()]));
let ORG; const F={};
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const userSql=(u,q)=>`set timezone to 'UTC'; set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`; // 운영 Supabase와 같은 UTC 세션 — 한국 날짜 계산이 세션 시간대에 기대지 않는지 본다
const last=s=>s.split('\n').filter(Boolean).at(-1);
const call=(u,fn,args)=>JSON.parse(last(sql(userSql(u,`select ${fn}(${args})`))));
const callFail=(u,fn,args)=>{const r=raw(userSql(u,`select ${fn}(${args})`)); assert.notEqual(r.status,0,`${fn} should fail`); return r.stderr;};
const j=d=>`${quote(JSON.stringify(d))}::jsonb`;
const report=(u,from,to)=>call(u,'office_perf_report',`${quote(ORG)},${quote(from)}::date,${quote(to)}::date`);
const write=(u,a,d)=>call(u,'office_perf_write',`${quote(ORG)},${quote(a)},${j(d)}`);
const writeFail=(u,a,d)=>callFail(u,'office_perf_write',`${quote(ORG)},${quote(a)},${j(d)}`);
const manage=(u,a,d)=>call(u,'office_perf_manage',`${quote(ORG)},${quote(a)},${j(d)}`);
const manageFail=(u,a,d)=>callFail(u,'office_perf_manage',`${quote(ORG)},${quote(a)},${j(d)}`);
const team=(u,period)=>call(u,'office_perf_team',`${quote(ORG)},${quote(period)}`);
const bwrite=(a,d,u=U.owner)=>call(u,'office_business_write',`${quote(ORG)},${quote(randomUUID())},${quote(a)},${j(d)}`).id;
const task=(u,a,d)=>call(u,'office_task_write',`${quote(ORG)},${quote(a)},${j(d)}`);
// 한국 날짜 기준 지난달·이번 달
const kst=d=>new Date(d.getTime()+9*3600e3).toISOString().slice(0,10);
const TODAY=kst(new Date());
const THIS=TODAY.slice(0,7);
const LAST=(()=>{const [y,m]=THIS.split('-').map(Number); return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;})();
const endOf=p=>{const [y,m]=p.split('-').map(Number); return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
const at=(day,hh='12')=>`${day}T${hh}:00:00+09:00`;

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
 const files=['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260909003000_msgr_message_meta.sql','20260927144230_office_business.sql','20260927170000_office_pages.sql','20260927171000_office_mail.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20260929190000_office_perf.sql','20260930150000_office_perf_tie_order.sql'];
 for(const f of files){const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);}
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Perf','perf',${quote(U.owner)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest'])sql(`insert into msgr_org_members(org_id,user_id,role,display_name)values(${quote(ORG)},${quote(U[k])},${quote(k==='member2'?'member':k)},${quote(k)})`);
 // 지난달 기록: 직원이 담당한 거래(계약 300만 공급 + 세액) → 청구·입금, 다른 거래는 계약 뒤 취소, 공동 담당 거래 1건
 const c=bwrite('customer.save',{name:'고객',email:'',notes:''}), i=bwrite('item.save',{name:'구축',kind:'service',sku:'',price:1000});
 const deal=(title,price)=>bwrite('order.create',{customer_id:c,title,lines:[{item_id:i,quantity:1,unit_price:price}]});
 F.won=deal('수주',3000000); F.lost=deal('취소',1000000); F.shared=deal('공동',2000000); F.other=deal('남의 거래',9000000);
 for(const o of [F.won,F.lost,F.shared,F.other])bwrite('order.confirm',{id:o});
 bwrite('entry.create',{order_id:F.won,kind:'invoice',amount:3300000,note:''}); bwrite('entry.create',{order_id:F.won,kind:'payment',amount:3300000,note:''});
 bwrite('order.cancel',{id:F.lost,note:'고객 사정'});
 sql(userSql(U.owner,`select office_business_owners_set(${quote(ORG)},${quote(F.won)},array[${quote(U.member)}]::uuid[],'담당'); select office_business_owners_set(${quote(ORG)},${quote(F.lost)},array[${quote(U.member)}]::uuid[],'담당'); select office_business_owners_set(${quote(ORG)},${quote(F.shared)},array[${quote(U.member)},${quote(U.member2)}]::uuid[],'공동')`));
 // 모든 거래 기록을 지난달 10일로 옮긴다(시험용 — 실제로는 기록 시각이 곧 그날)
 const d10=`${LAST}-10`;
 sql(`update office_business_activity set at=(${quote(d10)}::date + case kind when 'quote' then time '10:00' when 'contract' then time '11:00' when 'cancel' then time '12:00' else time '12:30' end) at time zone 'Asia/Seoul' where order_id in (${[F.won,F.lost,F.shared,F.other].map(quote).join(',')}); update office_business_entries set at=${quote(at(d10,'13'))} where order_id=${quote(F.won)}`);
 // 할 일: 지난달이 기한인 일 4개 — 기한 안 2, 늦게 1, 못 끝냄 1, 취소 1(계산에서 빠짐), 기한 없는 일 1(빠짐)
 const mk=(title,due)=>{const id=randomUUID(); task(U.member,'task.create',{id,title,due_on:due}); return id;};
 F.t1=mk('제때1',`${LAST}-05`); F.t2=mk('제때2',`${LAST}-20`); F.t3=mk('늦음',`${LAST}-08`); F.t4=mk('못함',`${LAST}-15`); F.t5=mk('취소',`${LAST}-15`); F.t6=mk('기한없음',null);
 for(const t of [F.t1,F.t2,F.t3,F.t6])task(U.member,'task.done',{id:t});
 task(U.member,'task.cancel',{id:F.t5});
 sql(`update office_tasks set done_at=${quote(at(`${LAST}-05`,'23'))} where id=${quote(F.t1)}; update office_tasks set done_at=${quote(at(`${LAST}-19`))} where id=${quote(F.t2)}; update office_tasks set done_at=${quote(`${LAST}-09T00:30:00+09:00`)} where id=${quote(F.t3)}; update office_tasks set done_at=${quote(at(`${LAST}-11`))} where id=${quote(F.t6)}`);
});

test('자동 집계: 담당 거래 계약·청구·입금, 계약 뒤 취소는 −, 공동 담당은 각자 전액 + 공동 인원', {skip}, ()=>{
 const r=report(U.member,`${LAST}-01`,endOf(LAST));
 assert.equal(r.totals.contract,3000000+1000000-1000000+2000000); // 수주 + 취소(+ 뒤 −) + 공동
 assert.equal(r.totals.invoiced,3300000);
 assert.equal(r.totals.paid,3300000);
 const lost=r.deals.filter(d=>d.order_id===F.lost).map(d=>[d.kind,d.amount]);
 assert.deepEqual(lost.sort(),[['contract',1000000],['uncontract',-1000000]].sort());
 assert.equal(r.deals.find(d=>d.order_id===F.shared).co,2);
 assert.ok(!r.deals.some(d=>d.order_id===F.other)); // 남의 거래는 안 셈
 const other=report(U.member2,`${LAST}-01`,endOf(LAST));
 assert.equal(other.totals.contract,2000000); // 공동 담당자도 같은 금액
});

// 이유(유건 9/30 운영 제보): 인트라넷 이관처럼 날짜만 있는 기록은 계약과 취소가 같은 시각이 된다 — 이름순 정렬이면
// 'cancel'이 'contract'보다 먼저 처리돼 취소가 무시됐다(운영 9월 계약 3,120만 = 분석 1,620만 + 취소된 1,500만).
test('자동 집계: 계약과 취소가 같은 시각이어도 취소가 계약을 되돌린다', {skip}, ()=>{
 const same=at(`${LAST}-10`,'12');
 sql(`update office_business_activity set at=${quote(same)} where order_id=${quote(F.lost)} and kind in ('contract','cancel')`);
 try {
  const r=report(U.member,`${LAST}-01`,endOf(LAST));
  assert.equal(r.totals.contract,3000000+2000000); // 수주 + 공동, 취소 거래는 0
  assert.deepEqual(r.deals.filter(d=>d.order_id===F.lost).map(d=>[d.kind,d.amount]).sort(),[['contract',1000000],['uncontract',-1000000]].sort());
 } finally {
  sql(`update office_business_activity set at=(${quote(`${LAST}-10`)}::date + case kind when 'contract' then time '11:00' else time '12:00' end) at time zone 'Asia/Seoul' where order_id=${quote(F.lost)} and kind in ('contract','cancel')`);
 }
});

test('자동 집계: 기한 준수율 = 기한 안에 끝낸 일 ÷ 그달 기한인 일, 달성률 = 끝낸 일 ÷ 그달 기한인 일 — 취소·기한 없는 일은 빠진다', {skip}, ()=>{
 const r=report(U.member,`${LAST}-01`,endOf(LAST));
 assert.deepEqual({due:r.totals.tasks_due,done:r.totals.tasks_done_due,on_time:r.totals.tasks_on_time},{due:4,done:3,on_time:2});
 assert.equal(r.totals.tasks_done,4); // 그 기간에 끝낸 일(기한 없는 일 포함)
 // 한국 날짜 기준: 5일 23시(한국)에 끝낸 일은 5일 기한 안
 assert.ok(r.tasks.find(t=>t.id===F.t1).on_time);
 assert.equal(r.tasks.find(t=>t.id===F.t3).on_time,false);
});

test('본인만: 관리자가 불러도 자기 기록만 — 남의 기록을 여는 인자는 없다, 손님·밖의 사람은 못 부른다', {skip}, ()=>{
 const r=report(U.admin,`${LAST}-01`,endOf(LAST));
 assert.equal(r.totals.contract,0); assert.equal(r.totals.tasks_due,0);
 assert.match(callFail(U.guest,'office_perf_report',`${quote(ORG)},${quote(`${LAST}-01`)}::date,${quote(endOf(LAST))}::date`),/forbidden/);
 assert.match(callFail(U.outsider,'office_perf_report',`${quote(ORG)},${quote(`${LAST}-01`)}::date,${quote(endOf(LAST))}::date`),/forbidden/);
 // 공유 전에는 팀 화면에 숫자가 없다
 const t=team(U.admin,LAST); const m=t.members.find(x=>x.user_id===U.member);
 assert.equal(m.review,null); assert.equal(t.reviews.length,0);
 assert.match(callFail(U.member,'office_perf_team',`${quote(ORG)},${quote(LAST)}`),/forbidden/);
 // 표를 직접 읽는 길은 없다
 for(const tb of ['office_perf_notes','office_perf_reviews','office_perf_comments','office_perf_goals','office_perf_edit_requests'])assert.notEqual(raw(userSql(U.admin,`select count(*) from ${tb}`)).status,0);
});

test('성과 한 줄: 추가만 — 고치기는 관리자가 허용한 요청으로 한 번, 원본은 남고 수정 표시', {skip}, ()=>{
 const n=randomUUID();
 write(U.member,'note.add',{id:n,body:'대형 고객 계약 성사',day:TODAY});
 assert.equal(report(U.member,TODAY,TODAY).notes.find(x=>x.id===n).body,'대형 고객 계약 성사');
 assert.notEqual(raw(userSql(U.member,`update office_perf_notes set body='x' where id=${quote(n)}`)).status,0);
 assert.match(writeFail(U.member,'note.edit',{id:randomUUID(),request_id:randomUUID(),body:'x'}),/perf_request/);
 const rq=randomUUID(); write(U.member,'edit.request',{id:rq,note_id:n,reason:'고객사 이름 오타'});
 assert.match(writeFail(U.member,'note.edit',{id:randomUUID(),request_id:rq,body:'x'}),/perf_request/); // 아직 허용 전
 const pending=team(U.admin,THIS).requests; // 관리자는 그 한 줄과 사유만 본다
 assert.deepEqual(pending.map(p=>[p.id,p.body,p.reason]),[[rq,'대형 고객 계약 성사','고객사 이름 오타']]);
 assert.match(manageFail(U.member,'edit.decide',{id:rq,approve:true}),/forbidden/);
 manage(U.admin,'edit.decide',{id:rq,approve:true});
 const n2=randomUUID(); write(U.member,'note.edit',{id:n2,request_id:rq,body:'대형 고객(한빛) 계약 성사'});
 assert.match(writeFail(U.member,'note.edit',{id:randomUUID(),request_id:rq,body:'두 번째'}),/perf_request/); // 한 번만
 const notes=report(U.member,TODAY,TODAY).notes;
 assert.ok(!notes.some(x=>x.id===n));             // 목록에는 고친 것만
 const edited=notes.find(x=>x.id===n2);
 assert.equal(edited.edited,true); assert.equal(edited.original,'대형 고객 계약 성사'); // 원본 내용이 함께 남는다
 assert.equal(sql(`select count(*) from office_perf_notes where id in (${quote(n)},${quote(n2)})`),'2');
});

test('공유: 끝나지 않은 달은 못 한다 — 공유하면 그 시점 사본이 관리자에게 열린다', {skip}, ()=>{
 assert.match(writeFail(U.member,'review.share',{period:THIS}),/perf_period/);
 manage(U.admin,'review.request',{user_id:U.member,period:LAST});
 assert.equal(team(U.admin,LAST).members.find(x=>x.user_id===U.member).review.status,'requested');
 assert.equal(report(U.member,`${LAST}-01`,endOf(LAST)).reviews.find(r=>r.period===LAST).status,'requested'); // 본인에게 요청이 보인다
 write(U.member,'review.share',{period:LAST});
 const t=team(U.admin,LAST); const rv=t.reviews.find(r=>r.user_id===U.member);
 assert.equal(rv.status,'shared');
 assert.equal(rv.snapshot.totals.contract,5000000);
 assert.equal(rv.snapshot.totals.tasks_on_time,2);
 // 공유한 뒤 새 기록이 생겨도 사본은 그대로
 sql(`update office_tasks set done_at=null where id=${quote(F.t4)}`);
 assert.equal(team(U.admin,LAST).reviews.find(r=>r.user_id===U.member).snapshot.totals.tasks_done_due,3);
 assert.match(writeFail(U.member,'review.share',{period:LAST}),/perf_shared/);
 F.review=rv.id;
});

test('메모 → 답·이의 → 평가 완료로 잠금', {skip}, ()=>{
 assert.match(manageFail(U.admin,'comment.add',{review_id:randomUUID(),body:'x'}),/perf_review/);
 manage(U.admin,'comment.add',{review_id:F.review,body:'계약 성과 좋음, 기한 준수 개선 필요'});
 write(U.member,'comment.add',{period:LAST,kind:'reply',body:'다음 달 개선하겠습니다'});
 write(U.member,'comment.add',{period:LAST,kind:'objection',body:'8일 기한 일은 고객 자료가 늦게 왔습니다'});
 assert.match(writeFail(U.member2,'comment.add',{period:LAST,kind:'reply',body:'남의 평가'}),/perf_review/); // 자기 평가에만
 const mine=report(U.member,`${LAST}-01`,endOf(LAST)).reviews.find(r=>r.period===LAST);
 assert.deepEqual(mine.comments.map(c=>c.kind),['memo','reply','objection']);
 manage(U.admin,'review.done',{review_id:F.review});
 assert.equal(team(U.admin,LAST).reviews.find(r=>r.id===F.review).status,'done');
 assert.match(writeFail(U.member,'comment.add',{period:LAST,kind:'reply',body:'잠긴 뒤'}),/perf_locked/);
 assert.match(manageFail(U.admin,'comment.add',{review_id:F.review,body:'잠긴 뒤'}),/perf_locked/);
});

test('목표: 해마다 3개까지, 숫자 목표는 진행률 자동 — 바꾸면 이전 내용이 이력에 남는다', {skip}, ()=>{
 const y=Number(LAST.slice(0,4));
 const g=randomUUID();
 write(U.member,'goal.save',{id:g,year:y,position:1,title:'계약 1천만 원',metric:'contract',target:10000000});
 write(U.member,'goal.save',{id:randomUUID(),year:y,position:2,title:'기한 지키기 90%',metric:'on_time',target:90});
 write(U.member,'goal.save',{id:randomUUID(),year:y,position:3,title:'고객 사례 글 쓰기',metric:null,target:null});
 assert.match(writeFail(U.member,'goal.save',{id:randomUUID(),year:y,position:4,title:'넷째',metric:null,target:null}),/perf_input/);
 const r=report(U.member,`${y}-01-01`,`${y}-12-31`);
 const goal=r.goals.find(x=>x.id===g);
 assert.ok(goal.value>=5000000); // 지난달 계약만으로 5백만 이상
 write(U.member,'goal.save',{id:g,year:y,position:1,title:'계약 2천만 원',metric:'contract',target:20000000});
 assert.equal(sql(`select count(*) from office_perf_goal_history where goal_id=${quote(g)}`),'1');
 assert.equal(report(U.member,`${y}-01-01`,`${y}-12-31`).goals.find(x=>x.id===g).target,20000000);
 // 목표에 성과 한 줄을 연결한다(글 목표)
 const text=report(U.member,`${y}-01-01`,`${y}-12-31`).goals.find(x=>x.position===3);
 write(U.member,'note.add',{id:randomUUID(),body:'사례 글 초안 완성',day:TODAY,goal_id:text.id});
 assert.equal(report(U.member,`${y}-01-01`,`${y}-12-31`).goals.find(x=>x.position===3).notes,1);
 assert.equal(report(U.member2,`${y}-01-01`,`${y}-12-31`).goals.length,0); // 남의 목표는 안 보인다
});

test('퇴사 3년 보관: 정리 함수는 대상만 세고(시험 실행), 실제 정리는 3년이 지난 사람만', {skip}, ()=>{
 sql(`insert into office_perf_notes(id,org_id,user_id,day,body)values(gen_random_uuid(),${quote(ORG)},${quote(U.member2)},${quote(TODAY)},'나간 사람 기록')`);
 sql(`update msgr_org_members set removed_at=now()-interval '2 years' where user_id=${quote(U.member2)}`);
 assert.equal(JSON.parse(sql(`select office_perf_purge(true)`)).notes,0);
 sql(`update msgr_org_members set removed_at=now()-interval '3 years 1 day' where user_id=${quote(U.member2)}`);
 assert.equal(JSON.parse(sql(`select office_perf_purge(true)`)).notes,1);
 assert.equal(sql(`select count(*) from office_perf_notes where user_id=${quote(U.member2)}`),'1'); // 시험 실행은 지우지 않는다
 assert.notEqual(raw(userSql(U.owner,`select office_perf_purge(false)`)).status,0); // 사용자는 못 부른다
});

// 분리 검수 MEDIUM: 평가 완료로 잠긴 달의 성과 한 줄은 고치기 요청·허용·고치기 경로로도 바뀌면 안 된다(추가만 막고 이 길이 열려 있었다)
test('잠긴 기간: 고치기 요청·허용·고치기도 막힌다', {skip}, ()=>{
 const n=randomUUID(), q=randomUUID();
 sql(`insert into office_perf_notes(id,org_id,user_id,day,body)values(${quote(n)},${quote(ORG)},${quote(U.member)},${quote(`${LAST}-15`)},'잠기기 전 한 줄')`);
 assert.match(writeFail(U.member,'edit.request',{id:randomUUID(),note_id:n,reason:'완료 뒤 수정'}),/perf_locked/);
 // 잠기기 전에 들어와 있던 요청도 허용·사용할 수 없다
 sql(`insert into office_perf_edit_requests(id,org_id,user_id,note_id,reason)values(${quote(q)},${quote(ORG)},${quote(U.member)},${quote(n)},'미리 낸 요청')`);
 assert.match(manageFail(U.admin,'edit.decide',{id:q,approve:true}),/perf_locked/);
 sql(`update office_perf_edit_requests set status='approved' where id=${quote(q)}`);
 assert.match(writeFail(U.member,'note.edit',{id:randomUUID(),request_id:q,body:'완료된 평가의 원본을 고침'}),/perf_locked/);
 assert.match(writeFail(U.member,'note.add',{id:randomUUID(),body:'잠긴 달에 추가',day:`${LAST}-16`}),/perf_locked/);
});

// 3단계: 거래처 메일 만족도 — 서버 함수가 Gmail 메타데이터로 계산해 판정·근거 종류·메일 id만 넣는다(본문·제목 없음)
test('메일 신호: 내 메일 계정·우리 거래처만, 판정은 DB가 근거 종류로 다시 정하고, 6시간에 한 번만 돈다', {skip}, ()=>{
 const acc=last(sql(`insert into office_mail_accounts(user_id,provider,address)values(${quote(U.member)},'google','member@beyond.test') returning id`));
 const other=last(sql(`insert into office_mail_accounts(user_id,provider,address)values(${quote(U.member2)},'google','m2@beyond.test') returning id`));
 sql(`update office_business_customers set email='buyer@client.test' where name='고객'`);
 const cust=JSON.parse(last(sql(userSql(U.member,`select office_perf_customers(${quote(ORG)})`))));
 assert.ok(cust.some(c=>c.name==='고객'));
 const cid=cust.find(c=>c.name==='고객').id;
 const put=(u,a,rows)=>call(u,'office_perf_mail_put',`${quote(ORG)},${quote(a)},${j(rows)}`);
 const row=(t,reasons,day=TODAY)=>({thread_id:t,customer_id:cid,day,reasons,reply_minutes:60,last_message_id:`m-${t}`,grade:'good'});
 const claim=()=>last(sql(userSql(U.member,`select office_perf_mail_claim(${quote(ORG)})`)));
 assert.equal(claim(),'t');
 assert.equal(claim(),'f'); // 6시간 안에 다시 부르면 건너뛴다
 put(U.member,acc,[row('t1',['thanks','replied']),row('t2',['pushy'])]);
 const r=report(U.member,TODAY,TODAY);
 assert.deepEqual({g:r.totals.mail_good,c:r.totals.mail_caution,n:r.totals.mail_normal},{g:1,c:1,n:0});
 assert.equal(r.mail.find(m=>m.thread_id==='t2').grade,'caution'); // 클라이언트가 grade:'good'을 보내도 근거로 다시 판정
 assert.ok(!('subject' in r.mail[0]) && !('snippet' in r.mail[0]));
 // 남의 메일 계정·없는 거래처·모르는 근거·미래 날짜는 거절
 assert.match(callFail(U.member,'office_perf_mail_put',`${quote(ORG)},${quote(other)},${j([row('x',['thanks'])])}`),/perf_forbidden|perf_input/);
 assert.match(callFail(U.member,'office_perf_mail_put',`${quote(ORG)},${quote(acc)},${j([{...row('x',['thanks']),customer_id:randomUUID()}])}`),/perf_input/);
 assert.match(callFail(U.member,'office_perf_mail_put',`${quote(ORG)},${quote(acc)},${j([row('x',['hacked'])])}`),/perf_input/);
 assert.match(callFail(U.member,'office_perf_mail_put',`${quote(ORG)},${quote(acc)},${j([row('x',['thanks'],'2999-01-01')])}`),/perf_input/);
 // 같은 값이면 다시 쓰지 않는다(xmin 불변), 바뀌면 고친다
 const x1=sql(`select xmin from office_perf_mail where thread_id='t1'`);
 put(U.member,acc,[row('t1',['thanks','replied'])]);
 assert.equal(sql(`select xmin from office_perf_mail where thread_id='t1'`),x1);
 put(U.member,acc,[row('t1',['replied'])]);
 assert.equal(report(U.member,TODAY,TODAY).mail.find(m=>m.thread_id==='t1').grade,'normal');
 // 잠긴 기간에 속한 스레드는 새로 넣거나 고치지 않는다(평가 완료된 LAST)
 put(U.member,acc,[row('old',['pushy'],`${LAST}-20`)]);
 assert.equal(sql(`select count(*) from office_perf_mail where thread_id='old'`),'0');
 assert.equal(report(U.admin,TODAY,TODAY).totals.mail_good,0); // 남의 기록에는 안 섞인다(member2는 앞 테스트에서 퇴사 처리됨)
});

test('메신저 요청: 나를 멘션한 글·1:1 대화에 얼마나 빨리 답했나, 24시간 넘게 답이 없으면 미응답, 할 일로 만들어 끝냈으면 완료', {skip}, ()=>{
 const ch=last(sql(`insert into msgr_channels(org_id,kind,name,created_by)values(${quote(ORG)},'public','general',${quote(U.owner)}) returning id`));
 const ch2=last(sql(`insert into msgr_channels(org_id,kind,name,created_by)values(${quote(ORG)},'public','ops',${quote(U.owner)}) returning id`));
 // 같은 채널에서는 요청 뒤 내 첫 글을 답으로 본다(스레드 없는 채널은 어느 요청의 답인지 가를 수 없다) — 미응답 요청은 다른 채널에
 const msg=(author,body,at,mention,c=ch)=>last(sql(`insert into msgr_messages(org_id,channel_id,author_kind,author_user_id,body,mentions,created_at)values(${quote(ORG)},${quote(c)},'user',${quote(author)},${quote(body)},${quote(JSON.stringify(mention?[{kind:'user',id:mention}]:[]))}::jsonb,${quote(at)}) returning id`));
 const now=Date.now(), iso=ms=>new Date(ms).toISOString();
 const r1=msg(U.admin,'견적 확인 부탁',iso(now-5*3600e3),U.member); msg(U.member,'확인했습니다',iso(now-4*3600e3),null);  // 60분 만에 답
 const r2=msg(U.admin,'계약서 검토해 주세요',iso(now-30*3600e3),U.member,ch2);                                               // 답 없음, 30시간
 msg(U.admin,'그냥 공지',iso(now-3*3600e3),null);                                                                           // 멘션 없음 — 요청 아님
 const t=randomUUID(); task(U.member,'task.create',{id:t,title:'계약서 검토',due_on:null,source:{kind:'msgr',message_id:String(r2)}}); task(U.member,'task.done',{id:t});
 const r=report(U.member,kst(new Date(now-2*86400e3)),TODAY);
 assert.equal(r.totals.req_count,2); assert.equal(r.totals.req_answered,1); assert.equal(r.totals.req_unanswered,1); assert.equal(r.totals.req_done,1);
 assert.equal(r.totals.req_minutes,60);
 assert.equal(r.asks.find(q=>String(q.id)===String(r1)).minutes,60);
 assert.ok(report(U.member,kst(new Date(now-2*86400e3)),TODAY).requests.every(q=>'note_id' in q)); // 고치기 요청 목록과 이름이 겹치지 않는다
});

// 진행 중인 기간: 기한이 아직 안 지난 일은 준수율·달성률 분모에 넣지 않는다(내일 기한인 일이 0%로 보이던 문제, 9/29 화면 확인)
test('기한이 아직 안 지난 미완료 일은 분모에서 빠진다 — 미리 끝낸 일은 들어간다', {skip}, ()=>{
 const tomorrow=kst(new Date(Date.now()+86400e3)), after=kst(new Date(Date.now()+2*86400e3));
 const a=randomUUID(), b=randomUUID();
 task(U.admin,'task.create',{id:a,title:'내일 기한',due_on:tomorrow});
 task(U.admin,'task.create',{id:b,title:'모레 기한 미리 끝냄',due_on:after}); task(U.admin,'task.done',{id:b});
 const r=report(U.admin,TODAY,after);
 assert.deepEqual({due:r.totals.tasks_due,done:r.totals.tasks_done_due,on:r.totals.tasks_on_time},{due:1,done:1,on:1});
});

// 분리 검수 HIGH: 내가 읽을 수 없는 채널(비공개 채널·남의 1:1)의 멘션은 요청으로 세지 않는다 — 글 id·날짜가 내 기록·공유 사본으로 새면 안 된다
test('메신저 요청: 내가 없는 비공개 채널의 멘션은 세지 않는다', {skip}, ()=>{
 const before=report(U.member,kst(new Date(Date.now()-86400e3)),TODAY).totals.req_count;
 const pch=last(sql(`insert into msgr_channels(org_id,kind,name,created_by)values(${quote(ORG)},'private','비밀',${quote(U.owner)}) returning id`));
 sql(`insert into msgr_messages(org_id,channel_id,author_kind,author_user_id,body,mentions)values(${quote(ORG)},${quote(pch)},'user',${quote(U.owner)},'비밀 멘션',${quote(JSON.stringify([{kind:'user',id:U.member}]))}::jsonb)`);
 assert.equal(report(U.member,kst(new Date(Date.now()-86400e3)),TODAY).totals.req_count,before);
});

// 분리 검수 MEDIUM(알려진 한계 완화): 판정은 6시간 제한을 막 통과한 직후(2분 안)에만 넣을 수 있다 — 아무 때나 직접 불러 꾸며 넣지 못하게
test('메일 신호: 제한 통과 뒤 2분이 지나면 넣을 수 없다', {skip}, ()=>{
 const acc=last(sql(`select id from office_mail_accounts where address='member@beyond.test'`));
 const cid=last(sql(`select id from office_business_customers where name='고객'`));
 sql(`update office_perf_mail_sync set synced_at=now()-interval '3 minutes' where user_id=${quote(U.member)}`);
 assert.match(callFail(U.member,'office_perf_mail_put',`${quote(ORG)},${quote(acc)},${j([{thread_id:'late',customer_id:cid,day:TODAY,reasons:['thanks'],reply_minutes:1,last_message_id:'m-late'}])}`),/perf_claim/);
});

test('문서 실적: 문서 버전이 90일 정리로 지워져도 성과 기록의 "고친 문서"는 남는다 — 연간 정리(연봉 협상)가 90일 뒤 비지 않게', {skip}, ()=>{
 const D=kst(new Date(Date.now()-100*864e5)), page=randomUUID();
 sql(`insert into office_pages(id,space_kind,owner_user_id,org_id,title,created_by)values(${quote(page)},'org',${quote(U.member)},${quote(ORG)},'제안서',${quote(U.member)});
  insert into office_page_versions(page_id,version,title,created_by,created_at)values(${quote(page)},1,'제안서',${quote(U.member)},${quote(at(D,'10'))}),(${quote(page)},2,'제안서',${quote(U.member)},${quote(at(D,'15'))})`);
 const before=report(U.member,D,D).pages;
 assert.deepEqual(before.map(p=>[p.day,p.page_id,p.title]),[[D,page,'제안서']]); // 같은 날 두 번 고쳐도 한 줄
 sql(`select office_purge()`);
 assert.equal(sql(`select count(*) from office_page_versions where page_id=${quote(page)}`),'0'); // 90일 정리는 그대로 돈다
 assert.deepEqual(report(U.member,D,D).pages.map(p=>[p.day,p.page_id,p.title]),[[D,page,'제안서']]);
 assert.notEqual(raw(userSql(U.member,`select count(*) from office_perf_page_days`)).status,0); // 표를 직접 읽는 길은 없다
});
