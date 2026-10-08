import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 업무 현황(유건 10/8 확정 "권장안대로"): 보류 사유·보류한 시각, 맥 세션 보고(office_session_report), 업무 현황 읽기(office_work_status).
// 실제 Postgres에서 본다: 보류로 바꾸면 시각·사유가 생기고 나가면 지워지는지, 같은 값은 다시 쓰지 않는지(xmin·트랜잭션 번호 그대로),
// 사유만 고치기(reason_only)가 낡은 패널에서 진행 중인 일을 보류로 되돌리지 못하는지,
// 세션 보고가 4분 안 같은 값이면 쓰기 0인지, 남의 세션·조직 밖·손님·남의 할 일을 막는지, 8일 지난 내 행을 지우고 200행이면 내 가장 오래된 행을 밀어내는지,
// 업무 현황이 관리자에게는 조직 전체·멤버에게는 자기 것만 주는지, 실행 중(로컬 심박 2분·봇 10분·결과 미도착 안내 제외)·열린 일만 주는지,
// 팀 작업은 부른 사람이 읽을 수 있는 방의 것만·진행 중은 24시간 안에 움직인 것만 주는지.
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB && 'Run scripts/billing-pg-drill.sh test/office-work-status-pg.test.mjs';
const U=Object.fromEntries(['owner','admin','member','member2','guest','outsider','gone'].map(k=>[k,randomUUID()]));
let ORG, ORG2, CH;
const raw=q=>psqlSpawn(DB,['-A','-t','-c',q]);
const sql=q=>{const r=raw(q); if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();};
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
const org=o=>o?quote(o):'null';
const val=v=>v==null?'null':quote(v);
const userSql=(u,q)=>`set timezone to 'UTC'; set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last=s=>s.split('\n').filter(Boolean).at(-1);
const j=d=>`${quote(JSON.stringify(d))}::jsonb`;
const call=(u,fn,args)=>JSON.parse(last(sql(userSql(u,`select ${fn}(${args})`))));
const callFail=(u,fn,args)=>{const r=raw(userSql(u,`select ${fn}(${args})`)); assert.notEqual(r.status,0,`${fn} should fail`); return r.stderr;};
// 같은 트랜잭션에서 함수를 부른 뒤 트랜잭션 번호가 생겼는지 본다 — 아무것도 쓰지 않았으면 null(빈 줄)
const noWrite=(u,fn,args)=>{const out=sql(userSql(u,`select ${fn}(${args}); select coalesce(txid_current_if_assigned()::text,'none')`)); return last(out)==='none';};
const task=(a,d,{u=U.member,o=ORG}={})=>call(u,'office_task_write',`${org(o)},${quote(a)},${j(d)}`);
const tfail=(a,d,{u=U.member,o=ORG}={})=>callFail(u,'office_task_write',`${org(o)},${quote(a)},${j(d)}`);
const row=id=>JSON.parse(last(sql(`select to_jsonb(t) from office_tasks t where id=${quote(id)}`)));
const xmin=id=>sql(`select xmin::text from office_tasks where id=${quote(id)}`);
const kinds=id=>sql(`select coalesce(string_agg(kind,',' order by id),'') from office_task_events where task_id=${quote(id)}`);
const statusEvents=id=>sql(`select coalesce(string_agg(coalesce(from_value,'-')||'>'||coalesce(to_value,'-'),',' order by id),'') from office_task_events where task_id=${quote(id)} and kind='status'`);
const newTask=(extra={},opts={})=>{const id=randomUUID(); task('task.create',{id,title:'견적서 보내기',due_on:'2026-10-20',...extra},opts); return id;};
const reportArgs=({id,o=ORG,name='맥가이버 - 정비사',project='argo',taskId=null})=>`${quote(id)},${org(o)},${val(name)},${val(project)},${taskId?quote(taskId)+'::uuid':'null'}`;
const report=(u,a)=>call(u,'office_session_report',reportArgs(a));
const reportFail=(u,a)=>callFail(u,'office_session_report',reportArgs(a));
const sess=id=>{const r=sql(`select to_jsonb(s) from office_agent_sessions s where id=${quote(id)}`); return r?JSON.parse(r):null;};
const sxmin=id=>sql(`select xmin::text from office_agent_sessions where id=${quote(id)}`);
const status=(u,o=ORG)=>call(u,'office_work_status',org(o));
const kst=d=>new Date(d.getTime()+9*3600e3).toISOString().slice(0,10);
const TODAY=kst(new Date());
const THIS=TODAY.slice(0,7);
const endOf=p=>{const [y,m]=p.split('-').map(Number); return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
const MIG=f=>fileURLToPath(new URL(`../supabase/migrations/${f}`,import.meta.url));
const apply=f=>{const r=psqlSpawn(DB,['-f',MIG(f)]); if(r.status!==0)throw new Error(`${f}: ${r.stderr}`);};
// 크루(아르고 에이전트·VPS 봇) — 봇 행은 RPC만 만들 수 있어 시드에서는 그 플래그를 켠다
const crew=({owner,slug,name=slug,hosting='local',seen='now()',dept=null,st='active',o=ORG})=>last(sql(`select set_config('msgr.bot_create','1',false);
 insert into msgr_crews(org_id,owner_user_id,ws_id,slug,display_name,hosting,last_seen_at,department,status)
 values(${quote(o)},${quote(owner)},'ws-${slug}',${quote(slug)},${quote(name)},${quote(hosting)},${seen},${val(dept)},${quote(st)}) returning id`));
let msgSeq=0;
const message=()=>last(sql(`insert into msgr_messages(org_id,channel_id,author_kind,author_user_id,body,client_msg_id) values(${quote(ORG)},${quote(CH)},'user',${quote(U.owner)},'일 시킴','ws-${++msgSeq}-${randomUUID()}') returning id`));
const execution=(crewId,{state='running',beat='now()',started='now()'}={})=>last(sql(`insert into msgr_executions(crew_id,source_msg_id,attempt,state,started_at,heartbeat_at) values(${quote(crewId)},${message()},${quote(randomUUID())},${quote(state)},${started},${beat}) returning source_msg_id`)); // 원글 id
// 봇 경로가 남기는 '결과 미도착' 안내(20260909230000 msgr_bot_updates와 같은 칸)
const unknownNotice=(crewId,src)=>sql(`insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body,meta)
 values(${quote(CH)},'crew',${quote(crewId)},'system',${src},${src},${quote(`unknown:${crewId}:${src}`)},'외부 에이전트의 실행 결과가 아직 도착하지 않았습니다.','{"execution_status":"unknown","disposition":"done"}')`);
const workRun=(lead,{st='running',goal='공급사 비교',o=ORG,ch=CH}={})=>last(sql(`insert into msgr_work_runs(org_id,channel_id,created_by,request_id,goal,lead_crew_id,status) values(${quote(o)},${quote(ch)},${quote(U.owner)},${quote(randomUUID())},${quote(goal)},${quote(lead)},${quote(st)}) returning id`));
let OLD_HOLD, OLD_TODO, OLD_HOLD_AT;

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
 // 배포될 마이그레이션을 날짜 순서 그대로: 결제·메신저(크루·봇·실행·팀 작업·부서) → 오피스(업무·할 일·성과·회사·할 일 속성)
 for(const f of ['20260714150000_entitlements.sql','20260724000100_trial_14d.sql','20260728100000_entitlements_ls.sql','20260728113000_billing_hardening.sql','20260728150000_ls_reconcile_cooldown.sql','20260730050000_is_pro_ends_at.sql',
  '20260903120000_msgr.sql','20260907120000_msgr_crew_inventory.sql','20260908120000_msgr_bots.sql','20260908140000_msgr_crew_autodispatch.sql','20260909000000_msgr_bot_external_id.sql','20260909001000_msgr_crew_folder.sql',
  '20260909002000_msgr_profiles_friends.sql','20260909003000_msgr_message_meta.sql','20260909004000_msgr_p0_reads_reactions_prefs.sql','20260909005000_msgr_avatars.sql','20260909120000_msgr_execution_claims.sql','20260909230000_msgr_bot_execution.sql',
  '20260911150000_msgr_channel_manage.sql','20260911230000_msgr_channel_scope_enforce.sql','20260912135036_msgr_target_favorites_dm_leave.sql','20260912001000_msgr_bot_files.sql','20260913010000_msgr_work_runs.sql','20260919110000_msgr_work_stall_blocked.sql',
  '20260924120000_msgr_doc_links.sql',
  '20260927144230_office_business.sql','20260927170000_office_pages.sql','20260927171000_office_mail.sql','20260928010000_office_marketing.sql','20260929140000_office_deal_flow.sql','20260929180000_office_tasks_owners.sql',
  '20260929190000_office_perf.sql','20260930150000_office_perf_tie_order.sql','20261002201800_office_company.sql','20261004100000_office_task_props.sql'])apply(f);
 for(const [k,id] of Object.entries(U))sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k+'@example.test')})`);
 ORG=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Lean','lean-ws',${quote(U.owner)}) returning id`)));
 ORG2=last(sql(userSql(U.outsider,`insert into msgr_orgs(name,slug,owner_user_id)values('Other','other-ws',${quote(U.outsider)}) returning id`)));
 sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
 for(const k of ['admin','member','member2','guest','gone'])sql(`insert into msgr_org_members(org_id,user_id,role,display_name)values(${quote(ORG)},${quote(U[k])},${quote(k==='member2'||k==='gone'?'member':k)},${quote(k)})`);
 sql(`update msgr_org_members set removed_at=now() where org_id=${quote(ORG)} and user_id=${quote(U.gone)}`); // 나간 사람
 CH=last(sql(`insert into msgr_channels(org_id,kind,name,created_by) values(${quote(ORG)},'public','업무',${quote(U.owner)}) returning id`));
 // 마이그레이션 전에 보류로 바꾼 일 — 새 칸 held_at은 마지막 '보류로 바꿈' 기록 시각으로 채워져야 한다(사유는 모른다 — 비워 둔다)
 OLD_HOLD=newTask(); task('task.status',{id:OLD_HOLD,status:'hold'});
 sql(`update office_task_events set at='2026-10-01T03:00:00Z' where task_id=${quote(OLD_HOLD)} and kind='status'`);
 OLD_HOLD_AT='2026-10-01T03:00:00+00:00';
 OLD_TODO=newTask();
 apply('20261008200000_office_work_status.sql');
 apply('20261008200000_office_work_status.sql'); // 다시 적용해도 깨지지 않는다
});

