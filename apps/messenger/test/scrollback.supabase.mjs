// 브라우저 전용 픽스처 — 자격증명·운영 클라이언트를 import 하지 않는다.
// 레포 관례(dm-lifecycle.supabase.mjs)에서 갈라진 점은 README 참조: order/limit 실제 구현 + 규모·지연·실패 파라미터 + 질의 로그.
//   ?n=1200      메시지 수(기본 260)
//   ?atts=160    첨부가 달린 옛 메시지 수(기본 160 — id 1..atts)
//   ?replies=1   메시지 절반에 reply_to 부여(리렌더 비용 측정용)
//   ?lag=150     msgr_attachments·msgr_reactions 질의 지연(ms) — 실망 왕복 모사. 런타임 변경은 window.__sbLag
// 런타임 훅: window.__sbCalls(질의 로그) · window.__sbLag({table:ms}) · window.__dmFixture.failNext("msgr_attachments:select")
const P = new URLSearchParams(location.search);
const NUM = (k, d) => Number(P.get(k) ?? d);
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid='user-me', org='org-fixture', now=new Date().toISOString();
const channel=(id,kind,name)=>({id,org_id:org,kind,name,created_by:uid,archived_at:null,admin_user_ids:[],crew_memory:true,personal_crews:true});
window.__sbCalls=[];
// 질의 지연(ms). 메시지 질의의 기본 60ms 는 장식이 아니다 — 지연 0이면 응답이 scroll 이벤트 처리 도중(마이크로태스크)에 끝나
// 바닥 고정(stick) 해제 리스너보다 먼저 prepend 가 커밋돼, 실사용에 없는 '바닥으로 끌림'이 픽스처에서만 재현된다.
window.__sbLag={msgr_messages:NUM('mlag',60),msgr_attachments:NUM('lag',0),msgr_reactions:NUM('lag',0)};
const state=window.__dmFixture={calls:[],failNext:null,tables:{
 msgr_org_members:[{user_id:uid,org_id:org,role:'owner',display_name:'Fixture Owner',removed_at:null,msgr_orgs:{id:org,name:'Fixture Organization',slug:'fixture',owner_user_id:uid}},{user_id:'user-other',org_id:org,role:'member',display_name:'Fixture Colleague',removed_at:null}],
 msgr_channels:[channel('general','public','Fixture General'),channel('existing-dm','dm','dm:Fixture Existing'),channel('private','private','Fixture Private')],
 msgr_crews:['new','existing'].map(id=>({id:`crew-${id}`,org_id:org,owner_user_id:uid,slug:`fixture-${id}`,display_name:`Fixture ${id==='new'?'New Agent':'Existing Agent'}`,hosting:'local',status:'active',last_seen_at:now,created_at:now,allow:'all'})),
 msgr_channel_members:[{channel_id:'general',member_kind:'user',member_id:uid},{channel_id:'existing-dm',member_kind:'user',member_id:uid},{channel_id:'existing-dm',member_kind:'crew',member_id:'crew-existing'},{channel_id:'private',member_kind:'user',member_id:uid},{channel_id:'private',member_kind:'crew',member_id:'crew-existing'}],
 msgr_messages:Array.from({length:NUM('n',260)},(_,i)=>({id:i+1,org_id:org,channel_id:'general',author_kind:'user',author_user_id:i%2?uid:'user-other',kind:'text',
  body:`MSG-${String(i+1).padStart(4,'0')}`,created_at:new Date(Date.parse(now)-(NUM('n',260)-i)*60000).toISOString(),
  deleted_at:null,edited_at:null,reply_to:(P.has('replies')&&i>0&&i%2?i:null),meta:null,mentions:[]})),
 msgr_attachments:Array.from({length:NUM('atts',160)},(_,i)=>({id:`att-${i+1}`,message_id:i+1,storage_path:`p/${i+1}`,name:`file-${String(i+1).padStart(4,'0')}.pdf`,mime:'application/pdf',bytes:2048})),
 msgr_target_prefs:[],msgr_channel_prefs:[],
}};
function result(call, action){if(state.holdNext===`${call.table||call.rpc}:${call.op||'rpc'}`){state.holdNext=null;return new Promise(resolve=>{state.release=()=>{state.release=null;resolve(result(call,action));};});}state.calls.push(structuredClone(call));if(state.failNext===`${call.table||call.rpc}:${call.op||'rpc'}`){state.failNext=null;return {data:null,error:{message:'Fixture temporary failure. Try again.'}};}const lag=(window.__sbLag||{})[call.table]||0;return lag?new Promise(r=>setTimeout(()=>r({data:action(),error:null}),lag)):{data:action(),error:null};}
function query(table){let op='select',values,cols='*',one=false,sort=null,cap=null;const filters=[];const api={
 select(c='*'){cols=c;return api;},eq(k,v){filters.push(r=>r[k]===v);return api;},is(k,v){filters.push(r=>(r[k]??null)===v);return api;},in(k,vs){filters.push(r=>vs.includes(r[k]));return api;},gt(k,v){filters.push(r=>r[k]>v);return api;},lt(k,v){filters.push(r=>r[k]<v);return api;},
 order(k,o){sort={k,asc:o?.ascending!==false};return api;},limit(n){cap=n;return api;},contains(){return api;},or(){return api;},ilike(){return api;},maybeSingle(){one=true;return api;},single(){one=true;return api;},
 upsert(v){op='upsert';values=v;return api;},update(v){op='update';values=v;return api;},delete(){op='delete';return api;},insert(v){op='insert';values=v;return api;},
 then(resolve,reject){return Promise.resolve(result({table,op,values},()=>{const all=state.tables[table]??=[];let rows=all.filter(r=>filters.every(f=>f(r)));
 if(op==='upsert'||op==='insert'){rows=(Array.isArray(values)?values:[values]).map(v=>{const keys=table==='msgr_target_prefs'?['user_id','org_id','target_kind','target_id']:['user_id','channel_id'];const old=op==='upsert'?all.find(r=>keys.every(k=>r[k]===v[k])):null;if(old){Object.assign(old,v);return old;}const row={...v};all.push(row);return row;});}
 else if(op==='update')rows.forEach(r=>Object.assign(r,values));else if(op==='delete')state.tables[table]=all.filter(r=>!rows.includes(r));
 if(table==='msgr_channel_members'&&cols.includes('msgr_channels'))rows=rows.map(r=>({...r,msgr_channels:state.tables.msgr_channels.find(c=>c.id===r.channel_id)}));
 if(sort)rows=[...rows].sort((a,b)=>(a[sort.k]>b[sort.k]?1:a[sort.k]<b[sort.k]?-1:0)*(sort.asc?1:-1));
 if(cap!=null)rows=rows.slice(0,cap);
 window.__sbCalls.push({table,op,sort,cap,n:rows.length});
 return structuredClone(one?rows[0]??null:rows);
 })).then(resolve,reject);},};return api;}
export const supabase={from:query,auth:{getSession:async()=>({data:{session:{user:{id:uid,email:'fixture@example.invalid'},access_token:'fixture'}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
 rpc:async(name,args)=>result({rpc:name,args},()=>{if(name==='msgr_create_channel'){const id=`created-dm-${state.tables.msgr_channels.length}`;state.tables.msgr_channels.push(channel(id,args.kind,args.name));state.tables.msgr_channel_members.push({channel_id:id,member_kind:'user',member_id:uid},...args.others.map(m=>({channel_id:id,member_kind:m.kind,member_id:m.id})));return id;}if(name==='msgr_leave_dm'){state.tables.msgr_channels=state.tables.msgr_channels.filter(c=>c.id!==args.ch);return true;}return [];}),
 realtime:{setAuth:async()=>{}},channel:()=>{const c={on:()=>c,subscribe:()=>c,send:async()=>{},unsubscribe:async()=>{}};return c;},removeChannel:async()=>'ok',removeAllChannels:async()=>{},storage:{from:()=>({remove:async()=>({data:[],error:null})})},
};
export async function q(p){const {data,error}=await p;if(error)throw new Error(error.message);return data;}
