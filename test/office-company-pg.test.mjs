import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 트랙 C(유건 10/2): 회사 정보·직원 명부·평가 레포트·이관 전용 할 일 — 조직 경계와 성과 기록 규칙(본인만 보기·추가만)을 실제 Postgres에서 본다.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-company-pg.test.mjs';
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
const cread=(u,org=ORG)=>call(u,'office_company_read',quote(org));
const cwrite=(u,a,d,org=ORG)=>call(u,'office_company_write',`${quote(org)},${quote(a)},${j(d)}`);
const cwriteFail=(u,a,d)=>callFail(u,'office_company_write',`${quote(ORG)},${quote(a)},${j(d)}`);
const pread=u=>call(u,'office_people_read',quote(ORG));
const pwrite=(u,a,d)=>call(u,'office_people_write',`${quote(ORG)},${quote(a)},${j(d)}`);
const elist=u=>call(u,'office_perf_eval_list',quote(ORG));
const ewrite=(u,d)=>call(u,'office_perf_eval_write',`${quote(ORG)},'eval.add',${j(d)}`);
const ewriteFail=(u,d)=>callFail(u,'office_perf_eval_write',`${quote(ORG)},'eval.add',${j(d)}`);
const kst=d=>new Date(d.getTime()+9*3600e3).toISOString().slice(0,10);
const TODAY=kst(new Date());
const THIS=TODAY.slice(0,7);
const LAST=(()=>{const [y,m]=THIS.split('-').map(Number); return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;})();
const endOf=p=>{const [y,m]=p.split('-').map(Number); return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};

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
 const files=['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql','20260903120000_msgr.sql','20260909002000_msgr_profiles_friends.sql','20260909003000_msgr_message_meta.sql','20260927144230_office_business.sql','20260927170000_office_pages.sql','20260927171000_office_mail.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql','20260929190000_office_perf.sql','20260930150000_office_perf_tie_order.sql','20261002130000_office_company.sql'];
 for(const f of files){const r=psqlSpawn(DB,['-f',fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url))]);if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);}
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Co','co',${quote(U.owner)}) returning id`)));
 ORG2=last(sql(userSql(U.outsider,`insert into msgr_orgs(name,slug,owner_user_id)values('Other','other',${quote(U.outsider)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role,display_name)values(${quote(ORG)},${quote(U[k])},${quote(k==='member2'||k==='gone'?'member':k)},${quote(k)})`);
 sql(`update msgr_org_members set removed_at=now() where user_id=${quote(U.gone)}`);
});

test('회사 정보: 멤버는 읽기만, 관리자만 쓰기, 손님·밖의 사람은 읽기도 못 한다', {skip}, ()=>{
 const id=randomUUID();
 const r=cwrite(U.admin,'item.save',{id,key:'name',category:'basic',label:'상호',value:'(주)예시'});
 assert.equal(r.item.value,'(주)예시');
 assert.equal(cread(U.member).items.find(x=>x.id===id).label,'상호');
 assert.equal(cread(U.member).role,'member');
 assert.match(cwriteFail(U.member,'item.save',{id:randomUUID(),label:'x'}),/company_forbidden/);
 assert.match(callFail(U.guest,'office_company_read',quote(ORG)),/company_forbidden/);
 assert.match(callFail(U.outsider,'office_company_read',quote(ORG)),/company_forbidden/);
 assert.match(callFail(U.gone,'office_company_read',quote(ORG)),/company_forbidden/,'나간 사람');
 assert.match(callFail(U.outsider,'office_company_write',`${quote(ORG2)},'item.save',${j({id,label:'훔치기'})}`),/company_conflict/,'다른 조직의 id는 못 덮는다');
});

