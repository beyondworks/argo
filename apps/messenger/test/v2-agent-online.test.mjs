// v2 에이전트 켜짐 표시(0.1.65 결함 2, 2026-10-25 유건 아이폰 — 페퍼가 답하는데 에이전트 탭 전원 '꺼져 있음'·잠든 얼굴).
// 근본 수정: 본체가 v2:pr:<주인>에 켜진 에이전트 id를 track하고(src/agent-link-host.mjs), 메신저는 보이는 동안 그 주인 채널만 듣는다(v2/presence.mjs·machine watchPresence).
// 판정 crewPresence: 'on'(신호 있음) | 'off'(v1 90초 지남·다시 연결 필요) | 'unknown'(v2 신호 없음 — 옛 본체와 섞여도 거짓 '꺼져 있음'을 그리지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crewOnline, crewPresence } from '../src/personal-bots.mjs';
import { crewFaceState } from '../src/crew-face.mjs';
import { agentRowState } from '../src/agent-groups.mjs';

const NOW = Date.parse('2026-10-25T04:00:00Z');
const AWAY = 90_000;
const iso = (ms) => new Date(ms).toISOString();
const ME = 'u-me';

test('v1 행: 90초 안이면 켜짐, 지나면 꺼짐, 대화할 수 없는 쌍둥이는 꺼짐', () => {
  assert.equal(crewPresence({ last_seen_at: iso(NOW - 10_000) }, AWAY, NOW), 'on');
  assert.equal(crewPresence({ last_seen_at: iso(NOW - 200_000) }, AWAY, NOW), 'off');
  assert.equal(crewPresence({ last_seen_at: null }, AWAY, NOW), 'off');
  assert.equal(crewPresence({ hosting: 'bot', ready: false, last_seen_at: iso(NOW) }, AWAY, NOW), 'off');
});

test('v2 행: 주인 채널에 켜짐 신호가 있으면 켜짐, 없으면 모름(꺼짐 아님) — 얼굴은 둘 다 깨어 있음', () => {
  const v2 = { id: 'a1', owner_user_id: ME, _v2: true, last_seen_at: null };
  assert.equal(crewPresence(v2, AWAY, NOW, new Map([[ME, new Set(['a1'])]])), 'on');
  assert.equal(crewOnline(v2, AWAY, NOW, new Map([[ME, new Set(['a1'])]])), true, '켜짐 점');
  for (const online of [null, new Map(), new Map([[ME, new Set()]]), new Map([[ME, new Set(['other'])]])]) {
    assert.equal(crewPresence(v2, AWAY, NOW, online), 'unknown', '옛 본체(빈 채널)·채널 전·다른 에이전트만 켜짐 = 모름');
    assert.equal(crewOnline(v2, AWAY, NOW, online), false, '모름은 켜짐 점을 켜지 않는다');
  }
  assert.equal(crewFaceState({ crew: v2, now: NOW }), 'idle', '잠든 얼굴(off)이 아니다');
  assert.equal(crewFaceState({ crew: { id: 'a2', last_seen_at: iso(NOW - 200_000) }, now: NOW }), 'off', 'v1 꺼짐 얼굴은 그대로');
  assert.equal(crewPresence({ ...v2, hosting: 'bot', ready: false }, AWAY, NOW, new Map([[ME, new Set(['a1'])]])), 'off', '다시 연결이 필요한 쌍둥이는 꺼짐');
  assert.equal(agentRowState('idle', true), 'idle');
});

test('배선: 에이전트 탭은 켜짐·모름을 나눠 모름이면 상태 글자를 그리지 않고, 구성원 시트는 꺼짐일 때만 「꺼져 있음」, 레일 점은 켜짐일 때만', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const pres = g\.rows\.map\(\(r\) => crewPresence\(r, AWAY_MS, Date\.now\(\), agentOnline\)\); const on = pres\.includes\('on'\);/);
  assert.match(app, /const st = !on && gs === 'idle' && pres\.includes\('unknown'\) \? 'unknown' : agentRowState\(gs, on\);/);
  assert.match(app, /\{st !== 'unknown' && <span className=\{`ph-astate \$\{st\}`\}>/);
  assert.match(app, /const pres = crewPresence\(c, AWAY_MS, Date\.now\(\), presenceOnline\); const on = pres === 'on';/);
  assert.match(app, /\{pres === 'off' && <span className="msgr-offline">\{t\('crew\.offline'\)\}<\/span>\}/);
  assert.equal((app.match(/\{crewPresence\(c, AWAY_MS, Date\.now\(\), agentOnline\) !== 'unknown' && <span className=\{`msgr-dot\$\{crewOnline\(c, AWAY_MS, Date\.now\(\), agentOnline\) \? ' mark' : ''\}`\} \/>\}/g) ?? []).length, 2, '레일 점 두 곳 — 모름이면 점 없음');
  assert.doesNotMatch(app, /seenWithin\([a-z], AWAY_MS, Date\.now\(\), crewSeenAt/);
});

test('배선: 보이는 주인들의 채널만 듣는다(상한), 같은 상태는 다시 그리지 않는다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const presenceKey = V2 \? presenceOwners\(\[\.\.\.\(ownCrews\?\.rows \?\? \[\]\), \.\.\.\(myAgents \?\? \[\]\), \.\.\.crews\], uid\)\.join\(','\) : '';/);
  assert.match(app, /const offs = presenceKey\.split\(','\)\.map\(\(o\) => v2rt\.machine\.watchPresence\(o\)\);/);
  assert.match(app, /v2rt\.machine\.on\('presence', \(\{ owner, state \}\) => setAgentOnline/);
});
