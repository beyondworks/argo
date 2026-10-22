// #1133 검수(2026-10-22): 무료 계정이 v2 셸에서 '연결할 수 없음'에 갇히던 것 — 등록 거부(msgr2_pro_required)는 상태 기계가 재시도 없이 멈추고(link-machine.test.mjs),
// 셸은 그 이유를 보고 조직 목록 대기 화면보다 먼저 A+와 같은 Pro 안내(FreeGate)를 그린다. 화면은 픽스처 ?free=1에서 390·1280으로 봤다(PR 본문).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v2StateBar } from '../src/v2/devices.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const aplus = readFileSync(new URL('../src/aplus/APlusApp.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

test('v2StateBar: 무료 등록 거부는 proRequired(연결할 수 없음이 아니다), 다른 멈춤은 종전대로', () => {
  assert.equal(v2StateBar({ state: 'disconnected', reason: 'gave_up:pro_required' }), 'v2.state.proRequired');
  assert.equal(v2StateBar({ state: 'disconnected', reason: 'gave_up:internal' }), 'v2.state.unreachable');
  assert.equal(v2StateBar({ state: 'disconnected', reason: 'gave_up:invalid' }), 'v2.state.unreachable');
  assert.equal(v2StateBar({ state: 'ready', reason: null }), null);
  assert.match(i18n, /'v2\.state\.proRequired': \['[^']+', '[^']+'\]/, 'ko·en');
});

test('셸 배선: Pro 안내는 조직 목록 대기 화면보다 먼저, 다시 확인 = 기계 retry + 조직 목록 다시 읽기, iOS·회사 서버는 결제 권유 없음', () => {
  const gate = app.indexOf("if (V2 && (olPro || v2StateBar(v2state, v2stuck) === 'v2.state.proRequired')) return <FreeGate"); // olPro = 한 목록(msgr2_inbox)이 Pro 끝난 계정을 거절(메신저 단순화 1·2단계)
  const wait = app.indexOf('if (orgs === null) return <OrgsLoading');
  assert.ok(gate > 0 && wait > gate, 'Pro 안내가 대기 화면보다 먼저');
  const line = app.slice(gate, app.indexOf('\n', gate));
  assert.ok(line.includes("purchase={purchaseChannel({ ios: isIos, customServer }) === 'web' ? { url: proCheckoutUrl({ plan: 'free', user: session.user }) } : null}"), '구매 경로는 A+와 같은 판정(iOS·회사 서버 null)');
  assert.ok(line.includes('onRecheck={() => { setOlPro(false); v2rt?.retry(); orgsLoader.retry(); bumpOl(); }}'), '다시 확인 = 기계 retry + 조직 목록 + 한 목록 다시 읽기');
  assert.ok(line.includes('onSignOut={signOut}'));
  assert.match(app, /import APlusApp, \{ FreeGate \} from '\.\/aplus\/APlusApp\.jsx';/);
  assert.match(aplus, /export function FreeGate\(\{ t, purchase, onRecheck, onSignOut \}\)/);
  assert.match(aplus, /\{purchase\?\.url \? <a className="btn btn-primary" href=\{purchase\.url\}[^\n]*: <p className="ap-muted">\{t\('aplus\.free\.auto'\)\}<\/p>\}/, '구매 경로가 없으면 사실만');
});
