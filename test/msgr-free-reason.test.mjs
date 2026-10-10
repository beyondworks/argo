// 본체 설정 카드의 연결이 무료 계정에서 멈춘 채 남았을 때의 이유(유건 2026-10-11 — app/api/companies/[ws]/msgr/free-reason.mjs).
// 잠그는 것: ① 이유 → 코드(limit → msgr_free_agent_limit, app·off → msgr_app_update_required, 이유 없음 → null)
// ② 서버가 이 기기의 새 앱을 모르면(app·off) 심박 한 번을 보내고 다시 판정 — 심박이 재개시켰으면 코드 없음 ③ 옛 서버(함수 없음)는 종전 is_pro 판정
// ④ 라우트가 이 함수를 쓰고, 서버 오류의 앞 코드(이유)를 msgr_pro_required보다 먼저 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freeAgentReason } from '../app/api/companies/[ws]/msgr/free-reason.mjs';
const { apiError } = await import('../app/apimsg.mjs');

const client = (seq, pro = false) => { const calls = []; return { calls, rpc: async (name) => { calls.push(name); if (name === 'is_pro') return { data: pro, error: null }; const next = seq.shift(); return next instanceof Error ? { data: null, error: { code: 'PGRST202', message: next.message } } : { data: next, error: null }; } }; };

test('① 이유 → 코드', async () => {
  assert.deepEqual(await freeAgentReason(client([{ paused: 1, active: 4, limit: 4, reason: 'limit' }])), { code: 'msgr_free_agent_limit', beaten: false });
  assert.deepEqual(await freeAgentReason(client([{ paused: 0, active: 2, limit: 4, reason: null }])), { code: null, beaten: false });
  for (const reason of ['app', 'off']) assert.deepEqual(await freeAgentReason(client([{ paused: 2, reason }, { paused: 2, reason }])), { code: 'msgr_app_update_required', beaten: false }, '심박을 못 보내면(기기 id 없음) 그대로');
});

test('② 새 앱이 아직 안 알려졌으면 심박 한 번 → 다시 판정(재개됐으면 코드 없음), limit이면 심박하지 않는다', async () => {
  let beats = 0; const beatNow = async () => { beats += 1; return true; };
  assert.deepEqual(await freeAgentReason(client([{ paused: 3, active: 0, reason: 'app' }, { paused: 0, active: 3, reason: null }]), { beatNow }), { code: null, beaten: true });
  assert.equal(beats, 1);
  assert.deepEqual(await freeAgentReason(client([{ paused: 3, reason: 'off' }, { paused: 3, reason: 'off' }]), { beatNow }), { code: 'msgr_app_update_required', beaten: true });
  await freeAgentReason(client([{ paused: 1, active: 4, reason: 'limit' }]), { beatNow });
  assert.equal(beats, 2, 'limit에는 심박이 소용없다');
  assert.deepEqual(await freeAgentReason(client([{ paused: 1, reason: 'app' }]), { beatNow: async () => { throw new Error('net'); } }), { code: 'msgr_app_update_required', beaten: false }, '심박 실패는 삼키고 첫 판정으로');
});

test('③ 옛 서버(msgr_my_agent_pause 없음) — 종전 is_pro 판정', async () => {
  const c1 = client([new Error('Could not find the function')], false);
  assert.deepEqual(await freeAgentReason(c1), { code: 'msgr_pro_required', beaten: false });
  assert.deepEqual(c1.calls, ['msgr_my_agent_pause', 'is_pro']);
  assert.deepEqual(await freeAgentReason(client([new Error('x')], true)), { code: null, beaten: false });
});

test('④ 라우트 배선 + 코드가 ko·en 사전에 있다', () => {
  const route = readFileSync(new URL('../app/api/companies/[ws]/msgr/route.js', import.meta.url), 'utf8');
  assert.equal((route.match(/await freeAgentReasonFor\(c, ws\)/g) ?? []).length, 2, '연결 두 갈래(일괄 activate·단일 POST)');
  assert.ok(route.indexOf('/msgr_free_agent_limit/.test(m)') < route.indexOf('/msgr_pro_required/.test(m)'), '앞 코드(이유)를 먼저 본다');
  assert.ok(route.indexOf('/msgr_app_update_required/.test(m)') < route.indexOf('/msgr_pro_required/.test(m)'));
  for (const code of ['msgr_free_agent_limit', 'msgr_app_update_required']) for (const lang of ['ko', 'en']) assert.equal(apiError(code, lang).status, 403);
});
