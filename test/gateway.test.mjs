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

test('updateAgentBot: 크루 직통 봇도 저장 시 토큰 정제 (검수 HIGH 반영)', async () => {
  const WS = 'gwtest-agenttok';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const { updateAgentBot } = await import('../src/connections.mjs');
  const bot = '8822222222:AAagentCleanTok_-8';
  const all = await updateAgentBot(WS, 'luca', { token: ` ${bot}\n​` }); // 오염 붙여넣기
  assert.equal(all.telegram.agents.luca.token, bot, '크루 직통 봇 저장값도 정제됨');
});

/* ── 진행 표시 유지 — 텔레그램 typing은 5초면 꺼진다(요청 2026-07-26) ── */
test('startTypingKeepalive: 주기 갱신 + 장시간 1회 안내 + stop 후 정지', async () => {
  const { _typingForTest } = await import('../src/gateway.mjs');
  const calls = [];
  const stop = _typingForTest.start('tok', 42, { lang: 'ko' }, (method, body) => calls.push({ method, text: body.text }));
  const n0 = calls.filter((c) => c.method === 'sendChatAction').length;
  assert.equal(n0, 1, '즉시 1회 전송(대기 없이 표시)');
  await new Promise((r) => setTimeout(r, _typingForTest.refreshMs + 400));
  assert.ok(calls.filter((c) => c.method === 'sendChatAction').length >= 2, '주기마다 갱신돼야 표시가 유지된다');
  stop();
  const after = calls.length;
  await new Promise((r) => setTimeout(r, _typingForTest.refreshMs + 400));
  assert.equal(calls.length, after, 'stop 후에는 더 보내지 않는다');
});

/* ── 브리핑 직통 봇 폴백 — pushEvent 행동 게이트(실호출·fetch 가로채기) ──
   실사용 2026-08-27: 회사 게이트웨이 enabled=false + 크루 직통 봇만 페어링된 회사에서 루틴이
   51회 ok로 끝나고도 텔레그램 0회 도착 — 발송이 게이트웨이 단일 경로라 전량 무음 탈락.
   소스 문자열 단언은 이 배선을 못 지킨다(변이 실측: 호출을 `null &&`로 죽여도 초록) —
   여기서는 pushEvent를 실제로 태우고 텔레그램 API 호출 자체를 검증한다. */
test('pushEvent: 게이트웨이 꺼짐 + 직통 봇 페어링 → 루틴 브리핑이 담당 크루 봇으로 1회 발송된다', async () => {
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const { updateAgentBot } = await import('../src/connections.mjs');
  const { createCompany } = await import('../src/workspace.mjs');
  const WS = 'co-brief';
  await createCompany(WS, '브리핑사', 'pepper');
  await updateConnection(WS, 'telegram', { token: 'gw-tok-brief' }); // enabled 기본 false — 신고 상태 그대로
  await updateAgentBot(WS, 'pepper', { token: 'bot-tok-brief' });
  await updateAgentBot(WS, 'pepper', { ownerId: 1, ownerChat: '200' }); // 페어링은 토큰과 별도 호출 — 토큰 변경이 페어링을 초기화하므로
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
    return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await _pushEventForTest({ type: 'routine', wsId: WS, routine: { title: '아침 브리핑', agentSlug: 'pepper' }, ok: true, reply: '결과 본문' });
  } finally {
    globalThis.fetch = origFetch; // 다른 테스트의 실 fetch 계약 복원
  }
  const sends = calls.filter((c) => c.url.includes('/sendMessage'));
  assert.equal(sends.length, 1, '정확히 1회 — 게이트웨이·봇 이중 발송 금지');
  assert.ok(sends[0].url.includes('/botbot-tok-brief/'), '담당 크루의 직통 봇 토큰으로 나간다');
  assert.equal(String(sends[0].body.chat_id), '200', '봇 페어링 채팅으로');
  assert.match(sends[0].body.text, /아침 브리핑/, '루틴 제목이 브리핑 머리에 실린다');
});