// ── 보류 사유 ──
test('마이그레이션: 옛 보류 일은 마지막 보류 시각으로 채우고 사유는 비운다, 다른 일은 비어 있다, 목록에 새 칸이 나간다', {skip}, ()=>{
 const h=row(OLD_HOLD), t=row(OLD_TODO);
 assert.equal(new Date(h.held_at).toISOString(),new Date(OLD_HOLD_AT).toISOString());
 assert.equal(h.hold_reason,null);
 assert.deepEqual([t.held_at,t.hold_reason],[null,null]);
 const l=call(U.member,'office_task_list',quote(ORG)).find(x=>x.id===OLD_HOLD);
 assert.ok('hold_reason' in l && 'held_at' in l,'office_task_list가 새 칸을 그대로 준다');
 assert.ok(!('scope' in l));
});

test('보류로 바꾸면 보류한 시각·사유가 생기고, 다른 상태로 가면 둘 다 지운다 — 기록은 status 한 줄씩(사유 값은 남기지 않는다)', {skip}, ()=>{
 const id=newTask({assignee:U.member},{u:U.admin});
 const t0=Date.now();
 const t=task('task.status',{id,status:'hold',hold_reason:'  견적 회신 기다림 — 이것부터: 계약서 검토  '});
 assert.equal(t.status,'hold');
 assert.equal(t.hold_reason,'견적 회신 기다림 — 이것부터: 계약서 검토','앞뒤 공백을 걷는다');
 assert.ok(new Date(t.held_at).getTime()>=t0-60e3,'보류한 시각');
 const d=task('task.status',{id,status:'doing',hold_reason:'무시된다'});
 assert.deepEqual([d.status,d.held_at,d.hold_reason],['doing',null,null],'보류에서 나가면 둘 다 지운다(다른 상태의 사유는 받지 않는다)');
 const n=task('task.status',{id,status:'hold'});
 assert.equal(n.hold_reason,null,'사유 없이 보류로 바꾸면 사유는 없다');
 assert.ok(n.held_at);
 assert.equal(statusEvents(id),'todo>hold,hold>doing,doing>hold');
 assert.equal(sql(`select count(*) from office_task_events where task_id=${quote(id)} and (from_value like '%견적%' or to_value like '%견적%')`),'0','사유 글은 기록에 남지 않는다');
});

