// 무료 계정 에이전트가 멈춘 이유 안내(유건 2026-10-11 — 서버 msgr_my_agent_pause, 20261011120000).
// 잠그는 것: ① 이유별 문구 키(app 업데이트 · off 앱 꺼짐 · limit 4명) ② 멈춘 에이전트가 없거나 이유가 없으면(Pro) 안내 없음 ③ 옛 서버·오류면 null(안내 없음)
// ④ ko·en 문구가 있고 유건 결정 문구(업데이트하면 다시 연결)가 실행기(argo) 말로 들어 있다 ⑤ 화면 두 자리(폰 에이전트 탭·데스크톱 레일)에 붙어 있다
// ⑥ 서버 오류의 앞 코드가 뒤의 msgr_pro_required보다 먼저 문구가 된다(옛 메신저는 뒤 코드로 Pro 안내).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAgentPause, agentPauseNote, readSwapNames } from '../src/agent-pause.mjs';
import { t as tm } from '../src/i18n.js';
import { toastError, setIosCopy } from '../src/error-toast.mjs';

test('① 이유별 문구 키 + 수', () => {
  assert.deepEqual(agentPauseNote({ paused: 3, active: 0, limit: 4, reason: 'app' }), { key: 'agents.pause.app', vars: { n: 3, limit: 4 } });
  assert.deepEqual(agentPauseNote({ paused: 1, active: 0, limit: 4, reason: 'off' }), { key: 'agents.pause.off', vars: { n: 1, limit: 4 } });
  assert.deepEqual(agentPauseNote({ paused: 5, active: 4, limit: 4, reason: 'limit' }), { key: 'agents.pause.limit', vars: { n: 5, limit: 4 } });
});

test('② 멈춘 에이전트가 없거나 이유가 없으면(Pro·관문 꺼짐) 안내 없음', () => {
  assert.equal(agentPauseNote({ paused: 0, active: 4, limit: 4, reason: 'limit' }), null);
  assert.equal(agentPauseNote({ paused: 2, active: 0, limit: 4, reason: null }), null);
  assert.equal(agentPauseNote(null), null);
  assert.equal(agentPauseNote({ paused: 2, reason: 'weird' }), null);
  assert.equal(agentPauseNote({ paused: 1, active: 2, limit: 4, reason: 'room' }), null, 'room(자리 남음 — 본체 카드에서 지금 연결) — 메신저 안내는 없다(옛 메신저와 같음)');
});

test('③ 읽기: 옛 서버(함수 없음)·오류·던짐이면 null — 화면은 안내 없이 지금과 같다', async () => {
  const ok = { paused: 1, active: 0, limit: 4, reason: 'app' };
  assert.deepEqual(await readAgentPause({ rpc: async (name) => { assert.equal(name, 'msgr_my_agent_pause'); return { data: ok, error: null }; } }), ok);
  assert.equal(await readAgentPause({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) }), null);
  assert.equal(await readAgentPause({ rpc: async () => { throw new TypeError('Failed to fetch'); } }), null);
});

test('④ ko·en 문구 — 유건 결정 문구 그대로, 변수 채움', () => {
  // 유건 결정 문구("Argo 앱을 업데이트하면 에이전트가 다시 연결됩니다")를 메신저 문구 규칙(다른 앱 설치 전제 금지 — runner-sheet.test.mjs)에 맞춰 실행기(argo)로
  assert.match(tm('agents.pause.app', 'ko', { n: 3, limit: 4 }), /실행기\(argo\)를 최신 버전으로 업데이트하면 에이전트가 다시 연결됩니다/);
  assert.match(tm('agents.pause.app', 'ko', { n: 3, limit: 4 }), /3명/);
  for (const k of ['agents.pause.app', 'agents.pause.off', 'agents.pause.limit', 'err.freeAgentLimit', 'err.appUpdateRequired']) for (const lang of ['ko', 'en']) {
    const v = tm(k, lang, { n: 2, limit: 4 });
    assert.notEqual(v, k); assert.doesNotMatch(v, /\{\w+\}/, `${k} ${lang}`);
    if (lang === 'en') assert.doesNotMatch(v, /[가-힣]/, `${k} en에 한글`);
  }
  assert.match(tm('agents.pause.limit', 'en', { n: 2, limit: 4 }), /up to 4 agents/);
});