test('회사 정보: 같은 값은 다시 쓰지 않고, 바꾸면 이전 모습이 이력에, 지운 항목은 되살린다', {skip}, ()=>{
 const id=randomUUID();
 cwrite(U.owner,'item.save',{id,category:'bank',label:'주거래 계좌',value:'국민 123-45'});
 const before=sql(`select updated_at from office_company_items where id=${quote(id)}`);
 cwrite(U.owner,'item.save',{id,category:'bank',label:'주거래 계좌',value:'국민 123-45'});
 assert.equal(sql(`select updated_at from office_company_items where id=${quote(id)}`),before,'같은 값 = 쓰기 0');
 assert.equal(sql(`select count(*) from office_company_history where item_id=${quote(id)}`),'0');
 assert.equal(cread(U.owner).items.find(x=>x.id===id).redacted,true,'계좌는 처음부터 가림');
 cwrite(U.owner,'item.save',{id,category:'bank',label:'주거래 계좌',value:'신한 999'});
 assert.equal(JSON.parse(sql(`select before from office_company_history where item_id=${quote(id)} and kind='update'`)).value,'국민 123-45');
 cwrite(U.owner,'item.delete',{id});
 cwrite(U.owner,'item.delete',{id}); // 두 번 눌려도 한 번
 const del=cread(U.owner).deleted.find(x=>x.label==='주거래 계좌');
 assert.ok(del);
 assert.deepEqual(cread(U.member).deleted,[],'멤버에게는 지운 항목 목록이 없다');
 cwrite(U.owner,'item.restore',{history_id:del.history_id});
 assert.equal(cread(U.owner).items.find(x=>x.id===id).value,'신한 999');
 assert.ok(!cread(U.owner).deleted.some(x=>x.history_id===del.history_id),'되살린 항목은 목록에서 빠진다');
});

test('회사 정보: 잘 알려진 항목(key)은 조직에 하나, 순서는 바뀐 것만 쓴다', {skip}, ()=>{
 assert.match(cwriteFail(U.owner,'item.save',{id:randomUUID(),key:'name',label:'상호2'}),/company_key/);
 assert.match(cwriteFail(U.owner,'item.save',{id:randomUUID(),key:'nope',label:'x'}),/company_input/);
 assert.match(cwriteFail(U.owner,'item.save',{id:randomUUID(),label:''}),/company_input/);
 const a=randomUUID(), b=randomUUID();
 cwrite(U.owner,'item.save',{id:a,category:'contact',label:'대표 전화',value:'02-1'});
 cwrite(U.owner,'item.save',{id:b,category:'contact',label:'팩스',value:'02-2'});
 cwrite(U.owner,'items.order',{ids:[b,a]});
 const list=cread(U.owner).items.filter(x=>x.category==='contact').map(x=>x.id);
 assert.deepEqual(list,[b,a]);
 const xmin=sql(`select xmin from office_company_items where id=${quote(b)}`);
 cwrite(U.owner,'items.order',{ids:[b,a]});
 assert.equal(sql(`select xmin from office_company_items where id=${quote(b)}`),xmin,'같은 순서면 행을 다시 쓰지 않는다');
});

test('직원 명부: 계정 멤버는 행이 없어도 나오고, 메모·계정 이메일은 관리자만, 쓰기는 관리자만', {skip}, ()=>{
 const id=randomUUID();
 pwrite(U.owner,'person.save',{id,name:'이름만 직원',title:'디자이너',department:'제작',phone:'010-1',agent:'Claude Code',joined_on:'2026-01-02',notes:'연봉 메모'});
 const mine=pread(U.member);
 const row=mine.people.find(x=>x.id===id);
 assert.equal(row.title,'디자이너'); assert.equal(row.notes,null,'멤버에게 메모는 없다');
 assert.equal(pread(U.owner).people.find(x=>x.id===id).notes,'연봉 메모');
 const acct=mine.people.find(x=>x.user_id===U.member2);
 assert.ok(acct && acct.id===null,'명부 행 없는 계정 멤버');
 assert.equal(acct.email,'','멤버에게 계정 이메일은 없다');
 assert.equal(pread(U.owner).people.find(x=>x.user_id===U.member2).email,'member2@example.test');
 assert.ok(!mine.people.some(x=>x.user_id===U.guest),'손님은 명부에 없다');
 assert.match(callFail(U.member,'office_people_write',`${quote(ORG)},'person.save',${j({id:randomUUID(),name:'x'})}`),/company_forbidden/);
 // 계정 연결: 그 뒤로는 계정 행이 따로 나오지 않는다
 pwrite(U.owner,'person.save',{id,name:'이름만 직원',user_id:U.member2,title:'디자이너'});
 assert.equal(pread(U.owner).people.filter(x=>x.user_id===U.member2).length,1);
 assert.match(callFail(U.owner,'office_people_write',`${quote(ORG)},'person.save',${j({id:randomUUID(),name:'밖',user_id:U.outsider})}`),/company_input/,'조직 밖 계정은 연결 못 한다');
 pwrite(U.owner,'person.save',{id,name:'이름만 직원',user_id:U.member2,left_on:TODAY});
 assert.equal(pread(U.owner).people.find(x=>x.id===id).status,'left');
 pwrite(U.owner,'person.delete',{id});
 assert.ok(!pread(U.owner).people.some(x=>x.id===id));
});

