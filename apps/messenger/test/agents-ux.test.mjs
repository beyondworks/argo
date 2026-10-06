// UX 판독(2026-10-05) 에이전트 항목 — 꺼진 에이전트 표시(UXM-14), 토큰 다시 만들기 확인 단계(UXM-04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../src/agent-groups.mjs';
import { t } from '../src/i18n.js';

test("UXM-14 꺼진(실행기 오프라인) 에이전트는 '쉬는 중'이 아니라 '꺼져 있음' — 일하는 중·다시 연결 필요는 그대로", () => {
  assert.equal(typeof G.agentRowState, 'function');
  assert.equal(G.agentRowState('idle', false), 'away');
  assert.equal(G.agentRowState('idle', true), 'idle');
  assert.equal(G.agentRowState('working', false), 'working', '방송이 오는 동안은 일하는 중');
  assert.equal(G.agentRowState('relink', false), 'relink');
  assert.equal(t('phone.agent.away', 'ko'), '꺼져 있음'); assert.equal(t('phone.agent.away', 'en'), 'Offline');
});

test('UXM-04 토큰 다시 만들기는 바로 끊지 않고 확인을 먼저 연다 — 실제 단추 onClick', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const at = app.indexOf(">{t('org.agents.rotate')}</button>"); assert.ok(at > 0);
  const btn = app.slice(app.lastIndexOf('<button', at), at);
  const onClick = btn.slice(btn.indexOf('onClick={') + 9, btn.lastIndexOf('}'));
  const seen = [];
  new Function('setConfirmRotate', 'setConfirmRevoke', 'rotateBot', 'b', `return (${onClick});`)((v) => seen.push(['confirm', v]), (v) => seen.push(['revoke', v]), () => seen.push(['rotate']), { id: 'bot-1' })();
  assert.deepEqual(seen, [['revoke', null], ['confirm', 'bot-1']], '확인을 연다(연결 해제 확인은 닫는다) — 회전 RPC는 부르지 않는다');
  assert.notEqual(t('org.agents.rotate.confirm', 'ko'), 'org.agents.rotate.confirm');
});