test('이미 보류인 일: 사유만 바꾸면 보류한 시각은 그대로, 같은 사유는 다시 쓰지 않는다(xmin 그대로), 빠뜨리면 그대로·null이면 지운다', {skip}, ()=>{
 const id=newTask();
 task('task.status',{id,status:'hold',hold_reason:'자료 대기'});
 sql(`update office_tasks set held_at='2026-10-02T01:00:00Z' where id=${quote(id)}`); // 보류한 시각이 바뀌지 않는지 보이게 과거로
 const x=xmin(id), k=kinds(id);
 task('task.status',{id,status:'hold',hold_reason:'자료 대기'});
 task('task.status',{id,status:'hold',hold_reason:'  자료 대기 '}); // 공백만 다른 같은 사유
 assert.equal(xmin(id),x,'같은 사유 재전송은 행을 다시 쓰지 않는다');
 assert.equal(kinds(id),k,'기록도 늘지 않는다');
 const t=task('task.status',{id,status:'hold',hold_reason:'자료 대기 — 이것부터: 세금계산서'});
 assert.equal(t.hold_reason,'자료 대기 — 이것부터: 세금계산서');
 assert.equal(new Date(t.held_at).toISOString(),'2026-10-02T01:00:00.000Z','사유만 바꾸면 보류한 시각은 그대로');
 assert.equal(statusEvents(id),'todo>hold,hold>hold','사유 바꾸기는 같은 status 한 줄(새 기록 종류 없음)');
 const y=xmin(id);
 task('task.status',{id,status:'hold'}); // 사유를 빠뜨린 요청(예: 상태 고르기만 다시)
 assert.equal(row(id).hold_reason,'자료 대기 — 이것부터: 세금계산서','빠뜨린 요청은 사유를 지우지 않는다');
 assert.equal(xmin(id),y);
 task('task.status',{id,status:'hold',hold_reason:null});
 assert.equal(row(id).hold_reason,null,'null을 보내면 사유를 지운다');
 assert.equal(new Date(row(id).held_at).toISOString(),'2026-10-02T01:00:00.000Z');
 task('task.status',{id,status:'hold',hold_reason:'   '});
 assert.equal(row(id).hold_reason,null,'빈 글은 사유 없음');
});

// 검수 10/8: 할 일 패널의 사유 저장이 task.status라서, 패널이 든 행이 낡으면 그사이 진행 중으로 바뀐 일을 보류로 되돌렸다 → reason_only
test('사유만 고치기(reason_only): 낡은 패널이 진행 중인 일을 보류로 되돌리지 못한다(task_conflict·아무것도 안 바뀜), 보류면 사유만 바꾼다', {skip}, ()=>{
 const id=newTask({assignee:U.member},{u:U.admin});
 task('task.status',{id,status:'hold',hold_reason:'자료 대기'}); // 패널이 이 상태를 들고 있다
 task('task.status',{id,status:'doing'},{u:U.owner}); // 그사이 관리자가 진행 중으로
 const x=xmin(id), k=kinds(id);
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'자료 대기 — 고침',reason_only:true}),/task_conflict/);
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'자료 대기 — 고침',reason_only:true},{u:U.owner}),/task_conflict/,'관리자도 같다');
 const r=row(id);
 assert.deepEqual([r.status,r.hold_reason,r.held_at],['doing',null,null],'진행 중 그대로');
 assert.equal(xmin(id),x,'행을 다시 쓰지 않는다'); assert.equal(kinds(id),k,'기록도 늘지 않는다');
 assert.match(tfail('task.status',{id,status:'doing',hold_reason:'x',reason_only:true}),/task_conflict/,'사유만 고치기는 보류 요청만');
 // 보류인 일: 상태 전이 없이 사유만(보류한 시각 그대로), 같은 사유는 쓰기 0, 기록은 hold→hold 한 줄(상한에 센다)
 const h=newTask(); task('task.status',{id:h,status:'hold',hold_reason:'회신 대기'});
 sql(`update office_tasks set held_at='2026-10-03T02:00:00Z' where id=${quote(h)}`);
 const hx=xmin(h);
 task('task.status',{id:h,status:'hold',hold_reason:' 회신 대기 ',reason_only:true});
 assert.equal(xmin(h),hx,'같은 사유는 다시 쓰지 않는다');
 const t=task('task.status',{id:h,status:'hold',hold_reason:'회신 대기 — 이것부터: 견적',reason_only:true});
 assert.deepEqual([t.status,t.hold_reason,new Date(t.held_at).toISOString()],['hold','회신 대기 — 이것부터: 견적','2026-10-03T02:00:00.000Z']);
 assert.equal(statusEvents(h),'todo>hold,hold>hold');
 task('task.status',{id:h,status:'hold',reason_only:true}); // 사유를 빠뜨린 사유만 고치기 — 아무것도 안 바꾼다
 assert.equal(row(h).hold_reason,'회신 대기 — 이것부터: 견적');
 assert.match(tfail('task.status',{id:h,status:'hold',hold_reason:'x',reason_only:'yes'}),/task_input/,'reason_only는 참·거짓만');
 assert.match(tfail('task.status',{id:h,status:'hold',hold_reason:'x',reason_only:true},{u:U.member2}),/task_forbidden/,'권한은 상태 바꾸기와 같다');
 // reason_only가 없거나 false면 지금처럼 상태를 바꾼다(기존 동작 그대로)
 task('task.status',{id:h,status:'doing',reason_only:false});
 assert.equal(row(h).status,'doing');
});

test('보류 사유 입력 검사: 500자까지, 글이 아니면 거절', {skip}, ()=>{
 const id=newTask();
 task('task.status',{id,status:'hold',hold_reason:'가'.repeat(500)});
 assert.equal(row(id).hold_reason.length,500);
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'가'.repeat(501)}),/task_input/);
 for(const hold_reason of [1,true,['x'],{a:1}])assert.match(tfail('task.status',{id,status:'hold',hold_reason}),/task_input/,JSON.stringify(hold_reason));
 assert.match(tfail('task.create',{id:randomUUID(),title:'x',status:'hold',hold_reason:'가'.repeat(501)}),/task_input/);
 assert.equal(row(id).hold_reason.length,500,'거절된 요청은 사유를 바꾸지 않는다');
});

test('권한: 맡은 사람·관리자는 보류·사유를 바꾸고, 관계없는 멤버는 못 하고, 손님·밖의 사람은 오류', {skip}, ()=>{
 const id=newTask({assignee:U.member},{u:U.admin});
 task('task.status',{id,status:'hold',hold_reason:'맡은 사람'});
 task('task.status',{id,status:'hold',hold_reason:'관리자가 고침'},{u:U.owner});
 assert.equal(row(id).hold_reason,'관리자가 고침');
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'몰래'},{u:U.member2}),/task_forbidden/);
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'몰래'},{u:U.guest}),/forbidden/);
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'몰래'},{u:U.outsider}),/forbidden/);
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'몰래'},{u:U.gone}),/forbidden/,'나간 사람');
 assert.equal(row(id).hold_reason,'관리자가 고침');
 const given=newTask({assignee:U.member},{u:U.admin});
 assert.match(tfail('task.status',{id:given,status:'hold',hold_reason:'x'},{u:U.member2}),/task_forbidden/);
});

test('사유 바꾸기도 상태 바꾸기 200번 상한에 센다, 끝낸 일·취소한 일은 바꾸지 않는다', {skip}, ()=>{
 const id=newTask();
 task('task.status',{id,status:'hold',hold_reason:'첫 사유'});
 sql(`insert into office_task_events(task_id,kind,actor) select ${quote(id)},'status',${quote(U.member)} from generate_series(1,198)`); // 1 + 198 = 199
 task('task.status',{id,status:'hold',hold_reason:'200번째'});
 assert.match(tfail('task.status',{id,status:'hold',hold_reason:'201번째'}),/task_limit/);
 assert.equal(row(id).hold_reason,'200번째');
 const d=newTask(); task('task.status',{id:d,status:'hold',hold_reason:'끝낼 일'}); task('task.done',{id:d});
 assert.match(tfail('task.status',{id:d,status:'hold',hold_reason:'바꿈'}),/task_done/);
 task('task.reopen',{id:d});
 assert.deepEqual([row(d).status,row(d).hold_reason],['hold','끝낼 일'],'다시 열면 보류·사유 그대로');
 task('task.cancel',{id:d});
 assert.match(tfail('task.status',{id:d,status:'hold',hold_reason:'바꿈'}),/task_cancelled/);
});

