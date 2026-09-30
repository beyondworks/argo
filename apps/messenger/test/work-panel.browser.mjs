// Scripted regression in a fresh browser context; external network is blocked.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.WORK_ENGINE || 'chromium';
// PLAYWRIGHT_CHANNEL은 work-memory-layout.browser.mjs와 같은 오버라이드 — 실 Chrome이 없는 환경은 'bundled'로 번들 Chromium을 쓴다.
const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' && channel !== 'bundled' ? { channel } : {}) });
const artifacts = new URL(`../artifacts/work-panel-${engine}/`, import.meta.url);
await mkdir(artifacts, { recursive: true });
const results = [];
const labels = ['work.result.stalled','work.title','work.start','work.goal','work.completion','work.discussion','work.cancel','work.resume','work.empty','work.tab.automations','automation.new','automation.name','automation.prompt','automation.crew','automation.repeat','automation.timezone','automation.history','automation.edit','automation.pause','automation.resume','automation.run','automation.delete','ui.save','ui.cancel','ui.close','work.retry','work.refresh','work.error.upgrade','work.next','work.previous',
  'automation.source.custom','routine.readonly.external','routine.error.notEditable','routine.status.last','routine.schedule.readonly','routine.pending','routine.pending.ext',
  'routine.route.badge','routine.route.none','routine.route.pick','routine.route.save','routine.route.dm','routine.error.channel',
  'ui.settings','set.tab.crews','org.agents.detail.adapter.unknown','org.agents.adapter.outdated','org.agents.approvals.ai','org.agents.approvals.ask','org.agents.approvals.fix',
  'org.agents.mirrorAll','org.agents.mirrorAll.needUpdate','org.agents.mirrorAll.pending','org.agents.mirrorAll.hint'];
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
// 외부 에이전트 계약 1-a — 루틴이 심어진 1:1(crew-existing)을 연다. 픽스처 홈 화면엔 데스크톱·폰 모두 채팅 목록에 이미 떠 있다.
async function openDm(p,l,name) {
  await p.locator('[data-sec="dms"] .item').filter({hasText:name}).click();
}
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
    // 폰 폭은 채널 화면이 전체 화면을 덮어(뒤로 버튼 전용) DM 목록으로 못 돌아간다 — 출처 배지·편집 가능 여부 로직 자체는
    // 폭과 무관하므로 데스크톱에서 검증하고, 패널의 폰 레이아웃은 work-memory-layout.browser.mjs가 이미 따로 본다.
    if(width>=720) await scenario(lang,width,theme,'ext-agent-contract',async(p,l)=>{
      await openDm(p,l,'Fixture Existing Agent'); const d=await open(p,l); await tab(d,l);
      const card=(name)=>d.locator('.work-item').filter({hasText:name});
      await card('Fixture Hermes cron').waitFor();
      // 배지 — Hermes/OpenClaw는 고유명사라 언어와 무관하게 같은 표기, custom은 번역된 "외부 에이전트"로 묶인다
      assert.equal((await card('Fixture Hermes cron').locator('.work-source-badge').innerText()).trim(),'Hermes');
      assert.equal((await card('Fixture OpenClaw scan').locator('.work-source-badge').innerText()).trim(),'OpenClaw');
      assert.equal((await card('Fixture custom bot').locator('.work-source-badge').innerText()).trim(),l['automation.source.custom']);
      // 편집 가능한 외부 루틴(Hermes) — 편집·멈춤/재개·삭제 버튼이 그대로 있고, 마지막 실행 상태 줄이 보인다
      await card('Fixture Hermes cron').locator('.work-item-top').click();
      await d.getByText(l['routine.status.last'],{exact:false}).waitFor();
      assert.ok((await card('Fixture Hermes cron').innerText()).includes('ok'));
      assert.equal(await button(card('Fixture Hermes cron'),l,'automation.edit').count(),1);
      assert.equal(await button(card('Fixture Hermes cron'),l,'automation.pause').count(),1);
      assert.equal(await button(card('Fixture Hermes cron'),l,'automation.delete').count(),1);
      // 편집 불가(OpenClaw) — 버튼은 전부 숨고 안내 한 줄만, raw 일정은 display 그대로, 오류 상태도 보인다
      await card('Fixture OpenClaw scan').locator('.work-item-top').click();
      await card('Fixture OpenClaw scan').getByText(l['routine.readonly.external'],{exact:true}).waitFor();
      assert.equal(await button(card('Fixture OpenClaw scan'),l,'automation.edit').count(),0);
      assert.equal(await button(card('Fixture OpenClaw scan'),l,'automation.pause').count(),0);
      assert.equal(await button(card('Fixture OpenClaw scan'),l,'automation.resume').count(),0);
      assert.equal(await button(card('Fixture OpenClaw scan'),l,'automation.delete').count(),0);
      assert.ok((await card('Fixture OpenClaw scan').innerText()).includes('평일 15분마다'));
      assert.ok((await card('Fixture OpenClaw scan').innerText()).includes('error'));
      await card('Fixture OpenClaw scan').scrollIntoViewIfNeeded(); await d.screenshot({path:new URL(`ext-agent-list-${lang}-${width}-${theme}.png`,artifacts).pathname}); // 목록 행(편집 불가 안내·raw 일정·상태) 증거
      // 편집 불가 + 상태 없음(custom) — 상태 줄은 뜨지 않는다(값이 없을 때 빈 줄을 만들지 않는다)
      await card('Fixture custom bot').locator('.work-item-top').click();
      await card('Fixture custom bot').getByText(l['routine.readonly.external'],{exact:true}).waitFor();
      assert.equal(await card('Fixture custom bot').getByText(l['routine.status.last'],{exact:false}).count(),0);
      // raw 일정 + 편집 가능 — 폼에서 일정은 읽기전용(반복 선택 UI 없음), 제목·지시 수정은 Argo 루틴과 같은 반영 대기로 접수된다
      await card('Fixture Hermes raw schedule').locator('.work-item-top').click();
      assert.ok((await card('Fixture Hermes raw schedule').innerText()).includes('3시간마다'));
      await button(card('Fixture Hermes raw schedule'),l,'automation.edit').click();
      await d.getByText(l['routine.schedule.readonly'],{exact:false}).waitFor();
      assert.equal(await d.locator('.work-editor select').count(),0,'raw 일정은 반복 선택 UI가 없다');
      await field(d,l,'automation.name').fill('Fixture Hermes raw schedule (edited)');
      await button(d,l,'ui.save').click(); await card('Fixture Hermes raw schedule').getByText(l['routine.pending.ext'],{exact:true}).waitFor(); // 외부 작업은 "Argo가 켜지면"이 아니라 에이전트 기준 문구(검수 L-10)
      // 서버 오류 msgr_routine_not_editable — 편집 가능하다고 읽은 행이 저장 시점에 막히는 경쟁 상황도 사용자 문장으로 보인다
      await button(card('Fixture Hermes cron'),l,'automation.edit').click();
      await p.evaluate(()=>window.__workFixture.fail={name:'msgr_crew_routine_edit',message:'msgr_routine_not_editable'});
      await field(d,l,'automation.name').fill('Fixture Hermes cron (blocked)');
      await button(d,l,'ui.save').click();
      await d.getByText(l['routine.error.notEditable'],{exact:true}).waitFor();
      await p.screenshot({path:new URL(`ext-agent-${lang}-${width}-${theme}.png`,artifacts).pathname});
      // 1-b ③ 보낼 곳 없는 작업 — 배지·안내, 고를 수 있는 방은 이 1:1 대화와 그 에이전트가 들어간 채널뿐, 서버 거절은 사용자 문장으로
      await card('Fixture nightly handover').locator('.work-item-top').click();
      assert.equal((await card('Fixture nightly handover').locator('.work-source-badge.warn').innerText()).trim(),l['routine.route.badge']);
      await card('Fixture nightly handover').getByText(l['routine.route.none'],{exact:true}).waitFor();
      assert.equal(await button(card('Fixture nightly handover'),l,'automation.edit').count(),0,'읽기 전용 작업은 방 지정만');
      const pick=field(card('Fixture nightly handover'),l,'routine.route.pick');
      await pick.locator('option').nth(2).waitFor({state:'attached'});
      assert.deepEqual((await pick.locator('option').allInnerTexts()).slice(1),[l['routine.route.dm'],'# Fixture Private']);
      assert.equal(await button(card('Fixture nightly handover'),l,'routine.route.save').isDisabled(),true,'방을 고르기 전에는 저장 불가');
      await p.evaluate(()=>window.__workFixture.fail={name:'msgr_crew_routine_edit',message:'msgr_routine_invalid_channel'});
      await pick.selectOption('private'); await button(card('Fixture nightly handover'),l,'routine.route.save').click();
      await d.getByText(l['routine.error.channel'],{exact:true}).waitFor();
      await button(card('Fixture nightly handover'),l,'routine.route.save').click();
      await card('Fixture nightly handover').getByText(l['routine.pending.ext'],{exact:true}).waitFor();
      const edits=(await calls(p,'msgr_crew_routine_edit')).filter((c)=>c.args.p_routine==='routine-noroute');
      assert.deepEqual(edits.at(-1).args,{p_routine:'routine-noroute',p_op:'update',p_patch:{channel_id:'private'}});
      await card('Fixture nightly handover').scrollIntoViewIfNeeded(); await d.screenshot({path:new URL(`ext-agent-noroute-${lang}-${width}-${theme}.png`,artifacts).pathname});
    });
    // 1-b — 에이전트 카드: 연결 도구 버전(예전이면 업데이트 안내), 위험 명령 승인 방식(스스로 승인하면 고치는 명령), 소유자 스위치(예전 도구는 비활성)
    if(width>=720) await scenario(lang,width,theme,'ext-agent-card',async(p,l)=>{
      await p.getByRole('button',{name:l['ui.settings'],exact:true}).first().click();
      await p.getByRole('button',{name:l['set.tab.crews'],exact:true}).click();
      const row=(name)=>p.locator('.msgr-botrow').filter({hasText:name});
      await row('Fixture Old Hermes').locator('button.main').click();
      const old=row('Fixture Old Hermes');
      await old.getByText(l['org.agents.detail.adapter.unknown'],{exact:true}).waitFor();
      await old.getByText(l['org.agents.adapter.outdated'].replace('{latest}','0.3.3'),{exact:true}).waitFor();
      await old.getByText(l['org.agents.approvals.ai'].replace('{mode}','smart'),{exact:true}).waitFor();
      assert.ok((await old.innerText()).includes('hermes config set approvals.mode manual'),'고치는 명령');
      assert.equal(await old.locator('input[type=checkbox]').isDisabled(),true,'예전 도구는 스위치 비활성');
      await old.getByText(l['org.agents.mirrorAll.needUpdate'],{exact:true}).waitFor();
      await old.scrollIntoViewIfNeeded(); await p.screenshot({path:new URL(`ext-agent-card-old-${lang}-${width}-${theme}.png`,artifacts).pathname});
      await row('Fixture New Claw').locator('button.main').click();
      const neu=row('Fixture New Claw');
      await neu.getByText('0.3.2',{exact:true}).waitFor();
      await neu.getByText(l['org.agents.approvals.ask'].replace('{mode}','ask'),{exact:true}).waitFor();
      assert.equal(await neu.getByText(l['org.agents.adapter.outdated'].replace('{latest}','0.3.2'),{exact:true}).count(),0,'최신이면 업데이트 안내 없음');
      assert.equal(await neu.getByText(l['org.agents.approvals.fix'],{exact:false}).count(),0,'결재로 묻는 모드면 고치는 명령 없음');
      await neu.getByText(l['org.agents.mirrorAll.hint'],{exact:true}).waitFor();
      await neu.locator('input[type=checkbox]').check();
      await neu.getByText(l['org.agents.mirrorAll.pending'],{exact:true}).waitFor();
      assert.deepEqual((await p.evaluate(()=>window.__workFixture.workCalls.filter((c)=>c.name==='msgr_bot_set_mirror_all'))).map((c)=>c.args),[{p_bot:'bot-new',p_on:true}]);
      await neu.scrollIntoViewIfNeeded(); await p.screenshot({path:new URL(`ext-agent-card-new-${lang}-${width}-${theme}.png`,artifacts).pathname});
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
