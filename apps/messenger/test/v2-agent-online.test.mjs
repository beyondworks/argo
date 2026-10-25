// v2 에이전트 켜짐 표시(0.1.65 결함 2, 2026-10-25 유건 아이폰 — 페퍼가 답하는데 에이전트 탭 전원 '꺼져 있음'·잠든 얼굴).
// 원인: v2 조회 어댑터는 에이전트 행 last_seen_at을 늘 null로 준다(접속은 Presence v2:pr: — 본체 track 미구현). 탭·레일·구성원·얼굴이 그 null을 '꺼짐'으로 읽었다.
// 규칙: v2 행은 신호가 없으니 꺼짐으로 단정하지 않는다(crewAway·crewAwayNotice와 같은 규칙). v1 행은 종전대로 90초.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crewOnline } from '../src/personal-bots.mjs';
import { crewFaceState } from '../src/crew-face.mjs';
import { agentRowState } from '../src/agent-groups.mjs';

const NOW = Date.parse('2026-10-25T04:00:00Z');
const AWAY = 90_000;
const iso = (ms) => new Date(ms).toISOString();

test('v1 행: 90초 안이면 켜짐, 지나면 꺼짐, 대화할 수 없는 쌍둥이는 꺼짐', () => {
  assert.equal(crewOnline({ last_seen_at: iso(NOW - 10_000) }, AWAY, NOW), true);
  assert.equal(crewOnline({ last_seen_at: iso(NOW - 200_000) }, AWAY, NOW), false);
  assert.equal(crewOnline({ last_seen_at: null }, AWAY, NOW), false);
  assert.equal(crewOnline({ hosting: 'bot', ready: false, last_seen_at: iso(NOW) }, AWAY, NOW), false);
});

test('v2 행(접속 시각 없음): 꺼짐으로 단정하지 않는다 — 탭 상태는 쉬는 중, 얼굴은 깨어 있음', () => {
  const v2 = { id: 'a1', _v2: true, last_seen_at: null };
  assert.equal(crewOnline(v2, AWAY, NOW), true);
  assert.equal(agentRowState('idle', crewOnline(v2, AWAY, NOW)), 'idle', "'꺼져 있음'(away)이 아니다");
  assert.equal(crewFaceState({ crew: v2, now: NOW }), 'idle', '잠든 얼굴(off)이 아니다');
  assert.equal(crewFaceState({ crew: { id: 'a2', last_seen_at: iso(NOW - 200_000) }, now: NOW }), 'off', 'v1 꺼짐 얼굴은 그대로');
  assert.equal(crewOnline({ ...v2, hosting: 'bot', ready: false }, AWAY, NOW), false, 'v2라도 다시 연결이 필요한 쌍둥이는 꺼짐');
});

test('배선: 에이전트 탭·구성원 시트·레일 점은 모두 crewOnline을 쓴다(last_seen_at을 직접 재지 않는다)', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /seenWithin\([a-z], AWAY_MS, Date\.now\(\), crewSeenAt/);
  assert.match(app, /const on = g\.rows\.some\(\(r\) => crewOnline\(r, AWAY_MS\)\);/, '에이전트 탭');
  assert.match(app, /chCrews\.map\(\(c\) => \{ const on = crewOnline\(c, AWAY_MS\);/, '구성원 시트');
  assert.equal((app.match(/msgr-dot\$\{crewOnline\(c, AWAY_MS\) \? ' mark' : ''\}/g) ?? []).length, 2, '레일 점 두 곳');
});