test('만들기: 보류로 만들면 시각·사유, 다른 상태의 사유는 남기지 않는다, 같은 요청 두 번은 한 건·사유가 다르면 충돌, 세션 출처를 그대로 둔다', {skip}, ()=>{
 const id=randomUUID(), src={kind:'session',name:'맥가이버 - 정비사'};
 const d={id,title:'로그인 화면 다듬기',status:'hold',hold_reason:'디자인 확정 대기 — 이것부터: 결제 오류',source:src};
 const t=task('task.create',d);
 assert.deepEqual([t.status,t.hold_reason,t.assignee,t.created_by],['hold','디자인 확정 대기 — 이것부터: 결제 오류',U.member,U.member],'담당 = 부른 사람');
 assert.ok(t.held_at); assert.deepEqual(t.source,src);
 const x=xmin(id);
 assert.equal(task('task.create',d).id,id,'같은 요청 두 번 = 한 건');
 assert.equal(xmin(id),x);
 assert.match(tfail('task.create',{...d,hold_reason:'다른 사유'}),/task_conflict/);
 const n=task('task.create',{id:randomUUID(),title:'진행 일',status:'doing',hold_reason:'무시'});
 assert.deepEqual([n.held_at,n.hold_reason],[null,null]);
 const h=task('task.create',{id:randomUUID(),title:'사유 없는 보류',status:'hold'});
 assert.ok(h.held_at); assert.equal(h.hold_reason,null);
 assert.equal(kinds(id),'create','만들기 기록은 그대로 한 줄');
});

// 유건 10/8 확정 5번: 성과 기록은 지금 규칙 그대로 — 보류·사유를 바꿔도 성과 계산이 한 글자도 달라지지 않는다
test('성과 기록 불변: 보류·사유를 바꿔도 성과 계산이 같다', {skip}, ()=>{
 const due=`${THIS}-${TODAY.slice(8)}`, a=newTask({due_on:due});
 const rep=()=>call(U.member,'office_perf_report',`${quote(ORG)},${quote(`${THIS}-01`)}::date,${quote(endOf(THIS))}::date`);
 const keep=r=>JSON.stringify({totals:r.totals,tasks:[...r.tasks].map(x=>x.id).sort()});
 const base=rep();
 task('task.status',{id:a,status:'hold',hold_reason:'성과 확인'}); task('task.status',{id:a,status:'hold',hold_reason:'성과 확인 2'});
 assert.equal(keep(rep()),keep(base));
});

// ── 세션 보고 ──
test('세션 보고: 첫 보고는 쓰고, 같은 값을 4분 안에 다시 보내면 쓰기 0(xmin·트랜잭션 번호 그대로)', {skip}, ()=>{
 const id=randomUUID(), tid=newTask({title:'세션이 맡은 일'});
 assert.deepEqual(report(U.member,{id,taskId:tid}),{ok:true,written:true,task:true});
 const s=sess(id);
 assert.deepEqual([s.owner_user_id,s.org_id,s.name,s.project,s.task_id,s.kind],[U.member,ORG,'맥가이버 - 정비사','argo',tid,'claude-code']);
 const x=sxmin(id);
 assert.deepEqual(report(U.member,{id,taskId:tid}),{ok:true,written:false,task:true});
 assert.deepEqual(report(U.member,{id,taskId:tid,name:'  맥가이버 - 정비사 ',project:' argo '}),{ok:true,written:false,task:true},'앞뒤 공백만 다르면 같은 값');
 assert.ok(noWrite(U.member,'office_session_report',reportArgs({id,taskId:tid})),'유휴 반복 호출은 트랜잭션 번호도 안 생긴다');
 assert.equal(sxmin(id),x);
});

test('세션 보고: 값(제목·프로젝트·할 일·조직)이 바뀌면 쓰고, 4분 지나면 같은 값도 쓴다', {skip}, ()=>{
 const id=randomUUID();
 report(U.member,{id});
 for(const a of [{name:'맥가이버 - 검수'},{name:'맥가이버 - 검수',project:'office'},{name:'맥가이버 - 검수',project:'office',taskId:newTask()},{name:'맥가이버 - 검수',project:null},{name:'맥가이버 - 검수',project:null,o:null}]){
  const x=sxmin(id);
  assert.deepEqual(report(U.member,{id,...a}),{ok:true,written:true,task:true},JSON.stringify(a));
  assert.notEqual(sxmin(id),x);
 }
 const s=sess(id); assert.deepEqual([s.name,s.project,s.task_id,s.org_id],['맥가이버 - 검수',null,null,null],'개인 공간(조직 없음)도 된다');
 sql(`update office_agent_sessions set last_seen_at=now()-interval '5 minutes' where id=${quote(id)}`);
 const old=sess(id).last_seen_at;
 assert.deepEqual(report(U.member,{id,name:'맥가이버 - 검수',project:null,o:null}),{ok:true,written:true,task:true},'4분 지나면 같은 값도 쓴다');
 assert.ok(new Date(sess(id).last_seen_at)>new Date(old));
 sql(`update office_agent_sessions set last_seen_at=now()-interval '3 minutes' where id=${quote(id)}`);
 assert.deepEqual(report(U.member,{id,name:'맥가이버 - 검수',project:null,o:null}),{ok:true,written:false,task:true},'3분이면 쓰지 않는다');
});

test('세션 보고 경계: 남의 세션 id는 덮어쓰지 않는다, 조직 밖·손님·나간 사람은 그 조직으로 못 쓴다, 로그인 없으면 session_signin', {skip}, ()=>{
 const id=randomUUID();
 report(U.member,{id});
 const x=sxmin(id);
 assert.match(reportFail(U.member2,{id,name:'가로채기'}),/session_forbidden/);
 assert.match(reportFail(U.outsider,{id,o:null,name:'가로채기'}),/session_forbidden/,'개인 공간으로도 남의 id는 못 쓴다');
 assert.equal(sxmin(id),x); assert.equal(sess(id).owner_user_id,U.member);
 for(const k of ['outsider','guest','gone'])assert.match(reportFail(U[k],{id:randomUUID()}),/session_forbidden/,k);
 assert.match(reportFail(U.member,{id:randomUUID(),o:ORG2}),/session_forbidden/,'내가 속하지 않은 조직');
 const r=raw(`set role authenticated; select set_config('argo.uid','',false); select office_session_report(${reportArgs({id:randomUUID()})})`);
 assert.notEqual(r.status,0); assert.match(r.stderr,/session_signin/);
 assert.deepEqual(report(U.outsider,{id:randomUUID(),o:ORG2}),{ok:true,written:true,task:true},'자기 조직이면 된다');
});

