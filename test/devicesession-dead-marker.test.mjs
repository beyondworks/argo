// 기기 세션 사망 마커 — 회전 없는 판정 계약(분리 검수 M3·M4).
//  ① 마커는 "리프레시 토큰 거절"에만 생긴다 — 네트워크 실패는 오프라인이지 사망이 아니다
//  ② deviceSessionDead는 파일만 읽는다(회전 트리거 금지 — UI 마운트발 이중 회전이 세션 가족을 폐기한 사고 구조)
//  ③ 회생(정상 회전)하면 마커가 지워진다
//  ④ (2026-09-02 재발 제보) 마커는 사유 JSON, 로그(.device-session.log)에 회전·거절이 남는다,
//     거절 시 디스크를 캐시 무시로 재독해 토큰이 바뀌었으면 그 세션으로 1회만 재시도(다른 프로세스 회전 자가 치유)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreshDeviceSession, deviceSessionDead, deviceSessionDeadInfo, rejectionKind } from '../src/devicesession.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);
const sessJson = (rt, expiresInSec, at = 'at') => JSON.stringify({
  url: 'https://x.supabase.co', anonKey: 'anon', user: { id: 'u1', email: 'a@b.c' },
  access_token: at, refresh_token: rt, expires_at: nowSec() + expiresInSec,
});
const mkRoot = async (expiresInSec) => {
  const root = await mkdtemp(join(tmpdir(), 'argo-devdead-'));
  await writeFile(join(root, '.device-session.json'), sessJson('rt', expiresInSec));
  return root;
};
const clientWith = (refreshImpl) => () => ({ auth: { refreshSession: refreshImpl } });
const reject = (message, extra = {}) => ({ data: {}, error: Object.assign(new Error(message), extra) });
const ok = (at, rt) => ({ data: { session: { access_token: at, refresh_token: rt, expires_at: nowSec() + 3600, user: { id: 'u1', email: 'a@b.c' } } }, error: null });
const readLog = async (root) => (await readFile(join(root, '.device-session.log'), 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const marker = (root) => join(root, '.device-session.json.dead');

test('리프레시 거절 → 마커 생성 → deviceSessionDead true (회전 없이 판정)', async () => {
  const root = await mkRoot(-10);
  assert.equal(deviceSessionDead({ root }), false, '마커 전에는 만료여도 dead 아님(오프라인 오탐 방지)');
  const out = await getFreshDeviceSession({ root, _mkClient: clientWith(async () => reject('Invalid Refresh Token: Already Used')) });
  assert.equal(out, null);
  assert.equal(existsSync(marker(root)), true, '거절 마커');
  assert.equal(deviceSessionDead({ root }), true);
});

test('네트워크 실패는 마커를 만들지 않는다 — 오프라인 ≠ 재로그인 필요 (로그엔 error 한 줄)', async () => {
  const root = await mkRoot(-10);
  await getFreshDeviceSession({ root, _mkClient: clientWith(async () => reject('fetch failed')) }).catch(() => null);
  assert.equal(existsSync(marker(root)), false);
  assert.equal(deviceSessionDead({ root }), false);
  assert.deepEqual((await readLog(root)).map((l) => l.ev), ['error']);
});

test('정상 회전이면 마커 해제 + 미만료 세션은 항상 dead 아님 + 로그에 rotated 한 줄', async () => {
  const root = await mkRoot(-10);
  await writeFile(marker(root), 'x');
  const fresh = await getFreshDeviceSession({ root, _mkClient: clientWith(async () => ok('at2', 'rt2')) });
  assert.ok(fresh?.access_token === 'at2');
  assert.equal(existsSync(marker(root)), false, '회생 시 마커 해제');
  assert.equal(deviceSessionDead({ root }), false);
  assert.equal(JSON.parse(await readFile(join(root, '.device-session.json'), 'utf8')).refresh_token, 'rt2', '회전 토큰 영속');
  const log = await readLog(root);
  assert.equal(log.length, 1);
  assert.equal(log[0].ev, 'rotated');
  assert.equal(typeof log[0].pid, 'number', '어느 프로세스가 회전했는지(상주 vs 사이드카)');
  assert.equal(log[0].expires_at, fresh.expires_at);
});

// ── ④ 사유 기록 ──────────────────────────────────────────────────────────
test('거절 마커는 사유 JSON — kind·reason(토큰 마스킹)·status·code, 호출 1회(디스크 동일=재시도 없음), 로그 rejected', async () => {
  const root = await mkRoot(-10);
  const calls = [];
  const token = 'A'.repeat(40);
  await getFreshDeviceSession({ root, _mkClient: clientWith(async ({ refresh_token }) => { calls.push(refresh_token); return reject(`Invalid Refresh Token: Already Used ${token}`, { status: 400, code: 'refresh_token_already_used' }); }) });
  assert.deepEqual(calls, ['rt'], '디스크 토큰이 그대로면 재시도하지 않는다');
  const info = deviceSessionDeadInfo({ root });
  assert.equal(info.kind, 'reused');
  assert.equal(info.status, 400);
  assert.equal(info.code, 'refresh_token_already_used');
  assert.equal(info.retried, false);
  assert.equal(info.count, 1);
  assert.ok(info.reason.includes('Already Used') && info.reason.includes('***') && !info.reason.includes(token), `토큰 모양은 가린다: ${info.reason}`);
  assert.ok(!readFileSync(marker(root), 'utf8').includes(token), '마커 파일 원문에도 토큰 없음');
  const log = await readLog(root);
  assert.equal(log.length, 1);
  assert.equal(log[0].ev, 'rejected');
  assert.equal(log[0].kind, 'reused');
  assert.ok(!log[0].reason.includes(token), '로그에도 토큰 없음');
  assert.equal(deviceSessionDead({ root }), true, '판정 계약은 그대로');
});

test('같은 사유가 반복되면 at(최초 시각) 보존 + count 증가, 로그는 한 줄만(동기화 8초 주기 방어)', async () => {
  const root = await mkRoot(-10);
  const client = clientWith(async () => reject('Invalid Refresh Token: Refresh Token Not Found'));
  await getFreshDeviceSession({ root, _mkClient: client });
  const first = deviceSessionDeadInfo({ root });
  await new Promise((r) => setTimeout(r, 5));
  await getFreshDeviceSession({ root, _mkClient: client });
  const second = deviceSessionDeadInfo({ root });
  assert.equal(second.kind, 'revoked');
  assert.equal(second.at, first.at, '최초 시각 보존');
  assert.notEqual(second.lastAt, first.lastAt, '마지막 시각은 갱신');
  assert.equal(second.count, 2);
  assert.equal((await readLog(root)).filter((l) => l.ev === 'rejected').length, 1, '연속 같은 사유는 한 줄');
});

test('거절 후 디스크 토큰이 바뀌었고 아직 유효 → 재갱신 없이 디스크 세션 채택, 마커 없음(다른 프로세스 회전 자가 치유)', async () => {
  const root = await mkRoot(-10);
  const calls = [];
  const out = await getFreshDeviceSession({ root, _mkClient: clientWith(async ({ refresh_token }) => {
    calls.push(refresh_token);
    await writeFile(join(root, '.device-session.json'), sessJson('rt2', 3600, 'at2')); // 다른 프로세스가 먼저 회전
    return reject('Invalid Refresh Token: Already Used');
  }) });
  assert.deepEqual(calls, ['rt'], '유효한 디스크 세션은 다시 회전하지 않는다');
  assert.equal(out?.access_token, 'at2');
  assert.equal(existsSync(marker(root)), false, '자가 치유 = 사망 아님');
  assert.deepEqual((await readLog(root)).map((l) => l.ev), ['reread']);
  assert.equal(deviceSessionDead({ root }), false);
});

test('거절 후 디스크 토큰이 바뀌었으나 만료 → 그 토큰으로 딱 1회 재시도 성공 → 영속·마커 없음', async () => {
  const root = await mkRoot(-10);
  const calls = [];
  const out = await getFreshDeviceSession({ root, _mkClient: clientWith(async ({ refresh_token }) => {
    calls.push(refresh_token);
    if (calls.length === 1) { await writeFile(join(root, '.device-session.json'), sessJson('rt2', -5, 'at2')); return reject('Invalid Refresh Token: Already Used'); }
    return ok('at3', 'rt3');
  }) });
  assert.deepEqual(calls, ['rt', 'rt2']);
  assert.equal(out?.access_token, 'at3');
  assert.equal(JSON.parse(await readFile(join(root, '.device-session.json'), 'utf8')).refresh_token, 'rt3');
  assert.equal(existsSync(marker(root)), false);
  const log = await readLog(root);
  assert.deepEqual(log.map((l) => l.ev), ['reread', 'rotated']);
  assert.equal(log[1].retried, true);
});

test('재시도(디스크 토큰)까지 거절되면 그때만 마커 — retried:true, 호출은 정확히 2회(무한 재시도 금지)', async () => {
  const root = await mkRoot(-10);
  const calls = [];
  const out = await getFreshDeviceSession({ root, _mkClient: clientWith(async ({ refresh_token }) => {
    calls.push(refresh_token);
    await writeFile(join(root, '.device-session.json'), sessJson(`rt${calls.length + 1}`, -5)); // 매 호출 디스크가 또 바뀌어도
    return reject('Invalid Refresh Token: Session Expired (Revoked by Newer Login)');
  }) });
  assert.equal(out, null);
  assert.deepEqual(calls, ['rt', 'rt2'], '재독은 한 번뿐');
  const info = deviceSessionDeadInfo({ root });
  assert.equal(info.retried, true);
  assert.equal(info.kind, 'expired');
  assert.ok(info.reason.includes('Revoked by Newer Login'), '서버가 준 세부 사유(괄호)는 원문 보존');
  assert.equal(deviceSessionDead({ root }), true);
});

test('구형 마커(ISO 문자열)는 info null이되 dead 판정은 유지 — 발행본 호환', async () => {
  const root = await mkRoot(-10);
  await writeFile(marker(root), new Date().toISOString());
  assert.equal(deviceSessionDeadInfo({ root }), null);
  assert.equal(deviceSessionDead({ root }), true);
});

test('rejectionKind 값 집합 ↔ i18n 사전 me.sessionDead.kind.* 1:1 — /api/me·사이드바 배선 핀', async () => {
  const kinds = new Set(['Invalid Refresh Token: Already Used', 'Invalid Refresh Token: Refresh Token Not Found',
    'Invalid Refresh Token: Session Expired (Inactivity)', 'Invalid Refresh Token', ''].map(rejectionKind));
  assert.deepEqual([...kinds].sort(), ['expired', 'rejected', 'reused', 'revoked']);
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of kinds) assert.ok(dict.includes(`'me.sessionDead.kind.${k}': [`), `사전 키 누락: ${k}`);
  // 템플릿 키(t(`...${kind}`))는 i18n-keys 검사기 그물 밖 — 소비자 배선을 여기서 잠근다
  const me = await readFile(new URL('../app/api/me/route.js', import.meta.url), 'utf8');
  assert.ok(/sessionDead = !cookieAlive;[\s\S]{0,400}deviceSessionDeadInfo\(\)[\s\S]{0,400}sessionDead: true, sessionDeadInfo \}/.test(me), '/api/me가 마커 사유를 실어 보낸다');
  const layout = await readFile(new URL('../app/c/[ws]/layout.jsx', import.meta.url), 'utf8');
  assert.ok(/me\?\.sessionDead\s*\?\s*<Link[^>]*title=\{me\.sessionDeadInfo \? `[^`]*\$\{t\(`me\.sessionDead\.kind\.\$\{me\.sessionDeadInfo\.kind\}`\)\} \(\$\{me\.sessionDeadInfo\.reason\}\)`/.test(layout), '사이드바 툴팁이 분류 문구 + 원문 사유를 보여준다');
});
