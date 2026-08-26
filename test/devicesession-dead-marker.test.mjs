// 기기 세션 사망 마커 — 회전 없는 판정 계약(분리 검수 M3·M4).
//  ① 마커는 "리프레시 토큰 거절"에만 생긴다 — 네트워크 실패는 오프라인이지 사망이 아니다
//  ② deviceSessionDead는 파일만 읽는다(회전 트리거 금지 — UI 마운트발 이중 회전이 세션 가족을 폐기한 사고 구조)
//  ③ 회생(정상 회전)하면 마커가 지워진다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreshDeviceSession, deviceSessionDead } from '../src/devicesession.mjs';

const mkRoot = async (expiresInSec) => {
  const root = await mkdtemp(join(tmpdir(), 'argo-devdead-'));
  await writeFile(join(root, '.device-session.json'), JSON.stringify({
    url: 'https://x.supabase.co', anonKey: 'anon', user: { id: 'u1', email: 'a@b.c' },
    access_token: 'at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
  }));
  return root;
};
const clientWith = (refreshImpl) => () => ({ auth: { refreshSession: refreshImpl } });

test('리프레시 거절 → 마커 생성 → deviceSessionDead true (회전 없이 판정)', async () => {
  const root = await mkRoot(-10);
  assert.equal(deviceSessionDead({ root }), false, '마커 전에는 만료여도 dead 아님(오프라인 오탐 방지)');
  const out = await getFreshDeviceSession({ root, _mkClient: clientWith(async () => ({ data: {}, error: new Error('Invalid Refresh Token: Already Used') })) });
  assert.equal(out, null);
  assert.equal(existsSync(join(root, '.device-session.json.dead')), true, '거절 마커');
  assert.equal(deviceSessionDead({ root }), true);
});

test('네트워크 실패는 마커를 만들지 않는다 — 오프라인 ≠ 재로그인 필요', async () => {
  const root = await mkRoot(-10);
  await getFreshDeviceSession({ root, _mkClient: clientWith(async () => ({ data: {}, error: new Error('fetch failed') })) }).catch(() => null);
  assert.equal(existsSync(join(root, '.device-session.json.dead')), false);
  assert.equal(deviceSessionDead({ root }), false);
});

test('정상 회전이면 마커 해제 + 미만료 세션은 항상 dead 아님', async () => {
  const root = await mkRoot(-10);
  await writeFile(join(root, '.device-session.json.dead'), 'x');
  const fresh = await getFreshDeviceSession({ root, _mkClient: clientWith(async () => ({ data: { session: { access_token: 'at2', refresh_token: 'rt2', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.c' } } }, error: null })) });
  assert.ok(fresh?.access_token === 'at2');
  assert.equal(existsSync(join(root, '.device-session.json.dead')), false, '회생 시 마커 해제');
  assert.equal(deviceSessionDead({ root }), false);
  assert.equal(JSON.parse(await readFile(join(root, '.device-session.json'), 'utf8')).refresh_token, 'rt2', '회전 토큰 영속');
});
