// Isolated actual-App layout regression; only in-memory fixture data is modified.
const {chromium,webkit} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out=new URL('../artifacts/mobile-header',import.meta.url).pathname;await mkdir(out,{recursive:true});const results=[];
for(const engine of ['chromium','webkit']){const b=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
for(const width of [320,390,430,1280])for(const lang of ['ko','en']){
const p=await b.newPage({viewport:{width,height:844}});await p.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
await p.addInitScript(lang=>{localStorage.setItem('argo-lang',lang);localStorage.setItem('argo-theme','linen-'+(lang==='ko'?'light':'dark'));localStorage.setItem('argo-mode',lang==='ko'?'light':'dark');},lang);
await p.goto(`http://127.0.0.1:${process.env.WORK_TEST_PORT || 5217}/test/work-panel.fixture.html`);await p.locator('[data-sec="channels"] .item').filter({hasText:'Fixture General'}).click();
const header=p.locator('.msgr-top');const work=header.locator('.msgr-work-button');await work.waitFor();await p.emulateMedia({reducedMotion:'reduce'});await p.waitForFunction(()=>!document.getAnimations().some(a=>a.playState==='running')); 
const rect=await work.boundingBox();const members=await header.locator('.members').boundingBox();
if(width<720){assert.ok(rect.height>=44);assert.ok(Math.abs(rect.y-members.y)<1);assert.ok(rect.x+rect.width<=members.x+1);assert.equal(await header.locator('.msgr-hchips').isVisible(),false);}
await work.focus();await p.keyboard.press('Enter');await p.locator('.work-header').waitFor();await p.locator('.work-header button').click();await p.waitForFunction(()=>document.querySelector('.msgr-work-button')===document.activeElement);
await header.locator('.members').click();const pref=p.locator('.msgr-channel-notifications button');await pref.waitFor();assert.equal(await pref.getAttribute('aria-pressed'),'false');await pref.click();await p.waitForFunction(()=>document.querySelector('.msgr-channel-notifications button')?.getAttribute('aria-pressed')==='true');await pref.click();await p.waitForFunction(()=>document.querySelector('.msgr-channel-notifications button')?.getAttribute('aria-pressed')==='false');await p.locator('.msgr-crewsheet .head button').click();
// Stress the actual title element with a long channel name; this is a layout fixture only.
if(width<720) await header.locator('.msgr-channel-name').evaluate(el=>{el.textContent='Lean-VPS International Sales and Operations Planning';});
const dims=await header.evaluate(el=>{const name=el.querySelector('.msgr-channel-name'),title=el.querySelector('.title'),sub=el.querySelector('.msgr-sub');return{scroll:document.documentElement.scrollWidth,viewport:innerWidth,title:title.getBoundingClientRect().toJSON(),sub:sub?.getBoundingClientRect().toJSON(),name:name?.getBoundingClientRect().toJSON()};});
assert.ok(dims.scroll<=width);if(width<720){assert.ok(dims.name.right<=rect.x);assert.ok(dims.title.bottom<=dims.sub.y+1);}
await p.screenshot({path:`${out}/${engine}-${width}-${lang}.png`});results.push({engine,width,lang,passed:true,work:rect,header:dims});await p.close();
}await b.close();}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));console.log(`${results.length} header, work-open/focus-return, notification toggles and long-name scenarios passed`);