test('pushEvent: 게이트웨이 가동 중이면 게이트웨이로만 — 직통 봇 폴백이 겹쳐 쏘지 않는다', async () => {
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const { updateAgentBot } = await import('../src/connections.mjs');
  const { createCompany } = await import('../src/workspace.mjs');
  const WS = 'co-brief-gw'; // 자체 회사 — 앞 테스트와 상태 공유 금지(concurrency가 켜져도 안전, 분리 검수 LOW-3)
  await createCompany(WS, '브리핑사2', 'pepper');
  await updateConnection(WS, 'telegram', { token: 'gw-tok-brief2' });
  await updateConnection(WS, 'telegram', { enabled: true });
  await updateConnection(WS, 'telegram', { chatId: '999' }); // 페어링 완료 상태(폴러 없이 직접 기입)
  await updateAgentBot(WS, 'pepper', { token: 'bot-tok-brief2' });
  await updateAgentBot(WS, 'pepper', { ownerId: 1, ownerChat: '200' }); // 봇도 페어링 — 겹쳐 쏘면 여기로도 나가야 잡힌다
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
    return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await _pushEventForTest({ type: 'routine', wsId: WS, routine: { title: '아침 브리핑', agentSlug: 'pepper' }, ok: true, reply: '결과 본문' });
  } finally {
    globalThis.fetch = origFetch;
  }
  const sends = calls.filter((c) => c.url.includes('/sendMessage'));
  assert.equal(sends.length, 1, '이중 발송 금지');
  assert.ok(sends[0].url.includes('/botgw-tok-brief2/'), '게이트웨이가 살아 있으면 게이트웨이 경로');
  assert.equal(String(sends[0].body.chat_id), '999');
});

/* ── 결재 직통 봇 폴백 — 카드 발송·버튼 콜백·해소 편집의 봇 귀속(행동 게이트) ──
   PR #305는 결재를 폴백에서 의도적으로 제외했다(직통 봇 폴러가 callback_query 미처리 → 죽은 버튼,
   분리 검수 LOW-2). 폴러가 handleApprovalCallback(회사 게이트웨이와 공용)을 갖게 되어 합류 —
   카드가 어느 봇으로 나갔는지(tg.botSlug)까지 결재에 귀속되어야 해소 편집·후속 배달이 같은 봇을 쓴다. */
async function withMockTg(fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { headers: { 'content-type': 'application/json' } });
  };
  try { await fn(calls); } finally { globalThis.fetch = origFetch; }
  return calls;
}

test('결재 폴백: 게이트웨이 꺼짐 + 직통 봇 페어링 → 인라인 버튼 카드가 담당 크루 봇으로 가고 botSlug가 귀속된다', async () => {
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const { updateAgentBot } = await import('../src/connections.mjs');
  const { createCompany } = await import('../src/workspace.mjs');
  const { addApproval, loadApprovals } = await import('../src/approvals.mjs');
  const WS = 'co-appr';
  await createCompany(WS, '결재사', 'pepper');
  await updateConnection(WS, 'telegram', { token: 'gw-tok-appr' }); // enabled 기본 false — 게이트웨이 못 보내는 상태
  await updateAgentBot(WS, 'pepper', { token: 'bot-tok-appr' });
  await updateAgentBot(WS, 'pepper', { ownerId: 1, ownerChat: '200' }); // 토큰 변경이 페어링을 초기화하므로 별도 호출
  const item = await addApproval(WS, { slug: 'pepper', action: '외부 메일 발송', reason: '고객 회신', kind: 'tool' });
  const calls = await withMockTg(async () => {
    await _pushEventForTest({ type: 'approval', wsId: WS, item });
  });
  const sends = calls.filter((c) => c.url.includes('/sendMessage'));
  assert.equal(sends.length, 1, '정확히 1회 — 게이트웨이·봇 이중 발송 금지');
  assert.ok(sends[0].url.includes('/botbot-tok-appr/'), '담당 크루의 직통 봇 토큰으로 나간다');
  assert.equal(String(sends[0].body.chat_id), '200', '봇 페어링 채팅으로');
  assert.equal(sends[0].body.reply_markup.inline_keyboard[0][0].callback_data, `ap:${item.id}:1`, '승인 버튼이 살아 있는 카드');
  const stored = (await loadApprovals(WS)).find((a) => a.id === item.id);
  assert.deepEqual(stored.tg, { chatId: '200', messageId: 77, botSlug: 'pepper' }, '카드가 실린 봇 귀속(botSlug)까지 저장 — 해소 편집·후속 배달이 이 봇을 쓴다');
});

