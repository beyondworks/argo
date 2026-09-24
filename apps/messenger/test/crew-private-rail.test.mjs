// 외부(VPS) 봇도 Argo 에이전트처럼 — 남의 레일에 뜨지 않고 회사 등급이 아니다(유건 2026-09-24: "VPS 에이전트들이 다른 사람 계정에도 뜨고").
// App.jsx의 판정 줄을 그대로 뽑아 실행한다(rail-state.test.mjs와 같은 방식 — 소스 문자열 단언이 아니라 행동).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const line = (start) => { const i = app.indexOf(start); assert.ok(i >= 0, start); return app.slice(i, app.indexOf('\n', i)); };
const crewTier = new Function(`${line('export const crewTier =').replace('export const', 'const')}\nreturn crewTier;`)();
const railVisible = (crews, uid, org) => new Function('crews', 'uid', 'org', 'crewTier', `${line('const railVisible =')}\nreturn railVisible;`)(crews, uid, org, crewTier);

const org = { service_user_id: 'svc' };
const crews = [
  { id: 'my-bot', hosting: 'bot', owner_user_id: 'me' },
  { id: 'their-bot', hosting: 'bot', owner_user_id: 'bran' },
  { id: 'their-local', hosting: 'local', owner_user_id: 'bran' },
  { id: 'company', hosting: 'resident', owner_user_id: 'svc' },
];

test('봇은 회사 등급이 아니다 — 회사 등급은 조직 서비스 계정의 상주 크루뿐', () => {
  assert.equal(crewTier(crews[1], org), 'personal');
  assert.equal(crewTier(crews[3], org), 'company');
});

test('레일에는 내 에이전트(봇 포함)와 회사 크루만 — 남의 봇·남의 로컬 에이전트는 안 보인다', () => {
  assert.deepEqual(railVisible(crews, 'me', org).map((c) => c.id), ['my-bot', 'company']);
  assert.deepEqual(railVisible(crews, 'bran', org).map((c) => c.id), ['their-bot', 'their-local', 'company']);
});

test('새 채팅(그룹) 선택 창도 같은 목록 — 남의 에이전트는 후보에 없다(유건 제보 2026-09-24: "그룹에는 다른 사람 에이전트 뜨잖아")', () => {
  const call = line('{dmGroup && <DmGroupSheet');
  assert.match(call, /\bcrews=\{railVisible\}/, '레일과 같은 판정(내 에이전트 + 회사 크루)만 넘긴다');
});

test('검색 결과·활동(기억) 화면의 에이전트 목록도 같은 규칙 — 남의 에이전트는 없다', () => {
  assert.match(line('setSearchRes({ q: qs'), /agents: crews\.filter\(\(c\) => \(c\.owner_user_id === uid \|\| crewTier\(c, org\) === 'company'\) &&/, '검색');
  const own = new Function('crews', 'uid', 'org', 'crewTier', `${line('const ownCrews =')}\nreturn ownCrews;`)(crews, 'me', org, crewTier);
  assert.deepEqual(own.map((c) => c.id), ['my-bot', 'company'], '활동 트리의 에이전트 목록');
  assert.match(app, /id="crews" label=\{t\('act\.tree\.crews'\)\} sub=\{ownCrews\.length\} depth=\{1\} kids=\{ownCrews\.map/, '트리는 ownCrews를 그린다');
});
