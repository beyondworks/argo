// 업데이트 필요 전체 화면의 판정(update-gate.mjs)과 앱 루트 배선. 화면·요청 0의 행동 근거는 test/update-gate.browser.mjs(가짜 서버 + 브라우저).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { updateGateActive, markUpdateGate, clearUpdateGate, recheckVerdict, updateAction, UPDATE_GATE_KEY, MSGR_RELEASES_URL } from '../src/update-gate.mjs';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('표지는 이 앱 버전에만 걸린다 — 업데이트로 버전이 바뀌면 저절로 무효, 지우면 풀림, 저장이 막혀도 던지지 않는다', () => {
  const s = mem();
  assert.equal(updateGateActive(s, '0.1.68'), false, '표지 없음');
  markUpdateGate(s, '0.1.68', 1);
  assert.equal(updateGateActive(s, '0.1.68'), true);
  assert.equal(updateGateActive(s, '0.1.69'), false, '다른 버전(업데이트 뒤)은 막지 않는다');
  assert.equal(updateGateActive(s, null), false, '버전 모름은 막지 않는다');
  clearUpdateGate(s);
  assert.equal(updateGateActive(s, '0.1.68'), false);
  s.setItem(UPDATE_GATE_KEY, '{깨진');
  assert.equal(updateGateActive(s, '0.1.68'), false, '깨진 값은 막지 않는다');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(updateGateActive(broken, '0.1.68'), false);
  assert.doesNotThrow(() => markUpdateGate(broken, '0.1.68'));
  assert.doesNotThrow(() => clearUpdateGate(broken));
});

test('켤 때 다시 묻기 — 여전히 낮으면 막힘, 서버가 값을 지우거나 낮추면 풀림, 확인 실패는 막힌 채', () => {
  assert.equal(recheckVerdict({ data: '0.1.70' }, '0.1.68'), 'blocked');
  assert.equal(recheckVerdict({ data: ' 0.1.70 ' }, '0.1.68'), 'blocked', '앞뒤 공백');
  assert.equal(recheckVerdict({ data: null }, '0.1.68'), 'clear', '서버 값 없음');
  assert.equal(recheckVerdict({ data: '0.1.68' }, '0.1.68'), 'clear', '같은 버전(경계)은 막지 않는다');
  assert.equal(recheckVerdict({ data: '0.1.60' }, '0.1.68'), 'clear');
  assert.equal(recheckVerdict({ error: { message: 'offline' } }, '0.1.68'), 'blocked', '확인 실패는 판정을 바꾸지 않는다');
});

test('[업데이트] 단추 — 데스크톱은 앱 안 설치, iOS는 App Store, Android는 APK, 브라우저는 릴리스 페이지', () => {
  assert.deepEqual(updateAction({ desktop: true }), { kind: 'install' });
  assert.match(updateAction({ ios: true }).url, /^https:\/\/apps\.apple\.com\/.+\/id6810877561$/);
  assert.match(updateAction({ android: true }).url, /\/releases\/latest\/download\/argo-messenger-android\.apk$/);
  assert.equal(updateAction({}).url, MSGR_RELEASES_URL);
  const landing = readFileSync(new URL('../../../landing/lib/downloads.js', import.meta.url), 'utf8');
  assert.ok(landing.includes(updateAction({ ios: true }).url), '랜딩의 iOS 주소와 같다');
});

test('배선 — 셸이 update_required를 루트에 알리고, 루트는 셸 대신 UpdateGate를 그리며 위쪽 업데이트 막대는 숨긴다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(V2 && v2state\?\.state === 'update_required'\) onUpdateRequired\?\.\(\);/, '셸 → 루트 알림');
  assert.match(app, /else if \(updateGate\) body = <UpdateGate /, '루트는 셸을 올리지 않는다(셸 효과·주기 요청 정리)');
  assert.ok(app.indexOf('else if (updateGate) body = <UpdateGate') < app.indexOf('<Shell key={session.user.id}'), '셸보다 먼저 판정');
  assert.match(app, /\{!\(session && updateGate\) && <><UpdateBar t=\{t\} \/><MobileUpdateBar t=\{t\} \/><\/>\}/, '같은 안내를 두 번 띄우지 않는다');
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  for (const k of ['title', 'body', 'bodyNoMin', 'safe', 'button', 'failed', 'download']) assert.match(dict, new RegExp(`'gate\\.update\\.${k}': \\['[^']+', '[^']+'\\]`), `gate.update.${k} ko·en`);
});
