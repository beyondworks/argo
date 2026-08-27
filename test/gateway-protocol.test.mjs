// 프로토콜 순수 판정 단위 — 결재 파서(텍스트·콜백)·페어링 코드·잘림·문구 정돈·백오프.
// classifySlackMessage는 gateway.test.mjs가 이미 잠근다(중복 금지). 파일·네트워크·타이머 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseApprovalText, parseApprovalCallback, pairCodeMatches, clip, tidy, pollBackoffMs, pick,
  classifySlackMessage, telegramBriefingDest,
} from '../src/gateway/protocol.mjs';

/* ── 텍스트 결재 회신 파서 — 슬랙·텔레그램 공용 앵커 ── */
test('parseApprovalText: "승인/거절 ap-xxx" — verb·approve·id 추출', () => {
  assert.deepEqual(parseApprovalText('승인 ap-abc123'), { verb: '승인', approve: true, id: 'ap-abc123' });
  assert.deepEqual(parseApprovalText('거절 ap-x9'), { verb: '거절', approve: false, id: 'ap-x9' });
  assert.equal(parseApprovalText('승인 ap-abc 예산 범위 내').id, 'ap-abc', '뒤따르는 사유 텍스트 허용(비앵커)');
  assert.equal(parseApprovalText('승인 ap-abc.def').id, 'ap-abc', 'id는 [a-z0-9]에서 멈춘다');
});

test('parseApprovalText: 형식 밖은 null — 일반 지시가 결재로 오인되지 않는다', () => {
  assert.equal(parseApprovalText(' 승인 ap-abc'), null, '앞 공백 = 앵커(^) 불일치');
  assert.equal(parseApprovalText('승인ap-abc'), null, '공백 없음');
  assert.equal(parseApprovalText('승인 AP-ABC'), null, '대문자 id는 발급 형식이 아니다');
  assert.equal(parseApprovalText('결재 승인 ap-abc'), null, '동사가 문두가 아니면 일반 지시');
  assert.equal(parseApprovalText(''), null);
  assert.equal(parseApprovalText(null), null, 'null 안전');
});

/* ── 결재 인라인 버튼 콜백 파서 ── */
test('parseApprovalCallback: "ap:<id>:<0|1>" — id·approve 추출', () => {
  assert.deepEqual(parseApprovalCallback('ap:ap-abc123:1'), { id: 'ap-abc123', approve: true });
  assert.deepEqual(parseApprovalCallback('ap:ap-abc123:0'), { id: 'ap-abc123', approve: false });
});

test('parseApprovalCallback: 형식 밖은 null(무시) — 위조·구버전 콜백이 결재를 건드리지 못한다', () => {
  assert.equal(parseApprovalCallback('ap:ap-abc:2'), null, '플래그는 0|1만');
  assert.equal(parseApprovalCallback('xp:ap-abc:1'), null, '접두 불일치');
  assert.equal(parseApprovalCallback('ap:ap-abc:1:extra'), null, '끝 앵커($) — 꼬리 붙은 데이터 거부');
  assert.equal(parseApprovalCallback('ap:AP-ABC:1'), null, '대문자 id 거부');
  assert.equal(parseApprovalCallback('ap:abc:1'), null, 'ap- 접두 없는 id 거부');
  assert.equal(parseApprovalCallback(undefined), null, 'undefined 안전');
});

/* ── 페어링 코드 판정 — TOFU 차단의 심장 ── */
test('pairCodeMatches: trim·대문자 정규화 후 전등호', () => {
  assert.equal(pairCodeMatches('AB2CD3', 'ab2cd3'), true, '소문자 입력 허용');
  assert.equal(pairCodeMatches('AB2CD3', '  AB2CD3\n'), true, '메신저 앞뒤 공백·개행 허용');
  assert.equal(pairCodeMatches('AB2CD3', 'AB2CD'), false, '부분 일치 거부');
  assert.equal(pairCodeMatches('AB2CD3', 'AB2CD3 XY'), false, '꼬리 텍스트 거부(전등호)');
});

