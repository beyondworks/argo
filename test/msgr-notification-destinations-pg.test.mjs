// Reuse the complete real PostgreSQL automation fixture and retain all adjacent regressions.
import './msgr-automations-pg.test.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const DB=process.env.ARGO_PG_TEST_URL;
const skip=!DB&&'ARGO_PG_TEST_URL required';
const OWNER='11111111-1111-4111-8111-111111111111', MEMBER='33333333-3333-4333-8333-333333333333';
const ATTEMPT='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function raw(q){ return spawnSync('psql',[DB,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}); }
function sql(q){const r=raw(q);if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim().split('\n').at(-1);}
const as=(u,q)=>sql(`set role authenticated; select set_config('argo.uid','${u}',false); ${q}`);
const rpc=(u,q)=>JSON.parse(as(u,`select public.${q}`));
const denied=(u,q)=>assert.notEqual(raw(`set role authenticated;select set_config('argo.uid','${u}',false);${q}`).status,0);
let CH,CREW,ORG;
before(()=>{if(!DB)return; const f=fileURLToPath(new URL('../supabase/migrations/20260913110500_msgr_notification_destinations.sql',import.meta.url));const r=spawnSync('psql',[DB,'-X','-q','-v','ON_ERROR_STOP=1','-f',f],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
function fixture(){ CH=sql("select id from public.msgr_channels where name='Automation tests'"); CREW=sql("select id from public.msgr_crews where slug='theirs'");ORG=sql("select id from public.msgr_orgs where slug='lean'"); }
const routes=(u=OWNER)=>rpc(u,`msgr_notification_routes_sync('notify','[{"kind":"telegram","label":"Telegram","ready":true},{"kind":"slack","label":"Slack","ready":true}]')`);
const save=(ids=[],id=null,req=null)=>rpc(OWNER,`msgr_automation_save_with_notifications(${id?`'${id}'`:'null'},'${CH}','${CREW}','Daily brief','Summarize','{"kind":"daily","timezone":"UTC","time":"09:00"}',${req?`'${req}'`:'null'},ARRAY[${ids.map(x=>`'${x}'::uuid`).join(',')}]::uuid[])`);
function finish(a,failed=false){const r=rpc(OWNER,`msgr_automation_run_now('${a.id}')`);rpc(MEMBER,`msgr_execution_claim('lean','${CREW}',${r.message_id},'${CH}','${ATTEMPT}')`);const reply={channel_id:CH,crew_id:CREW,author_kind:'crew',kind:'text',client_msg_id:`reply:${CREW}:${r.message_id}`,reply_to:r.message_id,thread_root:r.message_id,body:failed?'Failure summary':'Today schedule',meta:failed?{failed:true}:{}};rpc(MEMBER,`msgr_execution_finish('lean','${CREW}',${r.message_id},'${CH}','${ATTEMPT}','${JSON.stringify(reply)}')`);return r;}
const claim=(u=OWNER,ws='notify')=>rpc(u,`msgr_notification_claim('${ws}','${ATTEMPT}')`);
const clear=()=>sql("update public.msgr_notification_deliveries set status='skipped' where status in ('pending','claimed')");

test('routes are owner-only, validated and never accept caller identity or secrets',{skip},()=>{
 fixture();const rs=routes();routes(MEMBER);assert.equal(rs.length,2);assert.equal(rpc(OWNER,'msgr_notification_routes_list()').length,2);assert.equal(as(OWNER,`select count(*) from public.msgr_notification_routes where owner_user_id='${MEMBER}'`),'0');
 denied(OWNER,"insert into public.msgr_notification_routes(owner_user_id,ws_id,kind,label) values('11111111-1111-4111-8111-111111111111','x','telegram','x')");
 denied(OWNER,"select public.msgr_notification_routes_sync('x','[{\"kind\":\"mail\",\"ready\":true,\"label\":\"x\"}]')");
 denied(OWNER,"select public.msgr_notification_routes_sync('x','[{\"kind\":\"telegram\",\"ready\":true,\"label\":\"x\"},{\"kind\":\"telegram\",\"ready\":true,\"label\":\"x\"}]')");
 assert.equal(sql("select has_function_privilege('anon','public.msgr_notification_claim(text,uuid,text)','EXECUTE')"),'f');
});
test('saving rejects someone else routes and new request retry preserves initial route selection',{skip},()=>{
 const rs=routes(),other=routes(MEMBER);denied(OWNER,`select public.msgr_automation_save_with_notifications(null,'${CH}','${CREW}','x','y','{"kind":"interval","timezone":"UTC","minutes":10}',null,ARRAY['${other[0].id}'::uuid])`);
 const req='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',a=save([rs[0].id],null,req),retry=save([rs[1].id],null,req);assert.equal(a.id,retry.id);assert.deepEqual(retry.notification_route_ids,[rs[0].id]);
});
test('A schedules B crew: only A can claim its own connected workspace, both results retain original channel',{skip},()=>{
 clear();const rs=routes(),a=save(rs.map(x=>x.id)),r=finish(a);assert.equal(sql(`select count(*) from public.msgr_notification_deliveries where run_id='${r.id}'`),'2');assert.deepEqual(claim(MEMBER),[]);assert.deepEqual(claim(OWNER,'lean'),[]);
 const got=claim();assert.equal(got.length,2);assert.equal(got[0].body,'Today schedule');assert.equal(got[0].status,'completed');assert.deepEqual(claim(),[]);
 denied(MEMBER,`update public.msgr_notification_deliveries set status='sent'`);
 assert.equal(as(MEMBER,`select public.msgr_notification_finish('${got[0].delivery_id}','${ATTEMPT}','sent')`),'f');
 assert.equal(as(OWNER,`select public.msgr_notification_finish('${got[0].delivery_id}','${ATTEMPT}','sent')`),'t');assert.equal(as(OWNER,`select public.msgr_notification_finish('${got[0].delivery_id}','${ATTEMPT}','sent')`),'f');
 assert.equal(sql(`select channel_id from public.msgr_messages where id=(select reply_id from public.msgr_automation_runs where id='${r.id}')`),CH);
});
test('no selection and forged message automation metadata never enqueue external results',{skip},()=>{
 clear();const a=save(),r=finish(a);assert.equal(sql(`select count(*) from public.msgr_notification_deliveries where run_id='${r.id}'`),'0');
 const msg=as(OWNER,`insert into public.msgr_messages(channel_id,author_kind,author_user_id,kind,body,mentions,meta) values('${CH}','user','${OWNER}','text','Fake','[{"kind":"crew","id":"${CREW}"}]','{"automation_run_id":"${r.id}","automation_id":"${a.id}"}') returning id`);
 rpc(MEMBER,`msgr_execution_claim('lean','${CREW}',${msg},'${CH}','${ATTEMPT}')`);const reply={channel_id:CH,crew_id:CREW,author_kind:'crew',kind:'text',client_msg_id:`reply:${CREW}:${msg}`,reply_to:Number(msg),thread_root:Number(msg),body:'Fake result'};rpc(MEMBER,`msgr_execution_finish('lean','${CREW}',${msg},'${CH}','${ATTEMPT}','${JSON.stringify(reply)}')`);assert.deepEqual(claim(),[]);
});
test('run snapshot survives edit, failed and blocked statuses notify once',{skip},()=>{
 clear();const rs=routes(),a=save([rs[0].id]),r=rpc(OWNER,`msgr_automation_run_now('${a.id}')`);save([rs[1].id],a.id);
 as(MEMBER,`insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,body,reply_to,client_msg_id) values('${CH}','crew','${CREW}','system','Blocked',${r.message_id},'stale:${CREW}:${r.message_id}')`);
 let got=claim();assert.equal(got.length,1);assert.equal(got[0].route_id,rs[0].id);assert.equal(got[0].status,'blocked');assert.equal(got[0].body,'');clear();
 const failed=finish(a,true);got=claim();assert.equal(got.length,1);assert.equal(got[0].status,'failed');assert.equal(got[0].route_id,rs[1].id);
 sql(`update public.msgr_automation_runs set status='failed' where id='${failed.id}'`);assert.equal(sql(`select count(*) from public.msgr_notification_deliveries where run_id='${failed.id}'`),'1');
});
test('expired sender claim becomes uncertain and is never automatically retransmitted',{skip},()=>{
 clear();const a=save([routes()[0].id]);finish(a);const got=claim();assert.equal(got.length,1);sql(`update public.msgr_notification_deliveries set claimed_at=now()-interval '6 minutes' where id='${got[0].delivery_id}'`);assert.deepEqual(claim(),[]);assert.equal(sql(`select status from public.msgr_notification_deliveries where id='${got[0].delivery_id}'`),'uncertain');
});
test('connection removal and current channel permission revoke suppress delivery',{skip},()=>{
 clear();const a=save([routes()[0].id]);const pending=finish(a);rpc(OWNER,"msgr_notification_routes_sync('notify','[]')");assert.deepEqual(claim(),[]);assert.equal(sql(`select status from public.msgr_notification_deliveries where run_id='${pending.id}'`),'pending');save(a.notification_route_ids,a.id);
 routes();assert.equal(claim().length,1);clear();const r=finish(a);sql(`update public.msgr_org_members set removed_at=now() where org_id='${ORG}' and user_id='${OWNER}'`);assert.deepEqual(claim(),[]);sql(`update public.msgr_org_members set removed_at=null where org_id='${ORG}' and user_id='${OWNER}'`);assert.equal(sql(`select status from public.msgr_notification_deliveries where run_id='${r.id}'`),'skipped');
});

test('offline results expire after 24 hours and stale node advertisement cannot claim',{skip},()=>{
 clear();const rs=routes(),a=save([rs[0].id]),r=finish(a);sql(`update public.msgr_notification_route_nodes set last_seen_at=now()-interval '4 minutes' where route_id='${rs[0].id}'`);assert.deepEqual(claim(),[]);sql(`update public.msgr_notification_deliveries set created_at=now()-interval '25 hours' where run_id='${r.id}'`);routes();assert.deepEqual(claim(),[]);assert.equal(sql(`select status||':'||error from public.msgr_notification_deliveries where run_id='${r.id}'`),'skipped:delivery_expired');
});

test('offline pending rows do not starve another ready destination in the batch',{skip},()=>{
 clear();const rs=routes();for(let i=0;i<5;i++)finish(save([rs[0].id]));finish(save([rs[1].id]));rpc(OWNER,`msgr_notification_routes_sync('notify','[{"kind":"${rs[0].kind}","label":"Offline","ready":false},{"kind":"${rs[1].kind}","label":"Ready","ready":true}]')`);const got=claim();assert.equal(got.length,1);assert.equal(got[0].route_id,rs[1].id);
});

test('pre-send authorization rechecks owner, attempt, revoked permissions and deleted replies',{skip},()=>{
 clear();const a=save([routes()[0].id]);finish(a);let row=claim()[0];assert.equal(as(OWNER,`select public.msgr_notification_authorize('${row.delivery_id}','${ATTEMPT}')`),'t');assert.equal(as(MEMBER,`select public.msgr_notification_authorize('${row.delivery_id}','${ATTEMPT}')`),'f');assert.equal(as(OWNER,`select public.msgr_notification_authorize('${row.delivery_id}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')`),'f');
 sql(`update public.msgr_org_members set expires_at=now()-interval '1 minute' where org_id='${ORG}' and user_id='${OWNER}'`);assert.equal(as(OWNER,`select public.msgr_notification_authorize('${row.delivery_id}','${ATTEMPT}')`),'f');sql(`update public.msgr_org_members set expires_at=null where org_id='${ORG}' and user_id='${OWNER}'`);assert.equal(sql(`select status||':'||error from public.msgr_notification_deliveries where id='${row.delivery_id}'`),'skipped:permission_revoked');
 const r=finish(a);row=claim()[0];sql(`update public.msgr_messages set deleted_at=now() where id=(select reply_id from public.msgr_automation_runs where id='${r.id}')`);assert.equal(as(OWNER,`select public.msgr_notification_authorize('${row.delivery_id}','${ATTEMPT}')`),'f');assert.equal(sql(`select status from public.msgr_notification_deliveries where id='${row.delivery_id}'`),'skipped');
});
test('pre-send revoked route is skipped and creation retry does not bypass revoked authorization',{skip},()=>{
 clear();const rs=routes(),req='cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',a=save([rs[0].id],null,req);finish(a);const row=claim()[0];rpc(OWNER,"msgr_notification_routes_sync('notify','[]')");assert.equal(as(OWNER,`select public.msgr_notification_authorize('${row.delivery_id}','${ATTEMPT}')`),'f');
 sql(`update public.msgr_org_members set removed_at=now() where org_id='${ORG}' and user_id='${OWNER}'`);assert.throws(()=>save([rs[0].id],null,req),/forbidden/);sql(`update public.msgr_org_members set removed_at=null where org_id='${ORG}' and user_id='${OWNER}'`);
});

test('per-device connection readiness never flaps and only ready devices may win one delivery',{skip},()=>{
 clear();rpc(OWNER,"msgr_notification_routes_sync('notify','[]')");const sync=(device,ready)=>rpc(OWNER,`msgr_notification_routes_sync('notify','[{"kind":"telegram","label":"Shared workspace","ready":${ready}}]','${device}')`);
 const rs=sync('mac',true);sync('windows',false);assert.equal(rpc(OWNER,'msgr_notification_routes_list()').find(r=>r.id===rs.find(x=>x.kind==='telegram').id).ready,true);
 const a=save([rs.find(x=>x.kind==='telegram').id]);finish(a);assert.deepEqual(rpc(OWNER,`msgr_notification_claim('notify','${ATTEMPT}','windows')`),[]);const got=rpc(OWNER,`msgr_notification_claim('notify','${ATTEMPT}','mac')`);assert.equal(got.length,1);sync('windows',true);assert.deepEqual(rpc(OWNER,`msgr_notification_claim('notify','${ATTEMPT}','windows')`),[]);
 sync('mac',false);assert.equal(as(OWNER,`select public.msgr_notification_authorize('${got[0].delivery_id}','${ATTEMPT}')`),'f');assert.equal(sql(`select status from public.msgr_notification_deliveries where id='${got[0].delivery_id}'`),'skipped');
});

test('two ready devices concurrently claim one external notification only once',{skip},async()=>{
 clear();const advertise=d=>rpc(OWNER,`msgr_notification_routes_sync('notify','[{"kind":"telegram","label":"Ready","ready":true}]','${d}')`);const rs=advertise('mac');advertise('windows');finish(save([rs.find(r=>r.kind==='telegram').id]));
 const results=await Promise.all(['mac','windows'].map(async device=>{const q=`set role authenticated;select set_config('argo.uid','${OWNER}',false);select public.msgr_notification_claim('notify','${ATTEMPT}','${device}')`;const {stdout}=await promisify(execFile)('psql',[DB,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',q]);return JSON.parse(stdout.trim().split('\n').at(-1));}));assert.equal(results.flat().length,1);
});
