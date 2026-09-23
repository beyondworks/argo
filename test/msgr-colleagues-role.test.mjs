// 채널 동료 명단의 역할 — 서버 봉투 peers는 role_text만 싣는데(20260914090000_msgr_dm_relay.sql:68) 명단은 role을 읽어
// 동료의 역할이 프롬프트에서 늘 빠졌다(2026-09-24 기억 구조 조사). 협업·넘김 판단에 역할이 필요하다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-colleagues-'));
const { _messengerColleaguesForTest: colleagues } = await import('../src/chat.mjs');

test('서버 봉투의 role_text가 동료 명단 역할로 들어간다', () => {
  const ctx = { kind: 'msgr', crewId: 'me', peers: [{ id: 'me', slug: 'me' }, { id: 'p1', slug: 'dev', display_name: '카맥', role_text: '백엔드 개발' }, { id: 'p2', slug: 'x', display_name: 'X', role: '디자인' }] };
  assert.deepEqual(colleagues(ctx, 0).map((c) => c.role), ['백엔드 개발', '디자인']);
});