// 검수 10/8: p_task를 검사하지 않아 멤버 세션이 남(주인·다른 멤버)의 일을 '지금 하는 일'로 붙일 수 있었다
// 재검증 10/8: 거절(session_input)하면 관리자가 그 일을 남에게 다시 맡긴 뒤 세션이 낡은 id를 계속 보내 보고가 영영 실패하고 '끊김'으로 굳었다
//   → 맞지 않는 id는 버리고(task_id null) 보고는 쓴다, 응답 task=false
test('세션 보고 할 일: 그 공간에서 내가 맡았거나 만든 일만 붙인다 — 아니면 그 id만 버리고 보고는 쓴다(task=false), 개인 공간은 내 개인 일만', {skip}, ()=>{
 const mine=newTask({title:'내 일'});
 const madeForMe=newTask({title:'관리자가 나에게',assignee:U.member},{u:U.admin});
 const madeByMe=newTask({title:'내가 만들고 넘긴 일'}); task('task.assign',{id:madeByMe,assignee:U.member2},{u:U.admin}); // 관리자가 다시 맡긴 경우 — 만든 사람은 그대로 나
 const others=newTask({title:'남의 일',assignee:U.member2},{u:U.admin});
 const personal=newTask({title:'개인 일'},{o:null});
 const elsewhere=newTask({title:'밖 조직 일'},{u:U.outsider,o:ORG2});
 const id=randomUUID();
 for(const t of [mine,madeForMe,madeByMe])assert.deepEqual(report(U.member,{id,taskId:t}),{ok:true,written:true,task:true},t);
 assert.equal(sess(id).task_id,madeByMe);
 for(const t of [others,personal,elsewhere,randomUUID()]){
  const r=report(U.member,{id,taskId:t});
  assert.equal(r.task,false,t); assert.equal(sess(id).task_id,null,'남의 일은 붙지 않는다');
 }
 const x=sxmin(id);
 assert.deepEqual(report(U.member,{id,taskId:others}),{ok:true,written:false,task:false},'버린 뒤 같은 값이면 유휴(쓰기 0)');
 assert.equal(sxmin(id),x);
 const re=newTask({title:'맡았다가 남에게 넘어간 일',assignee:U.member},{u:U.admin});
 const id2=randomUUID();
 assert.deepEqual(report(U.member,{id:id2,taskId:re}),{ok:true,written:true,task:true});
 task('task.assign',{id:re,assignee:U.member2},{u:U.admin});
 const r2=report(U.member,{id:id2,taskId:re});
 assert.equal(r2.written,true,'다시 맡겨진 뒤에도 보고(연결)는 계속된다'); assert.equal(r2.task,false); assert.equal(sess(id2).task_id,null);
 const o=randomUUID(); report(U.member2,{id:o,taskId:mine});
 assert.equal(sess(o).task_id,null,'남이 내 일을 붙이지 못한다');
 const p=randomUUID();
 assert.deepEqual(report(U.member,{id:p,o:null,taskId:personal}),{ok:true,written:true,task:true},'개인 공간 세션은 내 개인 일');
 assert.equal(report(U.member,{id:p,o:null,taskId:mine}).task,false,'개인 공간 세션에 조직 일은 안 붙는다'); assert.equal(sess(p).task_id,null);
 assert.deepEqual(report(U.member,{id,taskId:null}),{ok:true,written:false,task:true},'비우기(이미 null)는 유휴');
});

test('세션 보고 입력 검사: 제목 1~120자, 프로젝트 120자까지, id 필수', {skip}, ()=>{
 for(const name of ['',' ',null,'가'.repeat(121)])assert.match(reportFail(U.member,{id:randomUUID(),name}),/session_input/,String(name).slice(0,5));
 assert.match(reportFail(U.member,{id:randomUUID(),project:'p'.repeat(121)}),/session_input/);
 assert.match(callFail(U.member,'office_session_report',`null,${quote(ORG)},'x',null,null`),/session_input/);
 const id=randomUUID();
 report(U.member,{id,name:'가'.repeat(120),project:'p'.repeat(120)});
 assert.equal(sess(id).name.length,120);
 const e=randomUUID(); report(U.member,{id:e,project:'  '});
 assert.equal(sess(e).project,null,'빈 프로젝트는 없음');
});

// 총괄 결정 10/8 (나): 보존 30일 → 8일(화면은 7일), 200행 상한은 거절 대신 그 사람의 가장 오래 안 보인 행을 밀어내고 넣는다(남의 행은 그대로).
// 검수 재현: 30일 보존 + 거절이면 하루 7개 넘게 세션을 여는 사람은 새 세션이 업무 현황에서 사라졌다(이 맥 24시간 208개).
test('세션 보존·상한: 쓰는 호출에서 8일 넘게 안 보인 내 행만 지운다, 200행이 차면 내 가장 오래된 행을 밀어내고 새 세션을 넣는다(남의 행 그대로)', {skip}, ()=>{
 const who=U.admin, other=U.member2;
 const mineOld=randomUUID(), otherOld=randomUUID(), mineRecent=randomUUID();
 sql(`insert into office_agent_sessions(id,owner_user_id,org_id,name,last_seen_at) values
  (${quote(mineOld)},${quote(who)},${quote(ORG)},'옛 세션',now()-interval '8 days 1 hour'),
  (${quote(otherOld)},${quote(other)},${quote(ORG)},'남의 옛 세션',now()-interval '40 days'),
  (${quote(mineRecent)},${quote(who)},${quote(ORG)},'7일 전',now()-interval '7 days 23 hours')`);
 report(who,{id:mineRecent,name:'7일 전'}); // 같은 값이라도 4분 지나 쓴다 — 이 쓰기에서 정리
 assert.equal(sess(mineOld),null,'8일 넘은 내 행은 지운다');
 assert.ok(sess(otherOld),'남의 행은 지우지 않는다');
 assert.ok(sess(mineRecent));
 // 상한: 내 행이 200개 찬 상태에서 새 세션 → 성공, 행 수 200 그대로, 가장 오래 안 보인 내 행이 빠진다
 const cap=U.guest; // 손님도 개인 공간(조직 없음) 세션은 쓸 수 있다
 sql(`insert into office_agent_sessions(id,owner_user_id,name,last_seen_at) select gen_random_uuid(),${quote(cap)},'s'||g,now()-g*interval '1 minute' from generate_series(1,200) g`); // s200이 가장 오래됨
 const count=u=>sql(`select count(*) from office_agent_sessions where owner_user_id=${quote(u)}`);
 const named=n=>sql(`select count(*) from office_agent_sessions where owner_user_id=${quote(cap)} and name=${quote(n)}`);
 const othersBefore=sql(`select string_agg(id::text||':'||xmin::text,',' order by id) from office_agent_sessions where owner_user_id<>${quote(cap)}`);
 const fresh=randomUUID();
 assert.deepEqual(report(cap,{id:fresh,o:null,name:'새 세션'}),{ok:true,written:true,task:true},'200행이 차도 새 세션은 들어간다');
 assert.equal(count(cap),'200','행 수는 200 그대로');
 assert.ok(sess(fresh)); assert.equal(named('s200'),'0','가장 오래 안 보인 내 행이 빠진다'); assert.equal(named('s199'),'1','그다음 행은 남는다');
 assert.equal(sql(`select string_agg(id::text||':'||xmin::text,',' order by id) from office_agent_sessions where owner_user_id<>${quote(cap)}`),othersBefore,'남의 행은 그대로(지우지도 다시 쓰지도 않는다)');
 // 있는 세션 갱신은 아무것도 밀어내지 않는다
 const some=sql(`select id from office_agent_sessions where owner_user_id=${quote(cap)} and name='s1'`);
 assert.deepEqual(report(cap,{id:some,o:null,name:'갱신'}),{ok:true,written:true,task:true});
 assert.equal(count(cap),'200'); assert.equal(named('s199'),'1','갱신은 밀어내지 않는다');
 // 8일 지난 내 행이 있으면 그 행이 먼저 정리되고, 최근 행은 밀려나지 않는다
 sql(`update office_agent_sessions set last_seen_at=now()-interval '9 days' where owner_user_id=${quote(cap)} and name='s100'`);
 assert.deepEqual(report(cap,{id:randomUUID(),o:null,name:'새 세션 2'}),{ok:true,written:true,task:true});
 assert.equal(count(cap),'200'); assert.equal(named('s100'),'0','8일 지난 내 행 정리'); assert.equal(named('s199'),'1','최근 행은 그대로');
 sql(`delete from office_agent_sessions where owner_user_id=${quote(cap)}`);
});

