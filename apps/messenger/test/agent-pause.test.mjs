// 무료 계정 에이전트가 멈춘 이유 안내(유건 2026-10-11 — 서버 msgr_my_agent_pause, 20261011120000).
// 잠그는 것: ① 이유별 문구 키(app 업데이트 · off 앱 꺼짐 · limit 4명) ② 멈춘 에이전트가 없거나 이유가 없으면(Pro) 안내 없음 ③ 옛 서버·오류면 null(안내 없음)
// ④ ko·en 문구가 있고 유건 결정 문구(업데이트하면 다시 연결)가 실행기(argo) 말로 들어 있다 ⑤ 화면 두 자리(폰 에이전트 탭·데스크톱 레일)에 붙어 있다
// ⑥ 서버 오류의 앞 코드가 뒤의 msgr_pro_required보다 먼저 문구가 된다(옛 메신저는 뒤 코드로 Pro 안내).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAgentPause, agentPauseNote } from '../src/agent-pause.mjs';
import { t as tm } from '../src/i18n.js';
import { toastError } from '../src/error-toast.mjs';

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
  assert.match(app, /\{!isPhone && pauseNote && <div className="msgr-rail-empty msgr-pausenote" role="status">\{t\(pauseNote\.key, pauseNote\.vars\)\}\{pauseNote\.key !== 'agents\.pause\.limit' && <div><RunnerButton \/><\/div>\}<\/div>\}/, '데스크톱 레일');
  assert.equal((app.match(/readAgentPause\(supabase\)/g) ?? []).length, 2, '주기 호출 없음 — 두 곳(로그인·재연결, 폰 에이전트 탭)만');
  assert.match(app, /readAgentPause\(supabase\)\.then\(\(v\) => \{ if \(live\) setAgentPause\(v\); \}\); return \(\) => \{ live = false; \}; \}, \[uid, syncEpoch\]\);/);
});
