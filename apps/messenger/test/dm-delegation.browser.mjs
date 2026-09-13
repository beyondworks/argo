import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts=new URL('../artifacts/dm-delegation/',import.meta.url);await mkdir(artifacts,{recursive:true});
const results=[];
for(const engine of (process.env.DM_ENGINE ? [process.env.DM_ENGINE] : ['chromium','webkit'])){
 const browser=await ({chromium,webkit}[engine]).launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
 for(const lang of ['ko','en']) for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await page.addInitScript(lang=>localStorage.setItem('argo-lang',lang),lang);
  const title=lang==='ko'?'수신 · 참조':'To · CC';const to=lang==='ko'?'수신 에이전트 추가':'Add To agent';const cc=lang==='ko'?'참조 에이전트 추가':'Add CC agent';
  try{
   await page.goto('http://127.0.0.1:5201/test/dm-lifecycle.fixture.html?recipientFailure');
   await page.locator('[data-sec="dms"] .item').filter({hasText:'Fixture Existing Agent'}).click();
   await page.getByRole('button',{name:title,exact:true}).click();
   await page.getByRole('button',{name:lang==='ko'?'다시 불러오기':'Reload recipients'}).waitFor();
   await page.locator('.msgr-composer textarea').fill('Ordinary DM while recipient loading failed');
   await page.getByRole('button',{name:lang==='ko'?'보내기':'Send',exact:true}).click();
   await page.waitForFunction(()=>window.__dmFixture.tables.msgr_messages.some(m=>m.body==='Ordinary DM while recipient loading failed'));
   await page.getByRole('button',{name:lang==='ko'?'다시 불러오기':'Reload recipients'}).click();
   await page.getByRole('combobox',{name:to,exact:true}).waitFor();
   assert.equal(await page.getByRole('combobox',{name:to,exact:true}).locator('option[value="crew-outdated"]').evaluate(el=>el.disabled),true);
   assert.equal(await page.getByRole('combobox',{name:to,exact:true}).locator('option[value="crew-unknown"]').evaluate(el=>el.disabled),true);
   await page.evaluate(()=>{window.__dmFixture.upgraded=true;});
   await page.getByRole('button',{name:lang==='ko'?'다시 불러오기':'Reload recipients'}).click();
   await page.waitForFunction(()=>!document.querySelector('option[value="crew-outdated"]')?.disabled);
   await page.getByRole('combobox',{name:to,exact:true}).selectOption('crew-new');
   await page.getByRole('combobox',{name:cc,exact:true}).selectOption('crew-existing');
   assert.equal(await page.getByRole('combobox',{name:lang==='ko'?'Fixture New Agent의 수신 방식':'Delivery role for Fixture New Agent'}).inputValue(),'to');
   await page.locator('.msgr-composer textarea').fill('Readiness changed after selection');
   await page.evaluate(()=>{window.__dmFixture.readiness={'crew-new':false};});
   await page.getByRole('button',{name:lang==='ko'?'다시 불러오기':'Reload recipients'}).click();
   await page.locator('.msgr-dm-delivery-warning').waitFor();
   assert.equal(await page.getByRole('button',{name:lang==='ko'?'보내기':'Send',exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:lang==='ko'?'Fixture New Agent 수신자 해제':'Remove recipient Fixture New Agent'}).click();
   await page.waitForFunction(()=>!document.querySelector('.msgr-dm-delivery-warning'));
   assert.equal(await page.getByRole('button',{name:lang==='ko'?'보내기':'Send',exact:true}).isEnabled(),true);
   await page.evaluate(()=>{window.__dmFixture.readiness={'crew-new':true};});
   await page.getByRole('button',{name:lang==='ko'?'다시 불러오기':'Reload recipients'}).click();
   await page.waitForFunction(()=>!document.querySelector('option[value="crew-new"]')?.disabled);
   await page.getByRole('combobox',{name:to,exact:true}).selectOption('crew-new');

   await page.screenshot({path:new URL(`${engine}-${lang}-${width}-selected.png`,artifacts).pathname});
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
   for(const name of [to,cc]){const b=await page.getByRole('combobox',{name,exact:true}).boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width);}
   const before=await page.evaluate(()=>structuredClone(window.__dmFixture.tables.msgr_channel_members));
   await page.locator('.msgr-composer textarea').fill('Delegate without inline names');
   await page.getByRole('button',{name:lang==='ko'?'보내기':'Send',exact:true}).click();
   await page.waitForFunction(()=>window.__dmFixture.tables.msgr_messages.some(m=>m.body==='Delegate without inline names'));
   const sent=await page.evaluate(()=>window.__dmFixture.tables.msgr_messages.find(m=>m.body==='Delegate without inline names'));
   assert.deepEqual(sent.mentions,[{kind:'crew',id:'crew-existing',role:'cc'},{kind:'crew',id:'crew-new',role:'to'}]);
   assert.deepEqual(await page.evaluate(()=>window.__dmFixture.tables.msgr_channel_members),before);
   await page.locator('.msgr-message-recipients').filter({hasText:'Fixture New Agent'}).waitFor();
   await page.locator('.msgr-composer textarea').fill('@all current DM only');
   await page.getByRole('button',{name:lang==='ko'?'보내기':'Send',exact:true}).click();
   await page.waitForFunction(()=>window.__dmFixture.tables.msgr_messages.some(m=>m.body==='@all current DM only'));
   const all=await page.evaluate(()=>window.__dmFixture.tables.msgr_messages.find(m=>m.body==='@all current DM only').mentions);
   assert.equal(all.some(m=>m.id==='crew-new'),false);assert.equal(all.some(m=>m.id==='crew-existing'),true);
   await page.getByRole('combobox',{name:cc,exact:true}).selectOption('crew-new');
   await page.locator('.msgr-composer textarea').fill('Context only to new agent');
   await page.getByRole('button',{name:lang==='ko'?'보내기':'Send',exact:true}).click();
   await page.waitForFunction(()=>window.__dmFixture.tables.msgr_messages.some(m=>m.body==='Context only to new agent'));
   assert.deepEqual(await page.evaluate(()=>window.__dmFixture.tables.msgr_messages.find(m=>m.body==='Context only to new agent').mentions),[{kind:'crew',id:'crew-new',role:'cc'}]);
   if(width<720)await page.getByRole('button',{name:lang==='ko'?'홈으로':'Home',exact:true}).click();
   await page.locator('[data-sec="channels"] .item').filter({hasText:'Fixture Private'}).click();
   assert.equal(await page.getByRole('button',{name:title,exact:true}).count(),0,'private channels do not gain DM recipients UI');
   await page.locator('.msgr-composer textarea').fill('@Fixture New Agent');
   await page.getByRole('button',{name:lang==='ko'?'보내기':'Send',exact:true}).click();
   await page.waitForFunction(()=>window.__dmFixture.tables.msgr_messages.some(m=>m.body==='@Fixture New Agent'&&m.channel_id==='private'));
   assert.deepEqual(await page.evaluate(()=>window.__dmFixture.tables.msgr_messages.find(m=>m.body==='@Fixture New Agent'&&m.channel_id==='private').mentions),[],'private candidate scope unchanged');
   assert.deepEqual(errors,[]);results.push({engine,lang,width,pass:true});console.log('PASS',engine,lang,width);
  }catch(e){results.push({engine,lang,width,pass:false,error:e.message});console.error('FAIL',engine,lang,width,e.stack);await page.screenshot({path:new URL(`${engine}-${lang}-${width}-failure.png`,artifacts).pathname});}
  await page.close();
 }
 await browser.close();
}
await writeFile(new URL('results.json',artifacts),JSON.stringify(results,null,2));if(results.some(r=>!r.pass))process.exitCode=1;
