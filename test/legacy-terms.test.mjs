// 용어 변경(2026-10-05 크루→에이전트, 사장→사용자) 하위 호환 — 이미 저장된 기록·사용자 습관에 남은 옛 표지를 지금처럼 읽는다.
// 계획: artifacts/rc-0195/terminology-plan.md 3절(M1~M6, M10), 경우 표 A1·A4·D3.
// 옛 값은 테스트 안에 **글자 그대로** 적는다 — src/legacy-terms.mjs의 목록을 돌려 만든 입력이면, 목록에서 하나를 빼도 테스트가 같이 줄어 초록이 된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-legacy-terms-'));
Object.assign(process.env, { ARGO_ROOT: root, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off' });

const { viaSummary } = await import('../app/c/[ws]/crew/[slug]/via-summary.mjs');
const { lastTurnByRunner } = await import('../app/runner-usable.mjs');
const { digestFailures } = await import('../src/failure-digest.mjs');
const { parseApproval, parseMail, MAIL_CC, mailHead, approvalMsg, APPROVAL_TAG } = await import('../src/inbound-marks.mjs');
const LT = await import('../src/legacy-terms.mjs');
const { isStatusCommand } = await import('../src/gateway/protocol.mjs');
const { nameplateOwner } = await import('../app/lib/nameplate-owner.mjs');
const { inboundCard } = await import('../app/c/[ws]/crew/[slug]/inbound-card.mjs');
const { parseInput } = await import('../src/cli/ui.mjs');

// ── M1 회의실 화자 — 옛 회의실 프롬프트(배달 기록에 저장됨)의 '사장: ' 줄 ──
const OLD_ROOM_PROMPT = `지금 회의실에 있다 — 사장과 동료 크루가 함께 보는 방이다.

## 회의 대화 (최근)
사장: 첫 안건
페퍼: 의견
사장: @슈리 BM 어떻게 잡을까?

## 지시
사장의 마지막 발언에 "슈리"로서 답하라.`;

test('M1 옛 회의실 기록 — "사장: " 줄을 사용자 발언으로 읽는다(카드 요약)', () => {
  assert.equal(viaSummary('room', OLD_ROOM_PROMPT), '@슈리 BM 어떻게 잡을까?');
  assert.equal(inboundCard({ who: 'user', via: 'room', text: OLD_ROOM_PROMPT }).body, '@슈리 BM 어떻게 잡을까?');
});

// ── M2 중단 — 옛 이벤트의 '사장 지시로 중단'(aborted 필드가 없던 시절 포함) ──
test('M2 옛 중단 문자열 — 러너 상태·실패 다이제스트가 중단으로 본다(aborted 필드 없어도)', () => {
  const by = lastTurnByRunner([{ type: 'turn', runner: 'kimi', ok: false, error: '사장 지시로 중단' }]);
  assert.deepEqual(by.kimi, { ok: false, aborted: true });
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const ev = [1, 2, 3].map((i) => ({ type: 'turn', ok: false, runner: 'grok', slug: 'c1', error: '사장 지시로 중단', ts: new Date(T0 - i * 1000).toISOString() }));
  assert.deepEqual(digestFailures(ev, { now: T0, minCount: 1 }), [], '옛 중단 문자열이 실패로 묶였다');
});

// ── M3 결재 꼬리표 — 옛 결재 후속 기록의 '(사장 결재)' ──
test('M3 옛 결재 꼬리표 — "(사장 결재)"를 결재 결과로 읽고 지시문 꼬리를 뗀다', () => {
  const old = '(사장 결재) 요청한 "메일 발송" 이(가) 승인되었다. 이제 실행하고 결과를 보고하라.';
  assert.deepEqual(parseApproval(old), { by: 'owner', body: '요청한 "메일 발송" 이(가) 승인되었다.' });
  assert.deepEqual(inboundCard({ who: 'user', text: old }), { kind: 'approval', body: '요청한 "메일 발송" 이(가) 승인되었다.' });
  assert.deepEqual(parseApproval('(관리자 결재) 조직 문서 제안 "규칙" 이(가) 거절되었다. 반영되지 않았다 — 대안이 있으면 한두 줄로 정리하라.'),
    { by: 'admin', body: '조직 문서 제안 "규칙" 이(가) 거절되었다. 반영되지 않았다' });
});

// ── M4 쪽지 머리말 — 옛 쪽지 기록(회의실에서 사용자가 참조로 돌린 것) ko·en × 참조 여부 ──
test('M4 옛 쪽지 머리말 — "(사장이 회의실에서 공유…)"·"(From the captain — …)"를 회의실 공유 쪽지로 읽는다', () => {
  const cases = [
    ['(사장이 회의실에서 공유) 회의 결론 공유', false],
    [`(사장이 회의실에서 공유${MAIL_CC.ko}) 참고만`, true],
    ['(From the captain — shared from the meeting room) Meeting notes', false],
    [`(From the captain — shared from the meeting room${MAIL_CC.en}) FYI`, true],
  ];
  for (const [text, cc] of cases) {
    const p = parseMail(text);
    assert.ok(p, `못 읽음: ${text}`);
    assert.equal(p.captain, true, text); assert.equal(p.cc, cc, text); assert.equal(p.fromName, '', text);
    assert.equal(p.body, text.slice(text.indexOf(') ') + 2), text);
    const card = inboundCard({ who: 'user', via: 'crewmail', text });
    assert.equal(card.captain, true, text); assert.equal(card.body, p.body, text);
  }
});

// ── M5 텔레그램·슬랙 현황 명령 — 실제 잡 핸들러(큐 워커가 부르는 것)로 돌린다. 텔레그램 API만 가로챈다(모델 호출 없음) ──
const tgSent = [];
const fakeTelegram = (orig) => async (url, opts) => {
  if (!String(url).includes('api.telegram.org')) return orig(url, opts);
  tgSent.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
  return new Response('{"ok":true,"result":{}}', { headers: { 'content-type': 'application/json' } });
};
const { createCompany, paths } = await import('../src/workspace.mjs');
const { _tgHandlersForTest: H } = await import('../src/gateway.mjs');
const WS = 'legacy-terms';
await createCompany(WS, '용어사', 'captain', null, 'ko');
await mkdir(paths(WS).agents, { recursive: true });
await writeFile(join(paths(WS).agents, 'nova.md'), '---\nname: 노바\nrole: 리서치\nrunner: claude\n---\n검증용.\n');
async function companyBotReply(text) {
  tgSent.length = 0;
  const orig = globalThis.fetch; globalThis.fetch = fakeTelegram(orig); // 테스트 안에서 걸고 푼다(파일 끝 after는 앞 테스트가 끝난 틈에 먼저 돈다)
  try {
    await H.makeTgGatewayHandler(WS, () => ({ token: 'bot-co', chatId: '77', ownerId: 1 }))({ text, atts: [], ctx: { chatId: 77, chatType: 'private' } });
  } finally { globalThis.fetch = orig; }
  return tgSent.filter((c) => c.url.endsWith('/sendMessage')).map((c) => c.body.text).join('\n');
}

test('M5 옛 현황 명령 — "크루"·"crew"·"/crew"·"현황"·"status"는 모델 없이 현황으로 답한다', async () => {
  for (const cmd of ['크루', 'crew', '/crew', 'CREW', ' 크루 ', '현황', '/현황', 'status', '/status']) {
    const reply = await companyBotReply(cmd);
    assert.match(reply, /노바 \(@nova\) — 리서치/, `"${cmd}"가 현황으로 답하지 않았다: ${reply}`);
  }
});

// ── M6 CLI — 옛 명령 /crew ──
test('M6 CLI 옛 명령 — "/crew 이름"은 대화 상대 바꾸기 명령이다', () => {
  const p = parseInput('/crew pepper');
  assert.equal(p.kind, 'command'); assert.equal(p.arg, 'pepper');
  assert.equal(parseInput('/crew').kind, 'command');
});

// ── 새 기록 — 쓰는 쪽이 새 낱말을 쓰고, 같은 파서가 읽는다 ──
test('새 표지 — 쓰는 함수의 새 낱말을 같은 파서가 읽는다(회의 화자·중단·결재·쪽지)', () => {
  const room = '지금 회의실에 있다.\n\n## 회의 대화 (최근)\n사용자: 첫 안건\n페퍼: 의견\n사용자: @슈리 정리해 줘\n\n## 지시\n답하라.';
  assert.equal(viaSummary('room', room), '@슈리 정리해 줘');
  assert.equal(viaSummary('room', '## 회의 대화 (최근)\n사용자: 새 기록의 사용자 발언\n사장: 이름이 사장인 에이전트의 발언'), '새 기록의 사용자 발언', '새 화자가 있으면 옛 화자 줄은 사용자 발언으로 집지 않는다');
  assert.equal(LT.USER_ABORT_ERROR, '사용자 지시로 중단');
  assert.deepEqual(lastTurnByRunner([{ type: 'turn', runner: 'a', ok: false, error: '사용자 지시로 중단' }]).a, { ok: false, aborted: true }, '새 문자열(필드 없이도)');
  assert.deepEqual(lastTurnByRunner([{ type: 'turn', runner: 'a', ok: false, aborted: true, error: 'x' }]).a, { ok: false, aborted: true }, '필드');
  assert.deepEqual(lastTurnByRunner([{ type: 'turn', runner: 'a', ok: false, error: 'API Error: 500' }]).a, { ok: false, aborted: false }, '실패는 중단이 아니다');
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  assert.deepEqual(digestFailures([1, 2].map((i) => ({ type: 'turn', ok: false, runner: 'g', error: '사용자 지시로 중단', ts: new Date(T0 - i).toISOString() })), { now: T0, minCount: 1 }), []);
  assert.equal(APPROVAL_TAG.owner, '(사용자 결재)');
  const ap = approvalMsg('owner', '요청한 "x" 이(가) 승인되었다.', 'approved');
  assert.ok(ap.startsWith('(사용자 결재) '), ap);
  assert.deepEqual(parseApproval(ap), { by: 'owner', body: '요청한 "x" 이(가) 승인되었다.' });
  for (const lang of ['ko', 'en']) for (const cc of [false, true]) {
    const head = mailHead(lang, { cc, captain: true });
    assert.doesNotMatch(head, /사장|captain/i, head);
    assert.deepEqual(parseMail(`${head}본문`), { captain: true, cc, fromName: '', body: '본문' }, head);
  }
  assert.equal(mailHead('ko', { captain: true }), '(사용자가 회의실에서 공유) ');
  assert.equal(mailHead('en', { captain: true }), '(From the user — shared from the meeting room) ');
});

// ── 옛 값 목록 자체 — 하나라도 빠지면 빨강(위 행동 테스트와 같이 잠근다) ──
test('옛 값 목록은 줄지 않는다(지우지 말고 더한다)', () => {
  assert.deepEqual([...LT.OLD_ROOM_USER_SPEAKERS], ['사장']);
  assert.deepEqual([...LT.OLD_USER_ABORT_ERRORS], ['사장 지시로 중단']);
  assert.deepEqual([...LT.OLD_APPROVAL_TAGS.owner], ['(사장 결재)']);
  assert.deepEqual(LT.OLD_MAIL_SHARED_HEADS.ko.map((h) => h('')), ['(사장이 회의실에서 공유) ']);
  assert.deepEqual(LT.OLD_MAIL_SHARED_HEADS.en.map((h) => h('')), ['(From the captain — shared from the meeting room) ']);
  assert.deepEqual([...LT.OLD_STATUS_COMMAND_WORDS], ['크루', 'crew']);
  assert.deepEqual({ ...LT.OLD_CLI_COMMANDS }, { crew: 'agent' });
  assert.deepEqual([...LT.OWNER_PLACEHOLDERS], ['captain']);
  assert.ok(Object.isFrozen(LT.OLD_USER_ABORT_ERRORS) && Object.isFrozen(LT.OLD_APPROVAL_TAGS.owner), '실행 중에 목록을 바꾸지 못한다');
});

// ── M5 새 낱말 — 실제 잡 핸들러 + 판정 함수 경계 ──
test('M5 새 현황 명령 — "에이전트"·"agent"·"agents"·"/에이전트"도 현황으로 답한다', async () => {
  for (const cmd of ['에이전트', '/에이전트', 'agent', 'Agents', '/agents']) {
    const reply = await companyBotReply(cmd);
    assert.match(reply, /노바 \(@nova\) — 리서치/, `"${cmd}"가 현황으로 답하지 않았다: ${reply}`);
  }
});
test('M5 현황 명령 판정 경계 — 한 낱말만, 문장·다른 낱말은 지시로 간다', () => {
  for (const t of ['크루', 'crew', '/crew', '현황', 'status', '에이전트', 'agent', 'agents', ' /Agents ']) assert.equal(isStatusCommand(t), true, t);
  for (const t of ['에이전트 현황 알려줘', '크루들', 'crews', 'agentx', '@노바 status', '', null, '//crew', 'crew status']) assert.equal(isStatusCommand(t), false, String(t));
});

// ── M10 명패 — 저장 값은 그대로, 표시만 ──
test('D3 명패 사용자 줄 — 기본값 captain·빈 값은 이름(있으면) 또는 "—", 사용자가 적은 이름·회사 노드는 그대로', () => {
  assert.equal(nameplateOwner('captain'), '—');
  assert.equal(nameplateOwner(' captain '), '—');
  assert.equal(nameplateOwner(''), '—');
  assert.equal(nameplateOwner(undefined), '—');
  assert.equal(nameplateOwner('captain', '유건'), '유건');
  assert.equal(nameplateOwner(null, '  유건  '), '유건');
  assert.equal(nameplateOwner('captain', '  '), '—');
  assert.equal(nameplateOwner('유건'), '유건');
  assert.equal(nameplateOwner('유건', '다른 이름'), '유건', '사용자가 직접 적은 이름이 먼저');
  assert.equal(nameplateOwner('회사 노드'), '회사 노드');
});
test('D3 저장 값은 그대로 — 새 회사의 company.owner는 여전히 "captain"(표시 함수만 바뀐다)', async () => {
  const { loadCompany } = await import('../src/workspace.mjs');
  assert.equal((await loadCompany(WS)).owner, 'captain');
});