test('pairCodeMatches: 코드 미발급이면 항상 불일치 — 빈 코드로 소유권을 못 가져간다', () => {
  assert.equal(pairCodeMatches('', ''), false, '빈 코드 = 빈 입력도 거부');
  assert.equal(pairCodeMatches(null, 'ANYTHING'), false);
  assert.equal(pairCodeMatches('AB2CD3', null), false, 'null 텍스트 안전');
  assert.equal(pairCodeMatches('AB2CD3', undefined), false);
});

/* ── 발신 잘림 — 텔레그램 4096 제한 대비 ── */
test('clip: 3800자 이하 원문 유지, 초과 시 절단 + 데크 안내 꼬리', () => {
  const short = 'x'.repeat(3800);
  assert.equal(clip(short), short, '경계값(3800)은 그대로');
  const long = 'y'.repeat(3801);
  const out = clip(long);
  assert.ok(out.startsWith('y'.repeat(3800)), '앞 3800자 보존');
  assert.ok(out.endsWith('…(전체 내용은 Argo 데크에서)'), '전체 내용 안내 문구 고정');
});

/* ── 결재 문구 정돈 — 내용 보존, 모양만 ── */
test('tidy: 줄머리 공백·과잉 개행 정리, 코드펜스 안은 원문 보존', () => {
  assert.equal(tidy('  들여쓴 액션\n\n\n\n다음 줄  '), '들여쓴 액션\n\n다음 줄', '줄머리/줄꼬리 공백 제거 + 3연속 개행 → 2');
  const fenced = '요청:\n```\n  indent-매터\n```';
  assert.equal(tidy(fenced), fenced, '코드펜스 내부 들여쓰기는 내용이다 — 손대지 않는다');
  assert.equal(tidy(null), '', 'null 안전');
});

/* ── 폴 오류 지수 백오프 — Conflict 배틀 방지 ── */
test('pollBackoffMs: 5s에서 2배씩, 60s 상한', () => {
  assert.equal(pollBackoffMs(1), 5000);
  assert.equal(pollBackoffMs(2), 10_000);
  assert.equal(pollBackoffMs(3), 20_000);
  assert.equal(pollBackoffMs(4), 40_000);
  assert.equal(pollBackoffMs(5), 60_000, '상한 도달');
  assert.equal(pollBackoffMs(100), 60_000, '상한 유지 — 영원히 커지지 않는다');
  assert.equal(pollBackoffMs(0), 5000, '방어적 하한(streak 0도 기본 대기)');
});

/* ── 언어 선택 ── */
test('pick: en만 영어, 그 외(ko·미지정·이상값)는 전부 한국어 — 기존 회사 동작 그대로', () => {
  assert.equal(pick('한', 'en', 'en'), 'en');
  assert.equal(pick('한', 'en', 'ko'), '한');
  assert.equal(pick('한', 'en', undefined), '한');
  assert.equal(pick('한', 'en', 'fr'), '한', '미지원 코드는 ko 폴백');
});

// 호출부 재배선을 실제로 태우는 테스트(분리 검수 L4) — 파서 단독이 아니라 classifySlackMessage가
// parseApprovalText 위임 후 {kind, approve, id}로 올바르게 매핑하는지. 사장 판정과의 결합도 함께.
test('classifySlackMessage: 사장의 승인/거절 텍스트가 approval로 매핑된다(위임 호출부)', () => {
  const cfg = { ownerId: 'U1', botUserId: 'B1' };
  assert.deepEqual(classifySlackMessage(cfg, { user: 'U1', text: '승인 ap-abc12' }), { kind: 'approval', approve: true, id: 'ap-abc12' });
  assert.deepEqual(classifySlackMessage(cfg, { user: 'U1', text: '거절 ap-xyz99' }), { kind: 'approval', approve: false, id: 'ap-xyz99' });
  assert.equal(classifySlackMessage(cfg, { user: 'U2', text: '승인 ap-abc12' }).kind, 'skip', '사장 외 결재 무시가 위임보다 선행');
  assert.equal(classifySlackMessage(cfg, { user: 'U1', text: '승인해줘 그냥' }).kind, 'turn', '앵커 미일치는 일반 턴');
});

