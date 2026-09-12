// Actual App + isolated DM backend; never writes to a live account.
// SCROLL_TEST_PORT=5207 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/mobile-scroll.browser.mjs
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.SCROLL_ENGINE||'chromium';
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
const artifacts=new URL(`../artifacts/mobile-scroll/${process.env.SCROLL_VARIANT||'current'}-${engine}/`,import.meta.url);
await mkdir(artifacts,{recursive:true});
const results=[];
const url=`http://127.0.0.1:${process.env.SCROLL_TEST_PORT||5207}/test/dm-lifecycle.fixture.html`;
async function setup(width,height,lang,reducedMotion='no-preference'){
 const page=await browser.newPage({viewport:{width,height},hasTouch:true,isMobile:engine==='chromium',reducedMotion});page.setDefaultTimeout(5000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.addInitScript(({lang})=>{
  localStorage.setItem('argo-lang',lang);let state;
  Object.defineProperty(window,'__dmFixture',{configurable:true,get:()=>state,set:v=>{state=v;
   const seed=v.tables.msgr_crews[0];for(let n=1;n<=38;n++)v.tables.msgr_crews.push({...seed,id:`extra-${n}`,slug:`extra-${n}`,display_name:`ZZ Agent ${String(n).padStart(2,'0')}`});
   const msg=v.tables.msgr_messages[0];for(let n=1;n<=60;n++)v.tables.msgr_messages.push({...msg,id:101+n,body:`Scroll history ${String(n).padStart(2,'0')} — preserved message`,created_at:new Date(Date.parse(msg.created_at)+n*1000).toISOString()});
  }});
 },{lang});
 await page.goto(url);await page.locator('[data-sec="mine"] .item').last().waitFor();return {page,errors};
}
async function bounds(page,selector){return page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,overscrollY:getComputedStyle(el).overscrollBehaviorY};});}
async function wheel(page,selector,direction=1){const box=await page.locator(selector).boundingBox();await page.mouse.move(box.x+box.width/2,Math.max(box.y+20,Math.min(box.y+box.height/2,page.viewportSize().height-180)));for(let n=0;n<12;n++){await page.mouse.wheel(0,1000*direction);await page.waitForTimeout(90);}}
async function swipe(page,direction=1){const {width,height}=page.viewportSize();const x=width/2,start=direction>0?height-190:140,end=direction>0?140:height-190;const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start}]});for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start+(end-start)*i/8}]});await page.waitForTimeout(20);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(350);await cdp.detach();}
async function test(width,height,lang,name,fn,motion){if(process.env.SCROLL_FILTER&&!name.match(process.env.SCROLL_FILTER))return;const {page,errors}=await setup(width,height,lang,motion);const key=`${width}-${height}-${lang}-${name}`;try{const metrics=await fn(page);assert.deepEqual(errors,[]);await page.screenshot({path:new URL(`${key}.png`,artifacts).pathname});results.push({width,height,lang,name,passed:true,metrics});console.log('PASS',key);}catch(e){await page.screenshot({path:new URL(`${key}-failure.png`,artifacts).pathname});results.push({width,height,lang,name,passed:false,error:e.message});console.error('FAIL',key,e.message);}finally{await page.close();}}
try{
 for(const [width,height,lang] of [[320,568,'ko'],[390,844,'en']]){
  await test(width,height,lang,'home-bottom-and-section',async page=>{
   await wheel(page,'.msgr-railbody');const rail=await bounds(page,'.msgr-railbody'),last=await bounds(page,'[data-sec="mine"] .item:last-child'),tab=await bounds(page,'.msgr-tabbar');
   assert.ok(rail.scrollTop>100,'Home did not scroll');assert.ok(last.bottom<=tab.top-8,`Last agent is covered: ${JSON.stringify({last,tab})}`);
   assert.ok(last.top>=rail.top,'Last agent is above viewport');const search=await bounds(page,'.msgr-tabsearch');assert.ok(search.right<=width+1,`Bottom search button clipped: ${JSON.stringify(search)}`);
   await wheel(page,'.msgr-railbody',-1);
   // The last section header must be reachable without Playwright auto-scrolling it.
   const header=page.locator('[data-sec="mine"] > summary');for(let i=0;i<12;i++){const b=await header.boundingBox();if(b.y>=rail.top&&b.y+b.height<=tab.top-8)break;await page.mouse.move(width/2,Math.min(height/2,tab.top-40));await page.mouse.wheel(0,140);await page.waitForTimeout(70);}
   const h=await header.boundingBox();assert.ok(h.y>=rail.top&&h.y+h.height<=tab.top-8,'Agent section header cannot be reached above bottom menu');
   await page.mouse.click(h.x+30,h.y+h.height/2);assert.equal(await page.locator('[data-sec="mine"]').getAttribute('open'),null);
   const collapsed=await header.boundingBox();await page.mouse.click(collapsed.x+30,collapsed.y+collapsed.height/2);assert.notEqual(await page.locator('[data-sec="mine"]').getAttribute('open'),null);
   await wheel(page,'.msgr-railbody');return {rail,last,tab};
  });
  if(engine==='chromium')await test(width,height,lang,'home-touch',async page=>{const before=await bounds(page,'.msgr-railbody');await swipe(page);const after=await bounds(page,'.msgr-railbody');assert.ok(after.scrollTop>before.scrollTop+20,'Native touch swipe did not scroll');return {before,after};});
  await test(width,height,lang,'chat-scroll',async page=>{
   await page.locator('[data-sec="dms"] .item').first().click();await page.getByText('Scroll history 60 — preserved message',{exact:true}).waitFor();await wheel(page,'.msgr-thread',-1);const top=await bounds(page,'.msgr-thread');assert.ok(top.scrollTop<5,`Cannot reach chat beginning: ${JSON.stringify(top)}`);
   await wheel(page,'.msgr-thread');const bottom=await bounds(page,'.msgr-thread'),last=await page.getByText('Scroll history 60 — preserved message',{exact:true}).boundingBox(),composer=await bounds(page,'.msgr-composer');assert.ok(bottom.scrollTop>20);assert.ok(last.y+last.height<=composer.top,'Latest message is behind composer');return {top,bottom,composer};
  });
  await test(width,height,lang,'settings-scroll',async page=>{
   await page.locator('.msgr-foot > button.me').click();await page.locator('.msgr-thread.page .msgr-settings').waitFor();const nav=await page.locator('.msgr-setnav').innerText();
   const buttons=page.locator('.msgr-setnav button');for(let i=0;i<await buttons.count();i++){const text=await buttons.nth(i).innerText();if(/외관|Appearance|일반|General/.test(text)){await buttons.nth(i).click();break;}}
   await wheel(page,'.msgr-thread.page');const scroller=await bounds(page,'.msgr-thread.page'),tab=await bounds(page,'.msgr-tabbar');assert.ok(scroller.bottom<=tab.top-8,`Settings viewport covered by tabbar: ${JSON.stringify({scroller,tab})}`);assert.ok(scroller.scrollWidth<=scroller.clientWidth+1,`Settings contents exceed screen width: ${JSON.stringify(scroller)}`);return {scroller,tab,nav};
  });
  await test(width,height,lang,'reduced-motion-scroll',async page=>{assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);await wheel(page,'.msgr-railbody');const last=await bounds(page,'[data-sec="mine"] .item:last-child'),tab=await bounds(page,'.msgr-tabbar');assert.ok(last.bottom<=tab.top-8);return {last,tab};},'reduce');
 }
}finally{await writeFile(new URL('results.json',artifacts),JSON.stringify(results,null,2));await browser.close();}
assert.ok(results.every(r=>r.passed),`${results.filter(r=>!r.passed).length} failed scenarios`);
