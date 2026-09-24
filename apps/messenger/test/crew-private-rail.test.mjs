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
