// 2026-10-22 결함: v2 셸 폰 에이전트 탭이 늘 "아직 연결된 에이전트가 없어요"였다(데스크톱 레일에는 내 에이전트가 보이는데).
// 원인: loadMyAgents가 옛 모델로 목록을 만든다 — 개인 행(msgr_personal_room_crews, v2 'none' = 빈 결과) + org_id 있는 조직 쌍둥이 행. v2 연결기는 내 에이전트를 org_id null 한 행으로 돌려줘(CrewBuilder) 둘 다 0이었다.
// 화면은 픽스처(test/v2-shell.fixture.html, ?noagents=1 포함)에서 390·1280·라이트·다크로 눌러 봤다(PR 본문).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v2MyAgents, groupAgents } from '../src/agent-groups.mjs';

const ME = 'u-me';
const row = (id, o = {}) => ({ id, owner_user_id: ME, display_name: id, status: 'active', org_id: null, hosting: 'local', ...o });

test('v2MyAgents: 내 활성 에이전트 한 행씩(개인 공간 = org_id null), 남의 것·멈춤·은퇴·중복은 뺀다', () => {
  const out = v2MyAgents([row('a'), row('b', { org_id: 'space-x' }), row('c', { owner_user_id: 'u-other' }), row('d', { status: 'paused' }), row('e', { status: 'retired' }), row('a')], ME);
  assert.deepEqual(out.map((x) => x.id), ['a', 'b']);
  assert.ok(out.every((x) => x.org_id === null), '모두 개인 공간 행(폰 탭을 누르면 개인 공간 1:1 — openAgent의 space = org_id ?? PERSONAL)');
  assert.deepEqual(v2MyAgents(null, ME), []);
  assert.deepEqual(v2MyAgents([row('a')], null), [], '로그인 전');
});

test('폰 에이전트 탭 묶음: v2 행은 에이전트마다 한 줄(외부 봇 표시 유지)', () => {
  const g = groupAgents(v2MyAgents([row('a', { display_name: '리서치' }), row('b', { display_name: '봇', hosting: 'bot' })], ME));
  assert.deepEqual(g.map((x) => [x.display_name, x.rows.length, x.ext]), [['리서치', 1, false], ['봇', 1, true]].sort((p, q) => p[0].localeCompare(q[0], 'ko')));
});

test('App 배선: v2는 loadMyAgents가 readOwnCrews 행으로 목록을 만든다(옛 개인 행·쌍둥이 행 조합은 v2 끔에서만)', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('  const loadMyAgents = useCallback('), app.indexOf('}, [uid]); // eslint-disable-line react-hooks/exhaustive-deps -- readOwnCrews는 uid로만 바뀐다'));
  const v2 = fn.indexOf('if (V2) { setMyAgents(stampFetched(v2MyAgents(own.rows, uid))); return; }'), old = fn.indexOf('withoutCopies(personal ?? [])');
  assert.ok(v2 > 0 && old > v2, 'v2 갈래가 옛 조합보다 먼저');
  assert.ok(fn.indexOf('setOwnCrews(newerOwn(own));') < v2, 'ownCrews(온보딩 hasAgent 재료)는 v2에서도 그대로 채운다');
});