test('⑥ 서버 오류: 앞 코드(이유)가 먼저 — 옛 메신저용 뒤 코드(msgr_pro_required)로 가지 않는다', () => {
  for (const lang of ['ko', 'en']) {
    const t = (k, v) => tm(k, lang, { path: tm('diag.path.desktop', lang), ...v });
    assert.equal(toastError('msgr_free_agent_limit msgr_pro_required', { t }), t('err.freeAgentLimit'));
    assert.equal(toastError('msgr_app_update_required msgr_pro_required', { t }), t('err.appUpdateRequired'));
    assert.equal(toastError('msgr_pro_required', { t }), t('err.proRequired'), '옛 서버(이유 없음)는 종전 Pro 안내');
  }
});

test('⑤ 화면 두 자리 — 폰 에이전트 탭(목록 위)·데스크톱 레일(내 에이전트 구역 위, 개인 공간에서도) + 읽기는 로그인·재연결·탭 진입 때만', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /\{pauseNote && !tabQText\.trim\(\) && <div className="msgr-hint ph-pausenote" role="status">\{t\(pauseNote\.key, pauseNote\.vars\)\}\{pauseNote\.key !== 'agents\.pause\.limit' && <div className="ph-emptyacts"><RunnerButton \/><\/div>\}<\/div>\}/, '폰: 업데이트·꺼짐이면 실행기 연결 단추');
  assert.match(app, /const pauseNoteEl = pauseNote && <div className="msgr-rail-empty msgr-pausenote" role="status">\{t\(pauseNote\.key, pauseNote\.vars\)\}\{pauseNote\.key !== 'agents\.pause\.limit' && <div><RunnerButton \/><\/div>\}<\/div>;/, '데스크톱 레일 안내');
  assert.match(app, /<div className="msgr-list mine">\n\s+\{!isPhone && pauseNote && pauseNoteEl\}/, '내 에이전트 구역 안 맨 위(검수 #945 LOW-4)');
  assert.match(app, /\{!isPhone && pauseNote && !\(isPersonal \? railVisible\.length > 0 : !orgBlocked && org\) && pauseNoteEl\}/, '구역이 숨을 때만 밖');
  assert.equal((app.match(/readAgentPause\(supabase\)/g) ?? []).length, 5, '주기 호출 없음 — 로그인·재연결, 폰 에이전트 탭, 교체가 일어난 직후(서버 자동 교체·사용자 선택 교체), 멈춘 에이전트의 crew_sync(다시 연결됨 방송) 다섯 곳만(2026-10-15)');
  assert.match(app, /readAgentPause\(supabase\)\.then\(\(v\) => \{ if \(live\) setAgentPause\(v\); \}\); return \(\) => \{ live = false; \}; \}, \[uid, syncEpoch\]\);/);
});

test('⑦ 교체 안내(검수 #945 MEDIUM-1) — 이름 목록(중복 없이), 옛 서버·오류·던짐이면 빈 목록, 연결 직후 두 자리(파견·시트)에서 부른다, 해제 안내 문구 없음', async () => {
  assert.deepEqual(await readSwapNames({ rpc: async (name, args) => { assert.equal(name, 'msgr_agent_swap_notes'); assert.deepEqual(args, { p_crews: ['c1'] }); return { data: [{ crew_id: 'c1', victim_name: '준' }, { crew_id: 'c1', victim_name: '준' }], error: null }; } }, ['c1']), ['준']);
  assert.deepEqual(await readSwapNames({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }, ['c1']), []);
  assert.deepEqual(await readSwapNames({ rpc: async () => { throw new Error('x'); } }, ['c1']), []);
  assert.deepEqual(await readSwapNames({ rpc: async () => { throw new Error('호출하면 안 됨'); } }, []), []);
  for (const lang of ['ko', 'en']) { const v = tm('agents.swap', lang, { names: 'Jun' }); assert.match(v, /Jun/); assert.match(v, /Pro/); }
  for (const k of ['err.freeAgentLimit', 'agents.swap', 'agents.pause.limit']) assert.doesNotMatch(tm(k, 'ko'), /해제/, `${k}: 해제(채널 참여 삭제)로 안내하지 않는다`);
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.equal((app.match(/readSwapNames\(supabase, \[crew\.id\]\)/g) ?? []).length, 2);
});

