// 게이트웨이 신뢰성 회귀 테스트 — 슬랙 인가(사장 게이트)·큐 소유권(dev 태그)·동기화 경계.
// 실행: npm test (node --test). 임시 ARGO_ROOT — 실데이터 미접촉.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 워크스페이스 루트를 임시 폴더로 — WS_ROOT는 모듈 로드 시 확정되므로 import보다 먼저 심는다.
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gwtest-'));
const { EXCLUDE } = await import('../src/sync.mjs');
const { classifySlackMessage, enqueueJob, startQueueWorker, queueDir } = await import('../src/gateway.mjs');
const { updateConnection, maskConnections, sanitizeToken } = await import('../src/connections.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');

/* ── sync EXCLUDE: 큐는 로컬 전용, 슬랙 커서는 동기화 ── */
test('EXCLUDE: 디스크 큐는 디렉터리 안 파일까지 동기화 제외(이중 실행 방지)', () => {
  assert.equal(EXCLUDE('.gw-queue-telegram/12345.json'), true, '큐 잡 파일은 동기화 금지');
  assert.equal(EXCLUDE('.gw-queue-tg-luca/alb-99.json'), true, '크루 봇 큐도 동일');
  assert.equal(EXCLUDE('.gw-offset-telegram.json'), true, '폴러 offset은 기기별');
  assert.equal(EXCLUDE('.gateway-slack.json'), true, '하트비트는 기기별');
});

test('EXCLUDE: 슬랙 커서는 동기화 대상 — 리더가 바뀐 기기가 마지막 지점을 이어받는다', () => {
  assert.equal(EXCLUDE('gw-cursor-slack.json'), false);
  assert.equal(EXCLUDE('vault/notes/hello.md'), false, '일반 파일은 기존대로 동기화');
  assert.equal(EXCLUDE('chats/luca.json'), false);
});

/* ── 슬랙 메시지 분류: 페어링·사장 게이트 ── */
const BOT = 'B0BOT';
test('classifySlackMessage: 봇·비텍스트·subtype은 skip', () => {
  const cfg = { botUserId: BOT, ownerId: 'U1' };
  assert.equal(classifySlackMessage(cfg, { text: 'x', bot_id: 'B9' }).kind, 'skip');
  assert.equal(classifySlackMessage(cfg, { text: 'x', user: BOT }).kind, 'skip', '자기 메시지 무한루프 방지');
  assert.equal(classifySlackMessage(cfg, { text: 'x', user: 'U1', subtype: 'channel_join' }).kind, 'skip');
  assert.equal(classifySlackMessage(cfg, { user: 'U1' }).kind, 'skip', '텍스트 없음');
});

test('classifySlackMessage: 미페어링 — 코드 일치만 pair, 나머지는 hint(실행 없음)', () => {
  const cfg = { botUserId: BOT, ownerId: null, pairCode: 'AB2CD3' };
  assert.deepEqual(classifySlackMessage(cfg, { text: 'ab2cd3', user: 'U7' }), { kind: 'pair', user: 'U7' }, '대소문자 무관 코드 일치');
  assert.equal(classifySlackMessage(cfg, { text: '보고서 만들어줘', user: 'U7' }).kind, 'hint', '페어링 전엔 지시를 실행하지 않는다');
  assert.equal(classifySlackMessage({ ...cfg, pairCode: '' }, { text: 'AB2CD3', user: 'U7' }).kind, 'hint', '코드 미발급 상태에선 페어링 불가');
});

test('classifySlackMessage: 페어링 후 — 사장만 turn/approval, 다른 멤버는 skip', () => {
  const cfg = { botUserId: BOT, ownerId: 'U1' };
  assert.deepEqual(classifySlackMessage(cfg, { text: '<@UBOTID> 보고서 정리해줘', user: 'U1' }), { kind: 'turn', text: '보고서 정리해줘' }, '멘션 제거 후 턴');
  assert.equal(classifySlackMessage(cfg, { text: '보고서 정리해줘', user: 'U2' }).kind, 'skip', '사장 아닌 멤버는 크루 구동 불가');
  assert.equal(classifySlackMessage(cfg, { text: '승인 ap-abc123', user: 'U2' }).kind, 'skip', '사장 아닌 멤버는 결재 불가');
  const ap = classifySlackMessage(cfg, { text: '승인 ap-abc123', user: 'U1' });
  assert.deepEqual(ap, { kind: 'approval', approve: true, id: 'ap-abc123' }, '사장의 결재 회신은 즉시 처리 경로');
  assert.equal(classifySlackMessage(cfg, { text: '거절 ap-xyz9', user: 'U1' }).approve, false);
});

/* ── 큐 소유권: dev 태그 — 내 잡만 실행 ── */
test('enqueueJob: 적재 기기 dev 태그가 붙는다', async () => {
  const WS = 'gwtest-tag';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await enqueueJob(WS, 'telegram', '1', { text: 'hello' });
  const raw = JSON.parse(await readFile(join(queueDir(WS, 'telegram'), '1.json'), 'utf8'));
  assert.equal(raw.dev, await getDeviceId(), '잡에 이 기기 id가 태깅된다');
  assert.equal(raw.text, 'hello');
});

