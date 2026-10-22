// UX 정리 P1 묶음 3(2026-10-22) — 온보딩 순서(에이전트 먼저)·빈 화면 조직 이름 입력·실행기 시트 1단. 순서 판정은 onboard.test.mjs(stepMarks)가 행동으로 잠근다.
// 화면은 픽스처(test/msgr-ui-feedback.config.mjs, ?noorg=1·?empty=1·nocrews=1)에서 봤다(PR 본문). 이 시험은 배선이 되돌아가지 않게 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const pair = (k) => assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', (?:'[^']+'|"[^"]+")\\]`), `${k} ko·en`);

test('조직 시작 단계: 에이전트 → 첫 채널 → 동료 초대(선택 표시), 강조는 지금 할 일 하나', () => {
  const body = app.slice(app.indexOf('function orgSteps('), app.indexOf('function OrgStepList('));
  const ia = body.indexOf('[m.agent,'), ic = body.indexOf('[m.channel,'), ii = body.indexOf('[[m.invite,');
  assert.ok(ia > 0 && ia < ic && ic < ii, '줄 순서');
  assert.ok(body.includes("t('ch.step.optional')"), '초대는 선택');
  assert.ok(body.includes("className={`btn sm${m.channel === 'mark' ? ' btn-primary' : ''}`} onClick={createChannel}"), '새 채널 단추는 지금 할 일일 때만 강조');
  pair('ch.step.optional');
});

test('조직 없는 단계: 에이전트 연결이 첫 줄(에이전트가 있으면 끝남), 조직 만들기·초대 코드·복원·도메인 참여는 그대로', () => {
  const body = app.slice(app.indexOf('function noOrgSteps('), app.indexOf('function AiConsentGate('));
  assert.match(body, /\[hasAgent \? 'done' : joinable\.length \? '' : 'mark', t\('ch\.step3'\), t\('org\.step\.agent\.sub'\), hasAgent \? null : <RunnerButton key="g" primary=\{!joinable\.length\} \/>\]/, '회사 도메인 가입 후보가 있으면 참여가 먼저(J-3)');
  for (const k of ["t('org.step.restore')", "t('org.step.join')", "t('org.step.create')", "t('org.step.invite')", 'onClick={joinWithCode}']) assert.ok(body.includes(k), k);
  assert.match(app, /hasAgent=\{\(ownCrews\?\.rows\.length \?\? 0\) > 0\}/, '데스크톱 빈 화면 — 내 에이전트 행(시작 때 읽는 ownCrews)');
  assert.match(app, /restoreOrg, hasAgent: \(ownCrews\?\.rows\.length \?\? 0\) > 0 \}\)\} \/>/, '폰 서랍');
  pair('org.step.agent.sub');
});

test('빈 화면 조직 이름: 조직 0개일 때만 본문 입력(비우면 제안 이름), 둘째 조직부터는 메뉴 그대로, 만들기는 기존 createOrg', () => {
  assert.match(app, /const createForm = !org && orgCount === 0 && createOrgNow \? <OrgCreateInline key="a" onCreate=\{createOrgNow\} suggest=\{suggestName\}/);
  assert.match(app, /createOrgNow=\{createOrg\} orgCount=\{orgs\?\.length \?\? 0\} suggestName=\{orgNameSuggest\(session\.user\.email, t\)\}/);
  assert.match(app, /const orgNameSuggest = \(email, t\) => \{ const local = String\(email \?\? ''\)\.split\('@'\)\[0\]\.trim\(\)\.slice\(0, 40\); return local \? t\('org\.name\.suggest', \{ name: local \}\) : ''; \};/);
  const form = app.slice(app.indexOf('function OrgCreateInline('), app.indexOf('function OrgCreateInline(') + 1200);
  assert.ok(form.includes("const v = (name.trim() || suggest).trim(); if (!v || busy) return;"), '빈 이름이면 제안 이름, 둘 다 없으면 만들지 않는다');
  assert.ok(form.includes('maxLength={60}'));
  assert.match(app, /createOrg=\{\(\) => \{ setOrgMenu\(true\); setNewOrg\(''\); \}\}/, '메뉴 안 새 조직은 그대로');
  pair('org.name.suggest');
});

test("실행기 시트: 첫 화면은 '내 컴퓨터' 하나, 서버·외부 봇은 '다른 방법', 긴 설명은 '에이전트가 안 보여요?' — 세 갈래·iOS 다운로드 숨김은 그대로", () => {
  const sheet = app.slice(app.indexOf('function RunnerSheet('), app.indexOf('function PausedBar('));
  assert.ok(sheet.includes("<p className=\"run-desc\">{t('runner.lead')}</p>"));
  assert.ok(sheet.includes("{opts.filter((o) => o.key === 'computer').map(one)}"));
  assert.ok(sheet.includes("<details className=\"msgr-fold run-more\"><summary>{t('runner.more')}</summary>{opts.filter((o) => o.key !== 'computer').map(one)}</details>"));
  assert.ok(sheet.includes("<details className=\"msgr-fold run-help\"><summary>{t('runner.help')}</summary><p className=\"run-desc\">{t('runner.desc')}</p></details>"));
  assert.ok(sheet.includes('runnerOptions({ hasOrg, ios: isIos })'), 'iOS 판정 그대로(onboard.test.mjs)');
  for (const k of ['runner.lead', 'runner.more', 'runner.help']) pair(k);
});

test('AI 이용 동의 게이트는 그대로(2026-09-27 유건 결정 App Store 5.1.2 "처음 한 번 필수 동의" — 이 묶음에서 바꾸지 않는다)', () => {
  assert.match(app, /const orgGateActive = !isPersonal && !!org && aiConsent !== undefined && !aiConsented;/);
});