test('⑧ iOS 빌드는 무료 한도·교체 안내에서 결제 권유를 뺀다(App Store 3.1.1, #944와 같은 원칙) — 사실만 남기고, 고르는 곳은 isIos 하나', () => {
  assert.equal(agentPauseNote({ paused: 3, active: 4, limit: 4, reason: 'limit' }, { ios: true }).key, 'agents.pause.limit.ios');
  assert.equal(agentPauseNote({ paused: 3, reason: 'app' }, { ios: true }).key, 'agents.pause.app', 'app·off 문구에는 결제 권유가 없다');
  for (const lang of ['ko', 'en']) {
    for (const k of ['agents.pause.limit.ios', 'agents.swap.ios', 'err.freeAgentLimit.ios', 'agents.pause.app', 'agents.pause.off', 'err.appUpdateRequired'])
      assert.doesNotMatch(tm(k, lang, { n: 3, limit: 4, names: 'Jun' }), /Pro|결제|업그레이드|upgrade/i, `${k} ${lang}`);
    assert.match(tm('agents.pause.limit', lang, { n: 3, limit: 4 }), /Pro/, 'iOS 밖은 그대로');
  }
  assert.equal(tm('agents.pause.limit.ios', 'ko', { n: 3, limit: 4 }), '무료 계정은 에이전트 4명까지 연결돼요. 나머지 3명은 멈춰 있어요.');
  const t = (k, v) => tm(k, 'ko', v);
  setIosCopy(true); try { assert.equal(toastError('msgr_free_agent_limit msgr_pro_required', { t }), t('err.freeAgentLimit.ios')); } finally { setIosCopy(false); }
  assert.equal(toastError('msgr_free_agent_limit msgr_pro_required', { t }), t('err.freeAgentLimit'));
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /agentPauseNote\(agentPause, \{ ios: isIos \}\)/); assert.match(app, /setIosCopy\(isIos\);/);
  assert.equal((app.match(/t\(isIos \? 'agents\.swap\.ios' : 'agents\.swap'/g) ?? []).length, 2, '교체 안내 두 자리');
});

test('⑨ 화면 검수 B(10/11) — 교체·한도 문구는 "멈춤" 말(폰 대기 표시 "쉬는 중"과 겹치지 않게), ko·en·iOS', () => {
  const idle = tm('phone.agent.idle', 'ko');
  for (const k of ['agents.swap', 'agents.swap.ios', 'err.freeAgentLimit', 'err.freeAgentLimit.ios']) {
    const ko = tm(k, 'ko', { names: '세온' });
    assert.doesNotMatch(ko, /쉬/, `${k}: 대기 표시(${idle})와 같은 말 금지`);
    assert.match(ko, /멈/);
    assert.match(tm(k, 'en', { names: 'Seon' }), /paus/i);
  }
  assert.equal(tm('agents.swap', 'ko', { names: '세온' }), '무료 계정은 에이전트 4명까지라서 세온 에이전트를 멈췄어요. Pro면 제한이 없어요.');
  assert.equal(tm('agents.swap.ios', 'ko', { names: '세온' }), '무료 계정은 에이전트 4명까지라서 세온 에이전트를 멈췄어요.');
});