test('결재 콜백(handleApprovalCallback): 페어링 사장의 버튼 클릭만 승인 확정 — 타인은 무시', async () => {
  const { _approvalCallbackForTest } = await import('../src/gateway.mjs');
  const { addApproval, loadApprovals } = await import('../src/approvals.mjs');
  const WS = 'co-appr'; // 위 테스트가 만든 회사 재사용(봇 페어링 상태 동일) — node --test는 파일 내 직렬 실행
  const item = await addApproval(WS, { slug: 'pepper', action: '셸 명령 실행', reason: '빌드', kind: 'tool' });
  const cq = (fromId) => ({ id: 'cb1', data: `ap:${item.id}:1`, from: { id: fromId }, message: { message_id: 78, chat: { id: 200 } } });
  // 타인 클릭 — 아무 호출도, 상태 변화도 없어야 한다(그룹 멤버 결재 확정 차단)
  const denied = await withMockTg(async () => {
    await _approvalCallbackForTest(WS, 'bot-tok-appr', cq(999), { chatId: '200', ownerId: 1 });
  });
  assert.equal(denied.length, 0, '비사장 클릭은 무시(응답 호출 자체가 없다)');
  assert.equal((await loadApprovals(WS)).find((a) => a.id === item.id).status, 'pending');
  // 사장 클릭 — 확정 + 버튼 응답 + 카드를 결과로 교체
  const ok = await withMockTg(async () => {
    await _approvalCallbackForTest(WS, 'bot-tok-appr', cq(1), { chatId: '200', ownerId: 1 });
  });
  assert.equal((await loadApprovals(WS)).find((a) => a.id === item.id).status, 'approved', '사장 클릭으로 승인 확정');
  assert.ok(ok.some((c) => c.url.includes('/botbot-tok-appr/answerCallbackQuery')), '버튼 응답이 그 봇 토큰으로 나간다');
  const edit = ok.find((c) => c.url.includes('/editMessageText'));
  assert.equal(String(edit?.body.chat_id), '200', '원 카드를 결과로 교체(죽은 버튼 제거)');
});

test('직통 봇 폴러: callback_query가 결재 확정까지 이어진다 — 죽은 버튼 해소(PR #305 분리 검수 LOW-2)', async () => {
  const { _startAgentTelegramForTest } = await import('../src/gateway.mjs');
  const { addApproval, loadApprovals } = await import('../src/approvals.mjs');
  const { createCompany } = await import('../src/workspace.mjs');
  const WS = 'co-appr-poll';
  await createCompany(WS, '결재사3', 'pepper');
  const item = await addApproval(WS, { slug: 'pepper', action: '배포 실행', reason: '릴리스', kind: 'tool' });
  const cfg = { token: 'bot-tok-poll', ownerId: 1, ownerChat: '200', botUsername: '' };
  const calls = [];
  let served = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, body: JSON.parse(opts?.body ?? '{}') });
    if (u.includes('/getUpdates')) {
      // 첫 폴에만 버튼 클릭 1건 — 이후 폴은 매달아 둔다(핫루프 방지, AbortSignal.timeout 타이머는 unref라 프로세스를 안 잡는다)
      if (served) return new Promise(() => {});
      served = true;
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, callback_query: { id: 'cb9', data: `ap:${item.id}:1`, from: { id: 1 }, message: { message_id: 5, chat: { id: 200 } } } }] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'content-type': 'application/json' } });
  };
  const stop = _startAgentTelegramForTest(WS, 'pepper', () => cfg);
  try {
    const deadline = Date.now() + 8000; // 고정 sleep은 CI 부하에서 플레이크 — 조건 충족 시 즉시 통과
    while (Date.now() < deadline) {
      if ((await loadApprovals(WS)).find((a) => a.id === item.id)?.status === 'approved') break;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    stop();
    globalThis.fetch = origFetch;
  }
  assert.equal((await loadApprovals(WS)).find((a) => a.id === item.id).status, 'approved', '폴러가 받은 버튼 클릭으로 결재가 확정된다');
  assert.ok(calls.some((c) => c.url.includes('/botbot-tok-poll/answerCallbackQuery')), '버튼 응답도 그 봇으로 나간다');
});

test('결재 해소 편집: botSlug 귀속 카드는 그 봇 토큰으로 편집 — 회사 게이트웨이 토큰이 아니다', async () => {
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const WS = 'co-appr';
  const item = { id: 'ap-zzz', slug: 'pepper', action: '외부 메일 발송', status: 'approved', tg: { chatId: '200', messageId: 77, botSlug: 'pepper' } };
  const calls = await withMockTg(async () => {
    await _pushEventForTest({ type: 'approval_resolved', wsId: WS, item });
  });
  const edit = calls.find((c) => c.url.includes('/editMessageText'));
  assert.ok(edit, '해소 시 카드가 편집된다');
  assert.ok(edit.url.includes('/botbot-tok-appr/'), '카드가 실린 직통 봇 토큰으로 — 게이트웨이 토큰이면 그 카드를 못 찾는다');
  assert.equal(String(edit.body.chat_id), '200');
});
