// Scripted regression in a fresh browser context; external network is blocked.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.WORK_ENGINE || 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
const artifacts = new URL(`../artifacts/work-panel-${engine}/`, import.meta.url);
await mkdir(artifacts, { recursive: true });
const results = [];
const labels = ['work.result.stalled','work.title','work.start','work.goal','work.completion','work.discussion','work.cancel','work.resume','work.empty','work.tab.automations','automation.new','automation.name','automation.prompt','automation.crew','automation.repeat','automation.timezone','automation.history','automation.edit','automation.pause','automation.resume','automation.run','automation.delete','ui.save','ui.cancel','ui.close','work.retry','work.refresh','work.error.upgrade','work.next','work.previous'];
const button = (p, l, key) => p.getByRole('button', { name: l[key], exact: true });
const field = (p, l, key) => p.locator('label.work-field').filter({ has: p.page().locator('span').filter({ hasText: new RegExp(`^${l[key].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`) }) }).locator('input,textarea,select');
async function scenario(lang, width, theme, name, fn) {
  const id = `${lang}-${width}-${theme}-${name}`;
  if (process.env.WORK_FILTER && !id.match(process.env.WORK_FILTER)) return;
  const page = await browser.newPage({ viewport: { width, height: width < 720 ? 780 : 900 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(({ lang, theme }) => { localStorage.setItem('argo-lang', lang); localStorage.setItem('argo-theme', `linen-${theme}`); localStorage.setItem('argo-theme-base','linen'); localStorage.setItem('argo-mode', theme); }, { lang, theme });
  try {
    await page.goto(`http://127.0.0.1:${process.env.WORK_TEST_PORT || 5217}/test/work-panel.fixture.html`);
    await page.locator('[data-sec="channels"] .item').filter({ hasText: 'Fixture General' }).click();
    await page.waitForFunction(()=>typeof window.__workTranslate==='function');
    const l = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, window.__workTranslate(key)])), labels);
    assert.notEqual(l['work.title'], 'work.title', 'Work translations must be registered');
    await fn(page, l);
    assert.deepEqual(errors, []);
    results.push({ id, passed: true }); console.log('PASS', id);
  } catch (error) {
    await page.screenshot({ path: new URL(`failure-${id}.png`, artifacts).pathname });
    results.push({ id, passed: false, error: error.message, stack: error.stack }); console.error('FAIL', id, error.stack);
  } finally { await page.close(); }
}
async function open(p,l) { await button(p,l,'work.title').focus();await p.keyboard.press('Enter'); const dialog=p.getByRole('dialog',{name:l['work.title'],exact:true}); await dialog.waitFor(); return dialog; }
async function calls(p,name) { return p.evaluate(name=>window.__workFixture.workCalls.filter(call=>call.name===name),name); }
async function tab(p,l) { await p.getByRole('tab',{name:l['work.tab.automations'],exact:true}).click(); }
async function createAutomation(p,l,title='Fixture automation') {
  await button(p,l,'automation.new').click();
  await field(p,l,'automation.name').fill(title); await field(p,l,'automation.prompt').fill('Summarize this channel without sending external messages.');
  await field(p,l,'automation.crew').selectOption('crew-new'); await field(p,l,'automation.timezone').fill('Asia/Seoul');
  await button(p,l,'ui.save').click(); await p.locator('.work-item').filter({hasText:title}).waitFor();
}
try {
  for(const [lang,width,theme] of [['ko',1280,'light'],['en',1280,'dark'],['ko',390,'light'],['en',390,'dark']]) {
    await scenario(lang,width,theme,'team-create-discussion-cancel',async(p,l)=>{
      const d=await open(p,l); await p.locator('.work-empty').waitFor();
      assert.equal(await button(d,l,'work.start').isDisabled(),true);
      await field(d,l,'work.goal').fill('Prepare a fixture launch plan'); await field(d,l,'work.completion').fill('Two concrete milestones');
      await p.evaluate(()=>window.__workFixture.hold='msgr_work_create');
      await button(d,l,'work.start').click(); await p.waitForFunction(()=>!!window.__workFixture.release);
      assert.equal(await button(d,l,'ui.close').isDisabled(),true); assert.equal(await field(d,l,'work.goal').isDisabled(),true);
      await p.keyboard.press('Escape'); assert.equal(await d.isVisible(),true);
      await p.evaluate(()=>window.__workFixture.release());
      await p.getByText('Fixture team discussion',{exact:true}).waitFor(); assert.equal((await calls(p,'msgr_work_create')).length,1);
      const run=p.locator('.work-item');
      await p.evaluate(()=>window.__workFixture.tables.msgr_work_runs[0].status='blocked'); await button(d,l,'work.refresh').click();
      await run.getByText(l['work.result.stalled'],{exact:true}).waitFor({timeout:3000}); // D48: 결과 없는 도움 필요 = 판정 없는 정지 — 사용자 언어로 이유를 보인다
      await p.evaluate(()=>{window.__workFixture.tables.msgr_work_runs[0].result='Need API access';}); await button(d,l,'work.refresh').click();
      await run.getByText('Need API access').waitFor(); assert.equal(await run.getByText(l['work.result.stalled'],{exact:true}).count(),0,'결과가 있으면 그 결과를 보인다');
      await p.evaluate(()=>{window.__workFixture.tables.msgr_work_runs[0].result='';}); await button(d,l,'work.refresh').click();
      assert.equal(await run.getByText(l['work.result.stalled'],{exact:true}).count(),0,'빈 명시적 blocked 결과도 무판정 정지로 오인하지 않는다');
      await p.evaluate(()=>{window.__workFixture.tables.msgr_work_runs[0].result=null;});
      await field(run,l,'work.resume').fill('Use the provided fixture milestones.');
      await p.evaluate(()=>window.__workFixture.fail='msgr_work_resume'); await button(run,l,'work.resume').click(); await d.getByRole('alert').waitFor();
      assert.equal(await field(run,l,'work.resume').inputValue(),'Use the provided fixture milestones.');
      await button(run,l,'work.resume').click(); await p.waitForFunction(()=>window.__workFixture.tables.msgr_work_runs[0].status==='planning');
      const resumes=await calls(p,'msgr_work_resume');assert.equal(resumes.length,2);assert.equal(resumes[0].args.p_request,resumes[1].args.p_request);
      await button(run,l,'work.cancel').click();
      await p.waitForFunction(()=>window.__workFixture.tables.msgr_work_runs[0].status==='cancelled');
      assert.equal(await button(run,l,'work.cancel').count(),0);
      await p.screenshot({path:new URL(`team-${lang}-${width}-${theme}.png`,artifacts).pathname});
      await d.locator('.work-header button').click(); await d.waitFor({state:'detached'});
      assert.equal(await button(p,l,'work.title').evaluate(el=>el===document.activeElement),true);
    });
    await scenario(lang,width,theme,'errors-loading-unavailable',async(p,l)=>{
      await p.evaluate(()=>window.__workFixture.hold='msgr_work_runs'); const d=await open(p,l);
      await p.waitForFunction(()=>!!window.__workFixture.release); assert.equal(await button(d,l,'work.start').isDisabled(),true);
      await p.evaluate(()=>{window.__workFixture.unavailable=true;window.__workFixture.release();});
      await d.getByRole('alert').waitFor(); await d.getByText(l['work.error.upgrade'],{exact:true}).waitFor();
      await field(d,l,'work.goal').fill('Preserve this draft on retry'); assert.equal(await button(d,l,'work.start').isDisabled(),true);
      await p.evaluate(()=>window.__workFixture.unavailable=false); await button(d,l,'work.retry').first().click();
      await p.locator('.work-empty').waitFor();
      await p.evaluate(()=>window.__workFixture.fail='msgr_work_create'); await button(d,l,'work.start').click(); await d.getByRole('alert').waitFor();
      assert.equal(await field(d,l,'work.goal').inputValue(),'Preserve this draft on retry');
      await button(d,l,'work.start').click(); await p.getByText('Fixture team discussion',{exact:true}).waitFor();
      const attempts=await calls(p,'msgr_work_create'); assert.equal(attempts.length,2);assert.equal(attempts[0].args.p_request,attempts[1].args.p_request);
    });
    await scenario(lang,width,theme,'automation-lifecycle',async(p,l)=>{
      const d=await open(p,l); await tab(d,l); await p.locator('.work-empty').waitFor();
      await createAutomation(d,l); let row=p.locator('.work-item').filter({hasText:'Fixture automation'});
      assert.equal((await calls(p,'msgr_automation_save_with_notifications'))[0].args.schedule.timezone,'Asia/Seoul');assert.deepEqual((await calls(p,'msgr_automation_save_with_notifications'))[0].args.notification_route_ids,[]);
      await button(row,l,'automation.edit').click(); await field(d,l,'automation.name').fill('Edited fixture automation');
      await p.evaluate(()=>window.__workFixture.fail='msgr_automation_save_with_notifications'); await button(d,l,'ui.save').click(); await d.getByRole('alert').waitFor();
      assert.equal(await field(d,l,'automation.name').inputValue(),'Edited fixture automation');
      await button(d,l,'ui.save').click(); row=p.locator('.work-item').filter({hasText:'Edited fixture automation'}); await row.waitFor();
      await button(row,l,'automation.pause').click(); await button(row,l,'automation.resume').waitFor();
      await button(row,l,'automation.resume').click(); await button(row,l,'automation.pause').waitFor();
      await p.evaluate(()=>window.__workFixture.fail='msgr_automation_run_now');await button(row,l,'automation.run').click();await d.getByRole('alert').waitFor();
      await button(row,l,'automation.run').click(); await p.waitForFunction(()=>window.__workFixture.tables.msgr_automation_runs.length===1);
      const manualAttempts=await calls(p,'msgr_automation_run_now');assert.equal(manualAttempts.length,2);assert.match(manualAttempts[0].args.request_id,/^[0-9a-f-]{36}$/);assert.equal(manualAttempts[0].args.request_id,manualAttempts[1].args.request_id);
      if(await button(row,l,'automation.history').getAttribute('aria-expanded')==='false') await button(row,l,'automation.history').click(); await p.locator('.work-history-row').waitFor();
      await p.screenshot({path:new URL(`automations-${lang}-${width}-${theme}.png`,artifacts).pathname});
      await button(row,l,'automation.delete').click(); let confirm=p.getByRole('dialog',{name:l['automation.delete'],exact:true}); await confirm.waitFor();
      assert.equal(await button(confirm,l,'automation.delete').isDisabled(),true);
      for(let i=0;i<7;i++){await p.keyboard.press('Tab');assert.equal(await confirm.evaluate(el=>el.contains(document.activeElement)),true,'Deletion focus stays inside dialog');}
      await p.keyboard.press('Escape'); await confirm.waitFor({state:'detached'});
      assert.equal((await calls(p,'msgr_automation_delete')).length,0);
      await button(row,l,'automation.delete').click(); confirm=p.getByRole('dialog',{name:l['automation.delete'],exact:true});
      await confirm.locator('input').nth(0).fill('Edited fixture automation'); await confirm.locator('input').nth(1).fill(lang==='ko'?'삭제하겠습니다':'delete this');
      await p.evaluate(()=>window.__workFixture.fail='msgr_automation_delete');await button(confirm,l,'automation.delete').click();await confirm.getByRole('alert').waitFor();
      assert.equal(await confirm.locator('input').nth(0).inputValue(),'Edited fixture automation');
      await button(confirm,l,'automation.delete').click(); await confirm.waitFor({state:'detached'}); await row.waitFor({state:'detached'});
    });
    await scenario(lang,width,theme,'notification-selection-and-history',async(p,l)=>{
      const d=await open(p,l);await tab(d,l);await button(d,l,'automation.new').click();
      await field(d,l,'automation.name').fill('Notification fixture');await field(d,l,'automation.prompt').fill('Summarize today');await field(d,l,'automation.crew').selectOption('crew-new');
      const telegram=d.getByRole('checkbox',{name:/Fixture Telegram/});const slack=d.getByRole('checkbox',{name:/Fixture Slack/});
      await telegram.waitFor();assert.equal(await telegram.isChecked(),false);assert.equal(await slack.isChecked(),false);
      await telegram.check();await slack.check();
      await d.locator('.work-notification-routes').scrollIntoViewIfNeeded();await p.screenshot({path:new URL(`notification-picker-${lang}-${width}-${theme}.png`,artifacts).pathname});
      await p.evaluate(()=>window.__workFixture.fail='msgr_automation_save_with_notifications');await button(d,l,'ui.save').click();await d.getByRole('alert').waitFor();
      assert.equal(await telegram.isChecked(),true);await button(d,l,'ui.save').click();
      const row=d.locator('.work-item').filter({hasText:'Notification fixture'});await row.waitFor();
      const attempts=await calls(p,'msgr_automation_save_with_notifications');assert.deepEqual(attempts[0].args.notification_route_ids,['route-slack','route-telegram']);assert.equal(attempts[0].args.request_id,attempts[1].args.request_id);
      await button(row,l,'automation.edit').click();assert.equal(await telegram.isChecked(),true);assert.equal(await slack.isChecked(),true);await telegram.uncheck();await button(d,l,'ui.save').click();
      assert.deepEqual((await calls(p,'msgr_automation_save_with_notifications')).at(-1).args.notification_route_ids,['route-slack']);
      await button(row,l,'automation.run').click();await p.locator('.work-history-row').waitFor();
      await p.evaluate(()=>{const run=window.__workFixture.tables.msgr_automation_runs[0];run.status='completed';window.__workFixture.tables.msgr_notification_deliveries=[{id:'delivery1',run_id:run.id,route_id:'route-slack',status:'uncertain'}];});
      await button(row,l,'automation.history').click();await button(row,l,'automation.history').click();
      await p.waitForFunction(()=>document.querySelector('.work-delivery-status')?.textContent.includes(window.__workTranslate('automation.delivery.uncertain')));
      await d.locator('.work-delivery-status').scrollIntoViewIfNeeded();assert.equal(await d.evaluate(el=>el.scrollWidth<=el.clientWidth),true);await p.screenshot({path:new URL(`notifications-${lang}-${width}-${theme}.png`,artifacts).pathname});
    });
    await scenario(lang,width,theme,'notification-upgrade-and-retry',async(p,l)=>{
      await p.evaluate(()=>window.__workFixture.missingNotifications=true);const d=await open(p,l);await tab(d,l);await button(d,l,'automation.new').click();
      await field(d,l,'automation.name').fill('Preserved notification draft');await field(d,l,'automation.prompt').fill('Summarize');await field(d,l,'automation.crew').selectOption('crew-new');
      await d.getByRole('alert').waitFor();assert.equal(await button(d,l,'ui.save').isDisabled(),true);
      await p.evaluate(()=>window.__workFixture.missingNotifications=false);await button(d,l,'work.retry').click();await d.getByRole('checkbox',{name:/Fixture Telegram/}).waitFor();
      assert.equal(await field(d,l,'automation.name').inputValue(),'Preserved notification draft');assert.equal(await button(d,l,'ui.save').isEnabled(),true);
      assert.equal((await calls(p,'msgr_automation_save_with_notifications')).length,0);
    });
    await scenario(lang,width,theme,'pagination-and-foreign-owner',async(p,l)=>{
      await p.evaluate(()=>{window.__workFixture.tables.msgr_automations=Array.from({length:27},(_,i)=>({id:`automation-${String(i).padStart(3,'0')}`,channel_id:'general',title:`Fixture scheduled ${String(i).padStart(3,'0')}`,prompt:'Fixture page navigation',crew_id:'crew-new',created_by:'user-other',created_at:new Date(1700000000000+i*1000).toISOString(),enabled:true,deleted_at:null,schedule:{kind:'daily',time:'09:00',timezone:'Asia/Seoul'}}));});
      const d=await open(p,l);await tab(d,l);await p.locator('.work-item').first().waitFor();assert.equal(await p.locator('.work-item').count(),25);
      assert.equal(await button(d,l,'automation.edit').count(),0);assert.equal(await button(d,l,'automation.delete').count(),0);
      await p.evaluate(()=>{window.__workFixture.tables.msgr_automation_runs=[{id:'foreign-run',automation_id:'automation-026',notification_route_ids:['route-slack'],status:'queued',trigger:'manual',created_at:new Date().toISOString()}];});await button(p.locator('.work-item').first(),l,'automation.history').click();await p.locator('.work-history-row').waitFor();assert.equal((await calls(p,'msgr_notification_deliveries')).length,0);assert.equal((await calls(p,'msgr_notification_routes_list')).length,0);
      await button(d,l,'work.next').click();await p.waitForFunction(()=>document.querySelectorAll('.work-item').length===2);
      assert.equal(await button(d,l,'work.next').isDisabled(),true);await button(d,l,'work.previous').click();await p.waitForFunction(()=>document.querySelectorAll('.work-item').length===25);
    });
    await scenario(lang,width,theme,'legacy-work-runtime',async(p,l)=>{
      await p.evaluate(()=>window.__workFixture.tables.msgr_crews.forEach(crew=>{crew.work_protocol=0;}));
      const d=await open(p,l);await p.locator('.work-empty').waitFor();await field(d,l,'work.goal').fill('Fixture unsupported work');
      assert.equal(await button(d,l,'work.start').isDisabled(),true);assert.equal((await calls(p,'msgr_work_create')).length,0);
      await tab(d,l);assert.equal(await button(d,l,'automation.new').isEnabled(),true);
    });
    if(width<720) await scenario(lang,width,theme,'short-screen-scroll-keyboard',async(p,l)=>{
      const d=await open(p,l); await tab(d,l); await button(d,l,'automation.new').click();
      await p.setViewportSize({width,height:430}); await field(d,l,'automation.timezone').fill('Asia/Seoul');
      await button(d,l,'ui.save').scrollIntoViewIfNeeded();
      const rect=await button(d,l,'ui.save').boundingBox(); assert.ok(rect.y>=0&&rect.y+rect.height<=430,JSON.stringify(rect));
      assert.equal(await d.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      const bounds=await d.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=430,JSON.stringify(bounds));
      const scroll=p.locator('.work-scroll'); assert.ok(await scroll.evaluate(el=>el.scrollHeight>el.clientHeight));
      await p.screenshot({path:new URL(`short-${lang}-${theme}.png`,artifacts).pathname});
    });
  }
} finally { await writeFile(new URL('results.json',artifacts),JSON.stringify(results,null,2));await browser.close(); }
assert.ok(results.length>0&&results.every(result=>result.passed),`${results.filter(result=>!result.passed).length} work panel browser scenarios failed`);
