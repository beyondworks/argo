// Start Vite: node node_modules/vite/bin/vite.js --config test/dm-lifecycle.config.mjs
// Run: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/dm-lifecycle.browser.mjs
// Uses actual main.jsx/App.jsx/providers and DOM. Fake backend + external request blocking prevent live writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome'});
const artifacts=new URL(`../artifacts/dm-lifecycle${process.env.DM_TEST_VARIANT ? `-${process.env.DM_TEST_VARIANT}` : ''}/`,import.meta.url);
await mkdir(artifacts,{recursive:true});
const results=[];
const labels={ko:{fav:'즐겨찾기에 추가',unfav:'즐겨찾기 해제',dm:'1:1 대화',leave:'대화 나가기',archive:'대화 보관',delete:'대화 삭제',cancel:'취소',home:'홈으로',phrase:'삭제하겠습니다',privateLeave:'채널 나가기',up:'즐겨찾기 위로 이동'},en:{fav:'Add to favorites',unfav:'Remove from favorites',dm:'Direct message',leave:'Leave conversation',archive:'Archive conversation',delete:'Delete conversation',cancel:'Cancel',home:'Home',phrase:'delete this',privateLeave:'Leave channel',up:'Move favorite up'}};
async function scenario(lang,width,name,fn){
 if (process.env.DM_TEST_FILTER && !`${lang}/${width}/${name}`.match(process.env.DM_TEST_FILTER)) return;
 const page=await browser.newPage({viewport:{width,height:900}}); const errors=[]; page.setDefaultTimeout(5000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.addInitScript(lang=>localStorage.setItem('argo-lang',lang),lang);
 try{
  await page.goto(`http://127.0.0.1:${process.env.DM_TEST_PORT || 5197}/test/dm-lifecycle.fixture.html`);
  await page.locator('[data-sec="mine"] .item').filter({hasText:'Fixture New Agent'}).waitFor();
  await fn(page,labels[lang]); assert.deepEqual(errors,[]);
  results.push({lang,width,name,passed:true});console.log('PASS',lang,width,name);
 }catch(e){await page.screenshot({path:new URL(`failure-${lang}-${width}-${name}.png`,artifacts).pathname});results.push({lang,width,name,passed:false,error:e.message});console.error('FAIL',lang,width,name,e.message);}
 finally{await page.close();}
}
const row=(p,section,name)=>p.locator(`[data-sec="${section}"] .item`).filter({hasText:name}).first();
async function menu(p,section,name,label){await row(p,section,name).click({button:'right'});await p.getByRole('menuitem',{name:label,exact:true}).click();}
async function calls(p){return p.evaluate(()=>window.__dmFixture.calls.filter(c=>(c.op&&c.op!=='select')||c.rpc==='msgr_create_channel'||c.rpc==='msgr_leave_dm'));}
async function creations(p){return (await calls(p)).filter(c=>c.rpc==='msgr_create_channel');}
async function home(p,l,width){if(width<720){const b=p.getByRole('button',{name:l.home,exact:true});if(await b.isVisible())await b.click();}}
async function visibleDialog(p,label){await p.locator('.card-title').filter({hasText:label}).waitFor({state:'visible'});const d=p.getByRole('dialog',{name:label,exact:true});await d.waitFor();await d.locator('.card').waitFor({state:'visible'});assert.equal(await d.evaluate(el=>el.parentElement===document.body),true);return d;}
try{
for(const [lang,width] of [['ko',1280],['en',1280],['ko',390],['en',390]]){
 await scenario(lang,width,'target-favorites',async(p,l)=>{
  for(const [section,name,kind,id] of [['mine','Fixture New Agent','crew','crew-new'],['people','Fixture Colleague','user','user-other']]){
   await menu(p,section,name,l.fav); await row(p,'fav',name).waitFor();
   assert.equal((await creations(p)).length,0); assert.equal(await p.locator('[data-sec="dms"] .item').count(),1);
   assert.ok((await calls(p)).some(c=>c.table==='msgr_target_prefs'&&c.values.some(v=>v.target_kind===kind&&v.target_id===id&&v.pinned===true)));
   await menu(p,'fav',name,l.unfav);await row(p,'fav',name).waitFor({state:'detached'});
   assert.equal((await creations(p)).length,0); assert.equal(await p.locator('[data-sec="dms"] .item').count(),1);
  }
  await menu(p,'mine','Fixture New Agent',l.fav);await row(p,'fav','Fixture New Agent').click();
  await p.waitForFunction(()=>window.__dmFixture.calls.some(c=>c.rpc==='msgr_create_channel'));
  await home(p,l,width);await menu(p,'mine','Fixture New Agent',l.dm);await home(p,l,width);
  assert.equal((await creations(p)).length,1);assert.equal(await p.locator('[data-sec="dms"] .item').count(),2);
  await p.screenshot({path:new URL(`favorites-${lang}-${width}.png`,artifacts).pathname});
 });
 await scenario(lang,width,'delayed-favorite-reorder',async(p,l)=>{
  await menu(p,'mine','Fixture New Agent',l.fav);await row(p,'fav','Fixture New Agent').waitFor();
  await menu(p,'people','Fixture Colleague',l.fav);await row(p,'fav','Fixture Colleague').waitFor();
  await p.evaluate(()=>window.__dmFixture.holdNext='msgr_target_prefs:upsert');
  await menu(p,'fav','Fixture New Agent',l.up);await p.waitForFunction(()=>!!window.__dmFixture.release);
  await row(p,'fav','Fixture New Agent').click({button:'right'});
  assert.equal(await p.getByRole('menuitem',{name:l.unfav,exact:true}).isDisabled(),true);
  assert.equal(await p.getByRole('menuitem',{name:l.up,exact:true}).isDisabled(),true);
  await p.keyboard.press('Escape');await p.evaluate(()=>window.__dmFixture.release());
  await p.waitForFunction(()=>window.__dmFixture.tables.msgr_target_prefs.find(p=>p.target_id==='crew-new')?.pin_pos===0);
  await row(p,'fav','Fixture New Agent').click({button:'right'});assert.equal(await p.getByRole('menuitem',{name:l.unfav,exact:true}).isEnabled(),true);
  await p.keyboard.press('Escape');assert.equal((await creations(p)).length,0);
 });
 await scenario(lang,width,'populated-dm',async(p,l)=>{
  await menu(p,'dms','Fixture Existing Agent',l.fav);await row(p,'fav','Fixture Existing Agent').waitFor();
  await menu(p,'fav','Fixture Existing Agent',l.unfav);await row(p,'dms','Fixture Existing Agent').click();
  await p.getByText('Existing conversation must survive favorite changes.',{exact:true}).waitFor();
  assert.equal((await creations(p)).length,0);assert.equal(await p.evaluate(()=>window.__dmFixture.tables.msgr_messages.length),1);
 });
 for(const kind of ['leave','archive','delete'])await scenario(lang,width,kind,async(p,l)=>{
  await menu(p,'dms','Fixture Existing Agent',l[kind]);let d=await visibleDialog(p,l[kind]);
  assert.equal((await calls(p)).length,0);
  await p.keyboard.press('Escape');await d.waitFor({state:'detached'});assert.equal((await calls(p)).length,0);
  await menu(p,'dms','Fixture Existing Agent',l[kind]);d=await visibleDialog(p,l[kind]);
  if(kind==='delete'){
   const confirm=d.getByRole('button',{name:l.delete,exact:true});assert.equal(await confirm.isDisabled(),true);
   await d.locator('input').nth(0).fill('Fixture Existing Agent');assert.equal(await confirm.isDisabled(),true);
   await d.locator('input').nth(1).fill(l.phrase);assert.equal(await confirm.isEnabled(),true);
  }
  const fail=kind==='leave'?'msgr_leave_dm:rpc':`msgr_channels:${kind==='archive'?'update':'delete'}`;
  await p.evaluate(fail=>window.__dmFixture.failNext=fail,fail);
  await d.getByRole('button',{name:l[kind],exact:true}).click();
  await d.getByRole('alert').waitFor();assert.match(await d.innerText(),/Fixture temporary failure/);assert.equal(await d.getByRole('button',{name:l[kind],exact:true}).isEnabled(),true);
  await p.screenshot({path:new URL(`${kind}-${lang}-${width}.png`,artifacts).pathname});
  await d.getByRole('button',{name:l[kind],exact:true}).click();await d.waitFor({state:'detached'});
  await row(p,'dms','Fixture Existing Agent').waitFor({state:'detached'});
  const changed=await calls(p);assert.equal(changed.filter(c=>kind==='leave'?c.rpc==='msgr_leave_dm':c.table==='msgr_channels'&&c.op===(kind==='archive'?'update':'delete')).length,2);
 });
 await scenario(lang,width,'leave-refresh-failure',async(p,l)=>{
  await menu(p,'dms','Fixture Existing Agent',l.leave);const d=await visibleDialog(p,l.leave);
  await p.evaluate(()=>window.__dmFixture.failNext='msgr_channels:select');
  await d.getByRole('button',{name:l.leave,exact:true}).click();await d.waitFor({state:'detached'});
  await row(p,'dms','Fixture Existing Agent').waitFor({state:'detached'});
  assert.equal((await calls(p)).filter(c=>c.rpc==='msgr_leave_dm').length,1);
 });
 if(width<720)await scenario(lang,width,'short-mobile-dialog',async(p,l)=>{
  await p.setViewportSize({width,height:430});await menu(p,'dms','Fixture Existing Agent',l.delete);
  const d=await visibleDialog(p,l.delete);const card=d.locator('.card');const rect=await card.boundingBox();
  assert.ok(rect.y>=0&&rect.y+rect.height<=430,`Dialog exceeds short viewport: ${JSON.stringify(rect)}`);
  assert.equal(await d.evaluate(el=>el.contains(document.activeElement)),true);
  await p.keyboard.press('Tab');assert.equal(await d.evaluate(el=>el.contains(document.activeElement)),true);
  await p.keyboard.press('Shift+Tab');assert.equal(await d.evaluate(el=>el.contains(document.activeElement)),true);
  await d.locator('input').nth(0).fill('Fixture Existing Agent');await d.locator('input').nth(1).fill(l.phrase);
  await d.getByRole('button',{name:l.delete,exact:true}).scrollIntoViewIfNeeded();
  await p.screenshot({path:new URL(`short-dialog-${lang}-${width}.png`,artifacts).pathname});
 });
 await scenario(lang,width,'private-owner-guard',async(p,l)=>{
  await menu(p,'channels','Fixture Private',l.privateLeave);const d=await visibleDialog(p,l.privateLeave);
  await d.getByRole('button',{name:l.privateLeave,exact:true}).click();await d.getByRole('alert').waitFor();
  assert.equal((await calls(p)).some(c=>c.table==='msgr_channel_members'&&c.op==='delete'),false);
  assert.equal(await d.getByRole('button',{name:l.privateLeave,exact:true}).isEnabled(),true);
 });
}
}finally{await writeFile(new URL('results.json',artifacts),JSON.stringify(results,null,2));await browser.close();}
assert.ok(results.every(r=>r.passed),`${results.filter(r=>!r.passed).length} browser scenarios failed`);