// ── 업무 현황 ──
test('업무 현황: 관리자는 조직 전체(에이전트·세션·할 일), 멤버는 자기 에이전트·자기 세션·자기 일만', {skip}, ()=>{
 const mine=crew({owner:U.member,slug:'mcgyver',name:'맥가이버',dept:'정비'});
 const bot=crew({owner:U.member,slug:'mcgyver-v',name:'맥가이버 - v',hosting:'bot'});
 const theirs=crew({owner:U.member2,slug:'pepper',name:'페퍼',hosting:'resident'});
 const noname=crew({owner:U.admin,slug:'otto',name:''});
 const off=crew({owner:U.member,slug:'old',name:'떠난 크루',st:'detached'});
 const elsewhere=crew({owner:U.outsider,slug:'x',name:'밖',o:ORG2});
 const s1=randomUUID(), s2=randomUUID(), s3=randomUUID(), s4=randomUUID(), s5=randomUUID();
 report(U.member,{id:s1,name:'맥가이버 - 정비사'}); report(U.member2,{id:s2,name:'페퍼 - 총괄'});
 report(U.member,{id:s3,name:'개인 세션',o:null}); report(U.outsider,{id:s4,name:'밖 세션',o:ORG2});
 report(U.admin,{id:s5,name:'오래된 세션'}); sql(`update office_agent_sessions set last_seen_at=now()-interval '8 days' where id=${quote(s5)}`);
 const tMine=newTask({title:'내 일'}), tGiven=newTask({title:'맡긴 일',assignee:U.member2},{u:U.admin}), tMade=newTask({title:'내가 만들어 맡김',assignee:U.member2},{u:U.owner});
 const a=status(U.owner);
 assert.equal(a.admin,true);
 const ac=Object.fromEntries(a.crews.map(c=>[c.id,c]));
 for(const id of [mine,bot,theirs,noname])assert.ok(ac[id],`관리자는 ${id}를 본다`);
 assert.ok(!ac[off],'꺼진(detached) 크루는 없다'); assert.ok(!ac[elsewhere],'다른 조직 크루는 없다');
 assert.deepEqual([ac[mine].name,ac[mine].slug,ac[mine].hosting,ac[mine].owner,ac[mine].department],['맥가이버','mcgyver','local',U.member,'정비']);
 assert.equal(ac[bot].hosting,'bot'); assert.equal(ac[theirs].hosting,'local','상주(resident)는 local'); assert.equal(ac[noname].name,'otto','이름이 비면 slug');
 assert.ok(ac[mine].last_seen_at);
 const as=a.sessions.map(s=>s.id);
 assert.ok(as.includes(s1)&&as.includes(s2)); assert.ok(!as.includes(s3),'개인 공간 세션은 없다'); assert.ok(!as.includes(s4)); assert.ok(!as.includes(s5),'7일 넘은 세션은 없다');
 const ss=a.sessions.find(s=>s.id===s1); assert.deepEqual(Object.keys(ss).sort(),['id','last_seen_at','name','owner','project','task_id']);
 assert.equal(ss.owner,U.member);
 const at=a.tasks.map(t=>t.id);
 for(const id of [tMine,tGiven,tMade])assert.ok(at.includes(id));
 assert.ok(!('scope' in a.tasks[0])); assert.ok('hold_reason' in a.tasks[0]);
 assert.ok(new Date(a.now).getTime()>Date.now()-60e3);
 // 멤버: 자기 크루·세션·일만
 const m=status(U.member);
 assert.equal(m.admin,false);
 assert.deepEqual(m.crews.map(c=>c.id).sort(),[mine,bot].sort());
 const msess=m.sessions.map(s=>s.id);
 assert.ok(msess.includes(s1)); assert.ok(!msess.includes(s2)&&!msess.includes(s3)&&!msess.includes(s4));
 assert.ok(m.sessions.every(s=>s.owner===U.member),'멤버는 자기 세션만');
 const mt=m.tasks.map(t=>t.id);
 assert.ok(mt.includes(tMine)); assert.ok(!mt.includes(tGiven)); assert.ok(!mt.includes(tMade));
 assert.ok(m.tasks.every(t=>t.assignee===U.member||t.created_by===U.member));
 const m2=status(U.member2).tasks.map(t=>t.id);
 assert.ok(m2.includes(tGiven)&&m2.includes(tMade),'맡은 일은 본다'); assert.ok(!m2.includes(tMine));
 assert.equal(status(U.admin).admin,true);
});

test('업무 현황 경계: 손님·밖의 사람·나간 사람은 business_forbidden, 조직 없이 부르면 session_input, 로그인 없으면 거절', {skip}, ()=>{
 for(const k of ['guest','outsider','gone'])assert.match(callFail(U[k],'office_work_status',quote(ORG)),/business_forbidden/,k);
 assert.match(callFail(U.member,'office_work_status','null'),/session_input/);
 const r=raw(`set role authenticated; select set_config('argo.uid','',false); select office_work_status(${quote(ORG)})`);
 assert.notEqual(r.status,0); assert.match(r.stderr,/business_forbidden/);
});