/* ── 브리핑 텔레그램 목적지 — 게이트웨이 우선 + 크루 직통 봇 폴백 ──
   실사용 2026-08-27: 회사 게이트웨이 enabled=false + 크루 직통 봇만 페어링된 회사에서
   루틴이 51회 ok로 끝나고도 텔레그램 0회 도착("텔레그램으로 보내줘" 루틴 전부 헛돎).
   브리핑 발송이 게이트웨이 단일 경로라 직통 봇으로 가는 길 자체가 없었다 — 그 갭을 잠근다. */
test('telegramBriefingDest: 게이트웨이 가동 중이면 게이트웨이로 — 폴백 없음(이중 발송 금지)', () => {
  const tg = { enabled: true, token: 'gw-tok', chatId: '100', agents: { pepper: { token: 'bot-tok', ownerChat: '200' } } };
  assert.deepEqual(telegramBriefingDest(tg, 'routine', 'pepper'), { token: 'gw-tok', chatId: '100' });
});

test('telegramBriefingDest: 게이트웨이 꺼짐 + 직통 봇 페어링 → 담당 크루 봇으로 폴백(신고 재현)', () => {
  const tg = { enabled: false, token: 'gw-tok', chatId: '100', mutedEvents: [], agents: { pepper: { token: 'bot-tok', ownerChat: 200 } } };
  assert.deepEqual(telegramBriefingDest(tg, 'routine', 'pepper'), { token: 'bot-tok', chatId: '200' }, 'chatId는 문자열 정규화');
  assert.deepEqual(telegramBriefingDest(tg, 'job', 'pepper'), { token: 'bot-tok', chatId: '200' });
  assert.deepEqual(telegramBriefingDest(tg, 'crewmail', 'pepper'), { token: 'bot-tok', chatId: '200' });
});

test('telegramBriefingDest: 게이트웨이 미연결(토큰·chatId 없음)에서도 직통 봇 폴백이 동작한다', () => {
  const tg = { enabled: false, token: '', chatId: null, agents: { pepper: { token: 'bot-tok', ownerChat: '200' } } };
  assert.deepEqual(telegramBriefingDest(tg, 'routine', 'pepper'), { token: 'bot-tok', chatId: '200' });
});

test('telegramBriefingDest: 음소거(mutedEvents)는 폴백에서도 존중 — 끈 종류는 어느 경로로도 안 간다', () => {
  const tg = { enabled: false, mutedEvents: ['routine'], agents: { pepper: { token: 'bot-tok', ownerChat: '200' } } };
  assert.equal(telegramBriefingDest(tg, 'routine', 'pepper'), null, '끈 종류는 직통 봇으로도 안 보낸다');
  assert.deepEqual(telegramBriefingDest(tg, 'job', 'pepper'), { token: 'bot-tok', chatId: '200' }, '다른 종류는 그대로');
});

test('telegramBriefingDest: 보낼 곳 없음 → null — 미페어링 봇·없는 크루·결재는 폴백 대상이 아니다', () => {
  const unpaired = { enabled: false, agents: { pepper: { token: 'bot-tok', ownerChat: null } } };
  assert.equal(telegramBriefingDest(unpaired, 'routine', 'pepper'), null, '페어링 전 봇(ownerChat 없음)으로는 못 보낸다');
  assert.equal(telegramBriefingDest({ enabled: false, agents: {} }, 'routine', 'pepper'), null, '담당 크루의 봇이 없다');
  assert.equal(telegramBriefingDest({ enabled: false, agents: { pepper: { token: 'bot-tok', ownerChat: '200' } } }, 'routine', undefined), null, 'slug 없음(방어)');
  // 결재는 브리핑이 아니다 — 인라인 버튼 콜백을 직통 봇 폴러가 처리하지 않아 죽은 버튼이 된다
  const tg = { enabled: true, token: 'gw-tok', chatId: '100', agents: { pepper: { token: 'bot-tok', ownerChat: '200' } } };
  assert.equal(telegramBriefingDest(tg, 'approval', 'pepper'), null, 'approval은 게이트웨이 전용 분기가 담당');
  assert.equal(telegramBriefingDest(null, 'routine', 'pepper'), null, 'null 안전');
});
