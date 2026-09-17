// 브리지 소유자 게이트는 "일치할 때만 연다"(실사고 2026-09-17 윈도우 PC). 예전 계정이 쓰던 회사 폴더가 남아 있는 PC에 다른 계정으로 로그인하자,
// 그 회사의 크루 12명이 새 계정 소유로 lean-win·Lean-AX에 미러됐다. 게이트가 "소유자가 있을 때만 비교"라 소유자 미기록·설정 읽기 실패가 통과하는 길이 열려 있었다.
// 실제 startMsgrBridge를 격리 루트에서 돌려, 세 경우 모두 DB(조직·크루)를 한 번도 부르지 않는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-owner-gate-')); // 격리 루트 — 실데이터 미접촉
const { startMsgrBridge } = await import('../src/gateway/msgr.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');

const spySession = (uid) => {
  const touched = [];
  const db = new Proxy({}, { get: (_, k) => async () => { touched.push(String(k)); return []; } });
  const client = { channel: () => ({ on() { return this; }, subscribe() {}, unsubscribe() {} }), rpc: async () => ({ data: [], error: null }), from: () => { touched.push('from'); throw new Error('no db in test'); } };
  return { touched, session: async () => ({ uid, db, client }) };
};
const runOnce = async (ws, session) => { const stop = startMsgrBridge(ws, { session, pollMs: 60_000 }); await new Promise((r) => setTimeout(r, 150)); stop(); };
const beat = async (ws) => JSON.parse(await readFile(join(paths(ws).root, '.gateway-msgr.json'), 'utf8'));

test('남의 회사(소유자 ≠ 로그인 계정) → DB를 부르지 않고 "소유자 아님"', async () => {
  const ws = 'owner-other'; await createCompany(ws, 'Lean-AX', 'x', 'user-beyond');
  const { touched, session } = spySession('user-lean8'); await runOnce(ws, session);
  assert.deepEqual(touched, [], `DB 호출 없음 (${touched})`);
  assert.match((await beat(ws)).error, /소유자/);
});

test('소유자가 기록되지 않은 회사 → 아무 계정에도 귀속하지 않는다(회사 목록 API와 같은 규칙)', async () => {
  const ws = 'owner-none'; await createCompany(ws, 'legacy', 'x');
  const { touched, session } = spySession('user-lean8'); await runOnce(ws, session);
  assert.deepEqual(touched, [], `DB 호출 없음 (${touched})`);
  assert.equal((await beat(ws)).ok, false);
});

test('company.json을 읽지 못함(손상·쓰기 중) → 이번 폴은 건너뛴다 — 빈 설정으로 게이트를 열지 않는다', async () => {
  const ws = 'owner-broken'; await mkdir(paths(ws).root, { recursive: true }); await writeFile(paths(ws).company, '{ "ownerId": "user-be');
  const { touched, session } = spySession('user-lean8'); await runOnce(ws, session);
  assert.deepEqual(touched, [], `DB 호출 없음 (${touched})`);
  assert.match((await beat(ws)).error, /회사 설정을 읽지 못함/);
});

test('소유자 = 로그인 계정이면 그대로 돈다(대조군)', async () => {
  const ws = 'owner-me'; await createCompany(ws, 'lean-win', 'x', 'user-lean8');
  const { touched, session } = spySession('user-lean8'); await runOnce(ws, session);
  assert.ok(touched.includes('myCrews'), `드레인이 돈다 (${touched})`);
});

test('서버가 크루 등록을 거부(msgr_ws_owned_by_other)하면 "연결됨"이 아니라 이유를 상태로 남긴다(검수 MEDIUM-A)', async () => {
  const ws = 'owner-rejected'; await createCompany(ws, 'lean-win', 'x', 'user-lean8');
  await mkdir(join(paths(ws).root, 'agents'), { recursive: true }); await writeFile(join(paths(ws).root, 'agents', 'hyori.md'), '---\nname: 효리\n---\n');
  const db = new Proxy({}, { get: (_, k) => async () => {
    if (k === 'myOrgIds') return ['org-1'];
    if (k === 'upsertAvailable') throw new Error('msgr_ws_owned_by_other');
    return k === 'orgAllowDefaults' ? {} : [];
  } });
  const client = { channel: () => ({ on() { return this; }, subscribe() {}, unsubscribe() {} }), rpc: async () => ({ data: [], error: null }), from: () => { throw new Error('no db in test'); } };
  await runOnce(ws, async () => ({ uid: 'user-lean8', db, client }));
  const b = await beat(ws);
  assert.equal(b.ok, false); assert.match(b.error, /다른 계정 소유/);
});