test('업무 현황: 실행 중은 심박 2분 안인 실행만(보이는 크루만), 팀 작업은 진행 중·막힘만(보이는 크루가 이끄는 것만)', {skip}, ()=>{
 const live=crew({owner:U.member,slug:'live',name:'라이브'});
 const stale=crew({owner:U.member,slug:'stale',name:'멈춤'});
 const hers=crew({owner:U.member2,slug:'hers',name:'남의 크루'});
 execution(live,{started:`now()-interval '5 minutes'`});
 execution(stale,{beat:`now()-interval '3 minutes'`});
 execution(live,{state:'completed'});
 execution(hers);
 const r1=workRun(live,{goal:'공급사 세 곳 비교'}), r2=workRun(live,{st:'blocked'}), r3=workRun(live,{st:'completed'}), r4=workRun(hers);
 const a=status(U.owner);
 const run=a.running.filter(x=>[live,stale,hers].includes(x.crew_id));
 assert.deepEqual(run.map(x=>x.crew_id).sort(),[live,hers].sort(),'심박이 3분 지난 실행·끝난 실행은 없다');
 assert.ok(run.find(x=>x.crew_id===live).started_at);
 const ar=a.runs.map(x=>x.id);
 assert.ok(ar.includes(r1)&&ar.includes(r2)&&ar.includes(r4)); assert.ok(!ar.includes(r3),'끝난 팀 작업은 없다');
 assert.deepEqual(Object.keys(a.runs.find(x=>x.id===r1)).sort(),['created_at','goal','id','lead_crew_id','status']);
 assert.equal(a.runs.find(x=>x.id===r1).goal,'공급사 세 곳 비교');
 const m=status(U.member);
 assert.deepEqual(m.running.map(x=>x.crew_id),[live],'멤버는 자기 크루 실행만');
 assert.ok(!m.runs.some(x=>x.id===r4),'남의 크루가 이끄는 팀 작업은 안 보인다');
 assert.ok(m.runs.some(x=>x.id===r1));
});

// 검수 10/8: VPS 봇 실행은 맡을 때 심박을 한 번만 찍어(결재 대기 중에만 다시 찍는다) 2분 기준이면 일하는 봇이 빠졌다 → 봇은 기존 봇 기준 10분.
// '결과 미도착' 안내가 붙은 실행은 봇 경로(20261006100000 보류 판정)처럼 기다리는 실행으로 보지 않는다.
test('업무 현황 실행 중: 로컬 크루는 심박 2분, 봇은 10분, 결과 미도착 안내가 붙은 실행은 뺀다', {skip}, ()=>{
 const bot3=crew({owner:U.member,slug:'hermes-3',name:'헤르메스 - v',hosting:'bot'});
 const bot11=crew({owner:U.member,slug:'hermes-11',name:'오래된 봇',hosting:'bot'});
 const botNotice=crew({owner:U.member,slug:'hermes-n',name:'안내 붙은 봇',hosting:'bot'});
 const local3=crew({owner:U.member,slug:'local-3',name:'로컬 3분'});
 const local1=crew({owner:U.member,slug:'local-1',name:'로컬 1분'});
 execution(bot3,{started:`now()-interval '3 minutes'`,beat:`now()-interval '3 minutes'`});
 execution(bot11,{started:`now()-interval '11 minutes'`,beat:`now()-interval '11 minutes'`});
 const src=execution(botNotice,{started:`now()-interval '12 minutes'`,beat:`now()-interval '1 minute'`}); // 안내 뒤 결재 대기로 심박이 다시 찍힌 실행
 unknownNotice(botNotice,src);
 execution(local3,{started:`now()-interval '3 minutes'`,beat:`now()-interval '3 minutes'`});
 execution(local1,{started:`now()-interval '5 minutes'`,beat:`now()-interval '1 minute'`});
 for(const u of [U.owner,U.member]){
  const run=new Set(status(u).running.map(x=>x.crew_id));
  assert.ok(run.has(bot3),'봇 3분째 = 실행 중');
  assert.ok(!run.has(bot11),'봇 11분 = 아님');
  assert.ok(!run.has(botNotice),'결과 미도착 안내가 붙은 실행 = 아님');
  assert.ok(!run.has(local3),'로컬 3분 무심박 = 아님');
  assert.ok(run.has(local1),'로컬 1분 = 실행 중');
 }
 // 안내는 그 크루가 쓴 것만 본다 — 사람이 같은 키로 글을 남겨도 실행 표시를 가리지 못한다
 const bot4=crew({owner:U.member,slug:'hermes-4',name:'봇 4분',hosting:'bot'});
 const s4=execution(bot4,{started:`now()-interval '4 minutes'`,beat:`now()-interval '4 minutes'`});
 sql(`insert into msgr_messages(org_id,channel_id,author_kind,author_user_id,body,client_msg_id) values(${quote(ORG)},${quote(CH)},'user',${quote(U.member)},'가짜 안내',${quote(`unknown:${bot4}:${s4}`)})`);
 assert.ok(status(U.owner).running.some(x=>x.crew_id===bot4));
});

// 검수 10/8 [보안 high]: 팀 작업 목표(goal)는 그 방에 올라간 글이다 — 비공개 방·1:1 방의 목표가 그 방을 못 읽는 관리자·주인에게 나갔다
test('업무 현황 팀 작업: 부른 사람이 읽을 수 있는 방의 작업만(표 RLS와 같다) — 비공개 방 목표는 구성원 아닌 관리자·주인에게 나가지 않는다', {skip}, ()=>{
 const mcrew=crew({owner:U.member,slug:'m-crew',name:'멤버 크루'});
 const priv=last(sql(`insert into msgr_channels(org_id,kind,name,created_by) values(${quote(ORG)},'private','멤버 비밀방',${quote(U.member)}) returning id`));
 sql(`insert into msgr_channel_members(channel_id,member_kind,member_id) values(${quote(priv)},'user',${quote(U.member)}),(${quote(priv)},'crew',${quote(mcrew)})`);
 const secret=workRun(mcrew,{goal:'비밀: 연봉 협상 자료 정리',ch:priv});
 const open=workRun(mcrew,{goal:'공개 방 작업'});
 for(const [k,u] of [['owner',U.owner],['admin',U.admin],['member',U.member]]){
  const ids=status(u).runs.map(r=>r.id);
  const rls=last(sql(userSql(u,`select count(*) from msgr_work_runs where id=${quote(secret)}`))); // 표 정책(msgr_can_read_channel)으로 직접 읽은 결과
  assert.equal(ids.includes(secret),rls==='1',`${k}: 업무 현황과 표 RLS가 같다`);
  assert.ok(ids.includes(open),`${k}: 읽을 수 있는 방의 작업은 나간다`);
 }
 assert.ok(!status(U.owner).runs.some(r=>r.id===secret),'주인(구성원 아님)에게 비공개 방 목표가 나가지 않는다');
 assert.ok(!status(U.admin).runs.some(r=>r.id===secret),'관리자(구성원 아님)에게도');
 assert.ok(!JSON.stringify(status(U.admin)).includes('연봉 협상'),'응답 어디에도 목표 글이 없다');
 assert.equal(status(U.member).runs.find(r=>r.id===secret)?.goal,'비밀: 연봉 협상 자료 정리','구성원인 멤버는 본다');
});