test('평가 레포트: 사람 대상은 본인과 관리자만, 크루 대상은 관리자만, 쓰기는 관리자만', {skip}, ()=>{
 const p=ewrite(U.owner,{id:randomUUID(),subject_kind:'person',subject_user:U.member,scope:'month',from:`${LAST}-01`,to:endOf(LAST),title:'월간 평가',performance:80,quality:70,productivity:90,expertise:60,collaboration:100,review:'## 총평'});
 assert.equal(p.eval.total,80,'종합점수를 비우면 평균');
 assert.equal(p.eval.author_kind,'person');
 const c=ewrite(U.owner,{id:randomUUID(),subject_kind:'crew',subject_name:'페퍼',scope:'month',from:`${LAST}-01`,to:endOf(LAST),title:'크루 평가',total:77,crew:'루나'});
 assert.equal(c.eval.subject_type,'agent'); assert.equal(c.eval.author_kind,'crew'); assert.equal(c.eval.author_name,'루나');
 assert.deepEqual(elist(U.member).evals.map(e=>e.id),[p.eval.id],'본인 것만');
 assert.deepEqual(elist(U.member2).evals,[],'남의 평가는 안 보인다');
 assert.equal(elist(U.admin).evals.length,2);
 assert.match(ewriteFail(U.member,{id:randomUUID(),subject_kind:'person',subject_user:U.member,scope:'month',from:`${LAST}-01`,to:endOf(LAST),title:'셀프'}),/perf_forbidden/);
 assert.match(callFail(U.guest,'office_perf_eval_list',quote(ORG)),/perf_forbidden/);
});

test('평가 레포트: 기간은 정해진 모양만, 점수는 0~100 정수, 계정 없는 사람은 이관에서만', {skip}, ()=>{
 const base={subject_kind:'person',subject_user:U.member,title:'t'};
 assert.match(ewriteFail(U.owner,{...base,id:randomUUID(),scope:'month',from:`${LAST}-02`,to:endOf(LAST)}),/perf_period/);
 assert.match(ewriteFail(U.owner,{...base,id:randomUUID(),scope:'week',from:'2026-09-08',to:'2026-09-13'}),/perf_period/);
 ewrite(U.owner,{...base,id:randomUUID(),scope:'week',from:'2026-09-07',to:'2026-09-13'}); // 월요일~일요일
 assert.match(ewriteFail(U.owner,{...base,id:randomUUID(),scope:'month',from:`${LAST}-01`,to:endOf(LAST),quality:101}),/perf_input/);
 assert.match(ewriteFail(U.owner,{...base,id:randomUUID(),scope:'month',from:`${LAST}-01`,to:endOf(LAST),quality:7.5}),/perf_input/);
 assert.match(ewriteFail(U.owner,{id:randomUUID(),subject_kind:'person',subject_name:'누구',scope:'month',from:`${LAST}-01`,to:endOf(LAST),title:'t'}),/perf_input/);
 assert.match(ewriteFail(U.owner,{...base,subject_user:U.outsider,id:randomUUID(),scope:'month',from:`${LAST}-01`,to:endOf(LAST)}),/perf_input/);
});

test('평가 레포트: 고치기는 새 판으로 한 번씩, 원래 판은 남는다 — 지우기·덮어쓰기 없음', {skip}, ()=>{
 const first=ewrite(U.owner,{id:randomUUID(),subject_kind:'person',subject_user:U.member2,scope:'year',from:'2025-01-01',to:'2025-12-31',title:'연간',total:60});
 const second=ewrite(U.owner,{id:randomUUID(),replaces:first.eval.id,title:'연간(고침)',total:65});
 assert.equal(second.eval.replaces,first.eval.id);
 assert.equal(second.eval.subject_user,U.member2,'대상·기간은 원래 판을 따른다');
 assert.equal(second.eval.period_from,'2025-01-01');
 assert.match(ewriteFail(U.owner,{id:randomUUID(),replaces:first.eval.id,title:'또'}),/perf_conflict/,'같은 판을 두 번 고칠 수 없다');
 const list=elist(U.member2).evals;
 assert.equal(list.find(e=>e.id===first.eval.id).replaced_by,second.eval.id);
 assert.equal(list.length,2,'원래 판도 남는다');
 // 같은 id로 다시 부르면 한 건
 const again=ewrite(U.owner,{id:second.eval.id,replaces:first.eval.id,title:'연간(고침)',total:65});
 assert.equal(again.eval.id,second.eval.id);
});