test('큐 워커: 내 잡·신선한 레거시 잡만 실행, 남의 사본·오래된 구형식은 정리(좀비/이중 실행 방지)', async () => {
  const WS = 'gwtest-queue';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const dir = queueDir(WS, 'telegram');
  await enqueueJob(WS, 'telegram', '100', { text: '내 잡' }); // dev = 이 기기
  await writeFile(join(dir, '200.json'), JSON.stringify({ text: '남의 잡', dev: 'other-device-xyz' }));
  await writeFile(join(dir, '300.json'), JSON.stringify({ text: '구형식 오래됨' }));
  const old = new Date(Date.now() - 25 * 3_600_000); // 24h 컷 초과
  await utimes(join(dir, '300.json'), old, old);
  await writeFile(join(dir, '400.json'), JSON.stringify({ text: '구형식 신선' })); // 픽스 배포 직후의 미처리 잡
  const ran = [];
  const stop = startQueueWorker(WS, 'telegram', async (job) => { ran.push(job.text); });
  // 폴링 대기 — 고정 sleep은 CI 부하에서 플레이크. 조건 충족 시 즉시 통과(최대 8s).
  const deadline = Date.now() + 8000;
  for (;;) {
    const left = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
    if ((left.length === 0 && ran.length >= 2) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  assert.ok(ran.includes('내 잡'), '이 기기가 적재한 잡은 실행된다');
  assert.ok(ran.includes('구형식 신선'), 'dev 태그 없는 신선한 잡은 실행(업그레이드 직후 유실 방지)');
  assert.ok(!ran.includes('남의 잡'), '다른 기기 사본은 실행하지 않는다');
  assert.ok(!ran.includes('구형식 오래됨'), '오래된 구형식 잡은 좀비 실행하지 않는다');
  const left = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
  assert.equal(left.length, 0, '실행분·정리분 모두 큐에서 제거된다');
});

/* ── 슬랙 페어링 필드(connections) ── */
test('슬랙 연결: 토큰 저장 시 페어링 코드 발급, 페어링 후 코드 숨김, 새 토큰이면 리셋', async () => {
  const WS = 'gwtest-conn';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const all1 = await updateConnection(WS, 'slack', { token: 'xoxb-test-1', channel: 'C123', enabled: true });
  assert.equal(all1.slack.ownerId, null, '초기엔 미페어링');
  assert.match(all1.slack.pairCode, /^[A-HJ-NP-Z2-9]{6}$/, '6자 코드 발급(혼동 글자 제외)');
  const m1 = maskConnections(all1);
  assert.equal(m1.slack.paired, false);
  assert.equal(m1.slack.pairCode, all1.slack.pairCode, '미페어링엔 코드 노출(설정 화면 표시)');
  assert.ok(!JSON.stringify(m1).includes('xoxb-test-1'), '토큰 평문은 화면에 새지 않는다');

  const all2 = await updateConnection(WS, 'slack', { ownerId: 'U777', pairCode: '' }); // 게이트웨이 페어링과 동일 patch
  const m2 = maskConnections(all2);
  assert.equal(m2.slack.paired, true);
  assert.equal(m2.slack.pairCode, '', '페어링 후엔 코드 숨김(재사용 방지)');

  const all3 = await updateConnection(WS, 'slack', { token: 'xoxb-test-2' });
  assert.equal(all3.slack.ownerId, null, '새 토큰 = 페어링 리셋');
  assert.match(all3.slack.pairCode, /^[A-HJ-NP-Z2-9]{6}$/, '새 코드 재발급');
});

test('슬랙 연결: 레거시 설정(코드·오너 없음)은 빈 patch로도 코드가 백필된다', async () => {
  const WS = 'gwtest-legacy';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  // 이 픽스 이전 형태의 connections.json을 그대로 재현
  await writeFile(join(process.env.ARGO_ROOT, WS, 'connections.json'), JSON.stringify({
    telegram: { token: '', chatId: null, defaultCrew: '', enabled: false, botUsername: '', agents: {} },
    slack: { token: 'xoxb-legacy', channel: 'C9', botUserId: 'B1', defaultCrew: '', enabled: true, botUsername: 'argo' },
  }));
  const all = await updateConnection(WS, 'slack', {}); // startSlack 기동 시의 레거시 보정 경로
  assert.equal(all.slack.ownerId, null);
  assert.match(all.slack.pairCode, /^[A-HJ-NP-Z2-9]{6}$/, '기존 사용자도 재저장 없이 코드를 받는다');
});

/* ── 토큰 정제 — 붙여넣기 시 섞인 공백·개행·zero-width가 URL을 깨 "fetch failed"로 저장 롤백되던 버그(2026-07-24) ── */
test('sanitizeToken: 공백·개행·zero-width·BOM·nbsp 제거, 봇 토큰 형식 보존', () => {
  const bot = '8825847980:AAExampleTokenABCdef-_123';
  assert.equal(sanitizeToken(` ${bot}\n`), bot, '앞뒤 공백·개행 제거');
  assert.equal(sanitizeToken(bot.slice(0, 10) + '​' + bot.slice(10)), bot, '중간 zero-width(200B) 제거');
  assert.equal(sanitizeToken('﻿' + bot), bot, 'BOM 제거');
  assert.equal(sanitizeToken('12:ab cd'), '12:abcd', 'nbsp 제거');
  assert.equal(sanitizeToken(''), '', '빈값 안전');
  assert.equal(sanitizeToken(null), '', 'null 안전');
  assert.equal(sanitizeToken(bot), bot, '깨끗한 토큰은 불변');
});

test('updateConnection: 저장 시 토큰 정제 — 디스크에 깨끗한 값만 (검증과 동일값 보장)', async () => {
  const WS = 'gwtest-tok';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const bot = '8811111111:AAcleanTokenXYZ_-9';
  const all = await updateConnection(WS, 'telegram', { token: ` ${bot}\n​` }); // 오염된 붙여넣기 재현
  assert.equal(all.telegram.token, bot, '저장값은 정제되어 원본 토큰과 일치(URL 안 깨짐)');
});