test('업무 현황 팀 작업: 막힘은 그대로, 진행 중은 24시간 안에 움직인 것만', {skip}, ()=>{
 const lead=crew({owner:U.member,slug:'lead-24',name:'리더'});
 const fresh=workRun(lead,{goal:'23시간 전 움직임'}), stale=workRun(lead,{goal:'25시간 전 움직임'}), blocked=workRun(lead,{st:'blocked',goal:'오래 막힘'});
 sql(`update msgr_work_runs set updated_at=now()-interval '23 hours' where id=${quote(fresh)}`);
 sql(`update msgr_work_runs set updated_at=now()-interval '25 hours' where id in (${quote(stale)},${quote(blocked)})`);
 for(const u of [U.owner,U.member]){
  const ids=status(u).runs.map(r=>r.id);
  assert.ok(ids.includes(fresh),'진행 중·23시간 = 나간다');
  assert.ok(!ids.includes(stale),'진행 중·25시간 = 끝나지 않고 남은 옛 작업은 안 나간다');
  assert.ok(ids.includes(blocked),'막힘은 오래돼도 나간다');
 }
});

test('업무 현황 할 일: 끝낸 일·취소한 일은 빼고, 사람 이름은 office_org_people 규칙(나간 사람은 이름 없음), 에이전트·세션 주인 이름도 준다', {skip}, ()=>{
 // 총괄 결정 10/8 (다): 카드 주인이 내가 아니면 주인 이름을 보인다 — 할 일이 없는 크루·세션 주인도 이름이 있어야 한다
 const crewer=randomUUID(), sessioner=randomUUID();
 for(const [u,n] of [[crewer,'크루 주인'],[sessioner,'세션 주인']]){
  sql(`insert into auth.users(id,email) values(${quote(u)},${quote(u+'@example.test')})`);
  sql(`insert into msgr_org_members(org_id,user_id,role,display_name) values(${quote(ORG)},${quote(u)},'member',${quote(n)})`);
 }
 crew({owner:crewer,slug:'crewer-c',name:'할 일 없는 크루'});
 report(sessioner,{id:randomUUID(),name:'할 일 없는 세션'});
 const done=newTask({title:'끝낸 일'}); task('task.done',{id:done});
 const gone=newTask({title:'취소한 일'}); task('task.cancel',{id:gone});
 const held=newTask({title:'보류 일',status:'hold',hold_reason:'회신 대기'});
 sql(`update msgr_org_members set removed_at=null where org_id=${quote(ORG)} and user_id=${quote(U.gone)}`); // 맡긴 뒤에 나간다
 let left;
 try { left=newTask({title:'나간 사람 일',assignee:U.gone},{u:U.admin}); } finally { sql(`update msgr_org_members set removed_at=now() where org_id=${quote(ORG)} and user_id=${quote(U.gone)}`); }
 {
  const a=status(U.owner);
  const ids=a.tasks.map(t=>t.id);
  assert.ok(!ids.includes(done)&&!ids.includes(gone)); assert.ok(ids.includes(held)&&ids.includes(left));
  assert.equal(a.tasks.find(t=>t.id===held).hold_reason,'회신 대기');
  const people=Object.fromEntries(a.people.map(p=>[p.id,p.name]));
  assert.equal(people[U.member],'member'); assert.equal(people[U.admin],'admin');
  assert.ok(U.gone in people,'나간 사람도 줄은 있다'); assert.equal(people[U.gone],null,'이름은 없다');
  const ids2=new Set([...a.tasks.flatMap(t=>[t.assignee,t.created_by]),...a.crews.map(c=>c.owner),...a.sessions.map(s=>s.owner)]);
  assert.deepEqual(new Set(a.people.map(p=>p.id)),ids2,'할 일의 맡은 사람·만든 사람과 보이는 에이전트·세션 주인만');
  assert.equal(people[crewer],'크루 주인','할 일 없는 크루 주인도 이름이 있다');
  assert.equal(people[sessioner],'세션 주인','할 일 없는 세션 주인도 이름이 있다');
 }
 const m=status(U.member);
 assert.ok(!m.people.some(p=>p.id===crewer||p.id===sessioner),'멤버에게는 보이는 것(자기 것)의 사람만');
});

test('업무 현황은 쓰기 0 — 부른 트랜잭션에 트랜잭션 번호가 생기지 않는다', {skip}, ()=>{
 assert.ok(noWrite(U.owner,'office_work_status',quote(ORG)));
 assert.ok(noWrite(U.member,'office_work_status',quote(ORG)));
 assert.equal(sql(`select provolatile from pg_proc where oid='public.office_work_status(uuid)'::regprocedure`),'s','stable');
});

test('표·함수 경계: 세션 표는 직접 못 읽고, 새 함수는 정의자 함수·로그인한 사람만 실행, 색인이 있다', {skip}, ()=>{
 const direct=raw(userSql(U.admin,`select count(*) from office_agent_sessions`));
 assert.ok(direct.status!==0 || last(direct.stdout)==='0');
 assert.equal(sql(`select relrowsecurity from pg_class where oid='public.office_agent_sessions'::regclass`),'t');
 assert.equal(sql(`select count(*) from pg_policy where polrelid='public.office_agent_sessions'::regclass`),'0','정책 없음 — 함수로만');
 for(const fn of ['office_session_report(uuid,uuid,text,text,uuid)','office_work_status(uuid)','office_task_write(uuid,text,jsonb)']){
  assert.equal(sql(`select has_function_privilege('anon','public.${fn}','execute')`),'f',fn);
  assert.equal(sql(`select has_function_privilege('authenticated','public.${fn}','execute')`),'t',fn);
  assert.equal(sql(`select prosecdef from pg_proc where oid='public.${fn}'::regprocedure`),'t',`${fn}: 정의자 함수`);
  assert.match(sql(`select array_to_string(proconfig,',') from pg_proc where oid='public.${fn}'::regprocedure`),/search_path=public, pg_temp/,`${fn}: search_path`);
 }
 for(const ix of ['office_agent_sessions_org','office_agent_sessions_owner','msgr_executions_running','msgr_work_runs_org_open'])
  assert.equal(sql(`select count(*) from pg_indexes where indexname=${quote(ix)}`),'1',ix);
 // 계정·조직이 지워지면 세션도 같이 지워진다
 const o=last(sql(userSql(U.owner,`insert into msgr_orgs(name,slug,owner_user_id)values('Tmp','tmp-ws',${quote(U.owner)}) returning id`)));
 const id=randomUUID(); report(U.owner,{id,o});
 sql(`delete from msgr_orgs where id=${quote(o)}`);
 assert.equal(sess(id),null,'조직이 지워지면 그 조직 세션도');
});