test('평가 레포트 근거: 본인이 공유한 월말 사본의 합계만 — 공유 전에는 비어 있다', {skip}, ()=>{
 const mk=()=>ewrite(U.owner,{id:randomUUID(),subject_kind:'person',subject_user:U.admin,scope:'month',from:`${LAST}-01`,to:endOf(LAST),title:'근거'});
 assert.equal(mk().eval.basis,null,'공유 전');
 call(U.admin,'office_perf_write',`${quote(ORG)},'review.share',${j({period:LAST})}`);
 const b=mk().eval.basis;
 assert.equal(b.kind,'review'); assert.equal(b.period,LAST); assert.ok(b.totals && 'contract' in b.totals);
});

test('평가 레포트 이관: source가 같으면 다시 돌려도 한 건, 원본 작성 시각·기간 글 유지', {skip}, ()=>{
 const d={id:randomUUID(),source:'notion',source_id:'page-1',subject_kind:'person',subject_name:'예전 직원',subject_type:'staff',scope:'week',from:'2026-08-03',to:'2026-08-08',
  period_label:'8월 1주차',title:'주간',total:71,author_name:'페퍼',created_at:'2026-08-09T12:30:00Z'};
 const a=ewrite(U.owner,d);
 const b=ewrite(U.owner,{...d,id:randomUUID()});
 assert.equal(a.eval.id,b.eval.id);
 assert.equal(a.eval.author_kind,'import'); assert.equal(a.eval.author_name,'페퍼'); assert.equal(a.eval.period_label,'8월 1주차');
 assert.equal(new Date(a.eval.created_at).toISOString(),'2026-08-09T12:30:00.000Z');
 assert.ok(!elist(U.member).evals.some(e=>e.id===a.eval.id),'계정 없는 대상은 관리자만');
});

test('이관 전용 할 일: 원본의 끝낸 날짜를 지키고(오늘 실적으로 안 잡힌다), 다시 돌려도 한 건, 남에게는 못 맡긴다', {skip}, ()=>{
 const id=randomUUID(), done=`${LAST}-03T05:00:00Z`;
 const t=call(U.member,'office_task_import',`${quote(ORG)},${j({id,title:'옛 업무',note:'[카테고리] 개발',due_on:`${LAST}-03`,done_at:done,source:{kind:'notion',id:'n-1'},assignee:U.owner})}`);
 assert.equal(t.assignee,U.member,'맡는 사람은 부른 사람');
 assert.equal(new Date(t.done_at).toISOString(),new Date(done).toISOString());
 const again=call(U.member,'office_task_import',`${quote(ORG)},${j({id:randomUUID(),title:'옛 업무',source:{kind:'notion',id:'n-1'}})}`);
 assert.equal(again.id,id,'같은 원본은 한 번만');
 const today=call(U.member,'office_perf_report',`${quote(ORG)},${quote(TODAY)}::date,${quote(TODAY)}::date`);
 assert.ok(!today.tasks.some(x=>x.id===id),'오늘 실적에 없다');
 const then=call(U.member,'office_perf_report',`${quote(ORG)},${quote(`${LAST}-01`)}::date,${quote(endOf(LAST))}::date`);
 assert.ok(then.tasks.some(x=>x.id===id && x.done));
 assert.match(callFail(U.member,'office_task_import',`${quote(ORG)},${j({id:randomUUID(),title:'x',source:{kind:'msgr',id:'1'}})}`),/task_input/);
 assert.match(callFail(U.member,'office_task_import',`${quote(ORG)},${j({id:randomUUID(),title:'x',done_at:'2999-01-01T00:00:00Z',source:{kind:'notion',id:'n-2'}})}`),/task_input/);
 assert.match(callFail(U.guest,'office_task_import',`${quote(ORG)},${j({id:randomUUID(),title:'x',source:{kind:'notion',id:'n-3'}})}`),/business_forbidden/);
});

test('퇴사 3년 정리: 시험 실행은 세기만 한다', {skip}, ()=>{
 const r=JSON.parse(last(sql('select office_company_purge()')));
 assert.equal(r.dry,true);
 assert.equal(typeof r.evals,'number');
 assert.match(callFail(U.owner,'office_company_purge',''),/permission denied/);
});
