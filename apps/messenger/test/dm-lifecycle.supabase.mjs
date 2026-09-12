// Browser-only fixture: no credentials or production client imported.
export const configured = true, customServer = false, SB_URL = 'http://fixture.invalid', SB_ANON = 'fixture';
const uid='user-me', org='org-fixture', now=new Date().toISOString();
const channel=(id,kind,name)=>({id,org_id:org,kind,name,created_by:uid,archived_at:null,admin_user_ids:[],crew_memory:true,personal_crews:true});
const state=window.__dmFixture={calls:[],failNext:null,tables:{
 msgr_org_members:[{user_id:uid,org_id:org,role:'owner',display_name:'Fixture Owner',removed_at:null,msgr_orgs:{id:org,name:'Fixture Organization',slug:'fixture',owner_user_id:uid}},{user_id:'user-other',org_id:org,role:'member',display_name:'Fixture Colleague',removed_at:null}],
 msgr_channels:[channel('general','public','Fixture General'),channel('existing-dm','dm','dm:Fixture Existing'),channel('private','private','Fixture Private')],
 msgr_crews:['new','existing'].map(id=>({id:`crew-${id}`,org_id:org,owner_user_id:uid,slug:`fixture-${id}`,display_name:`Fixture ${id==='new'?'New Agent':'Existing Agent'}`,hosting:'local',status:'active',last_seen_at:now,created_at:now,allow:'all'})),
 msgr_channel_members:[{channel_id:'existing-dm',member_kind:'user',member_id:uid},{channel_id:'existing-dm',member_kind:'crew',member_id:'crew-existing'},{channel_id:'private',member_kind:'user',member_id:uid},{channel_id:'private',member_kind:'crew',member_id:'crew-existing'}],
 msgr_messages:[{id:101,org_id:org,channel_id:'existing-dm',author_kind:'user',author_user_id:uid,kind:'text',body:'Existing conversation must survive favorite changes.',created_at:now,deleted_at:null,mentions:[]}],
 msgr_target_prefs:[],msgr_channel_prefs:[],
}};
function result(call, action){if(state.holdNext===`${call.table||call.rpc}:${call.op||'rpc'}`){state.holdNext=null;return new Promise(resolve=>{state.release=()=>{state.release=null;resolve(result(call,action));};});}state.calls.push(structuredClone(call));if(state.failNext===`${call.table||call.rpc}:${call.op||'rpc'}`){state.failNext=null;return {data:null,error:{message:'Fixture temporary failure. Try again.'}};}return {data:action(),error:null};}
function query(table){let op='select',values,cols='*',one=false;const filters=[];const api={
 select(c='*'){cols=c;return api;},eq(k,v){filters.push(r=>r[k]===v);return api;},is(k,v){filters.push(r=>(r[k]??null)===v);return api;},in(k,vs){filters.push(r=>vs.includes(r[k]));return api;},gt(k,v){filters.push(r=>r[k]>v);return api;},lt(k,v){filters.push(r=>r[k]<v);return api;},
 order(){return api;},limit(){return api;},contains(){return api;},or(){return api;},ilike(){return api;},maybeSingle(){one=true;return api;},single(){one=true;return api;},
 upsert(v){op='upsert';values=v;return api;},update(v){op='update';values=v;return api;},delete(){op='delete';return api;},insert(v){op='insert';values=v;return api;},
 then(resolve,reject){return Promise.resolve(result({table,op,values},()=>{const all=state.tables[table]??=[];let rows=all.filter(r=>filters.every(f=>f(r)));
 if(op==='upsert'||op==='insert'){rows=(Array.isArray(values)?values:[values]).map(v=>{const keys=table==='msgr_target_prefs'?['user_id','org_id','target_kind','target_id']:['user_id','channel_id'];const old=op==='upsert'?all.find(r=>keys.every(k=>r[k]===v[k])):null;if(old){Object.assign(old,v);return old;}const row={...v};all.push(row);return row;});}
 else if(op==='update')rows.forEach(r=>Object.assign(r,values));else if(op==='delete')state.tables[table]=all.filter(r=>!rows.includes(r));
 if(table==='msgr_channel_members'&&cols.includes('msgr_channels'))rows=rows.map(r=>({...r,msgr_channels:state.tables.msgr_channels.find(c=>c.id===r.channel_id)}));
 return structuredClone(one?rows[0]??null:rows);
 })).then(resolve,reject);},};return api;}
export const supabase={from:query,auth:{getSession:async()=>({data:{session:{user:{id:uid,email:'fixture@example.invalid'},access_token:'fixture'}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
 rpc:async(name,args)=>result({rpc:name,args},()=>{if(name==='msgr_create_channel'){const id=`created-dm-${state.tables.msgr_channels.length}`;state.tables.msgr_channels.push(channel(id,args.kind,args.name));state.tables.msgr_channel_members.push({channel_id:id,member_kind:'user',member_id:uid},...args.others.map(m=>({channel_id:id,member_kind:m.kind,member_id:m.id})));return id;}if(name==='msgr_leave_dm'){state.tables.msgr_channels=state.tables.msgr_channels.filter(c=>c.id!==args.ch);return true;}return [];}),
 realtime:{setAuth:async()=>{}},channel:()=>{const c={on:()=>c,subscribe:()=>c,send:async()=>{},unsubscribe:async()=>{}};return c;},removeChannel:async()=>'ok',removeAllChannels:async()=>{},storage:{from:()=>({remove:async()=>({data:[],error:null})})},
};
export async function q(p){const {data,error}=await p;if(error)throw new Error(error.message);return data;}
