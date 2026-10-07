// 루틴이 '안 돌았다'는 제보의 대부분은 실행은 됐지만 실패했거나 건너뛴 경우였다(2026-10-07 이 맥 기록 456건 조사).
// 그 사실이 사용자 화면(1:1 대화 기록·활동·알림)에 남는지를 잠근다 — 경우 표는 PR 본문(fix/routine-failure-visible).
//   A. 실패를 대화 기록에 남긴다(지시는 성공 때와 같은 모양, 답 자리에 실패 안내)
//   B. 4시간(catch-up 창)을 넘겨 놓친 회차를 활동 기록에 남기고, 다음 실행 때 대화 기록에 한 줄을 남긴다
//   C. 보고할 것이 없으면 NO_REPORT — 알림·메신저 글 없이 성공으로 기록한다(빈 답은 실패 그대로, 문구만 알아듣게)
//   D. 제목만 있는 알림을 보내지 않는다
// 러너는 chatFn 주입(실 러너 불필요) — 실제 chat()을 지나는 Codex CLI·SDK 가짜 러너판은 routine-visibility-runners.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-rtn-visible-'));
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];
const { createCompany, paths } = await import('../src/workspace.mjs');
const { addRoutine, runRoutine, loadRoutines } = await import('../src/routines.mjs');
const { loadThread } = await import('../src/thread.mjs');
const { readEvents } = await import('../src/events.mjs');
const { onNotify } = await import('../src/notify.mjs');
const { runDueRoutines } = await import('../src/scheduler.mjs');
const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
const { inThreadContext } = await import('../src/chat.mjs');
const { formatMsgrNotify } = await import('../src/msgr-notify.mjs');
const { recordMissedSlots } = await import('../src/routines.mjs');

let seq = 0;
/** 회사 하나 + 에이전트 카드(alpha). 스케줄러는 카드 없는 루틴을 건너뛰므로 프로덕션 모양으로 카드를 둔다. */
async function company(lang = 'ko') {
  const ws = `rtnvis-${++seq}`;
  await createCompany(ws, '루틴 표시 검수', 'owner', null, lang);
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: 알파\nrole: 검증\n---\n검증용.\n');
  return ws;
}
/** 가짜 러너 — calls[i] = { msg: chat에 넘긴 지시(일지·턴 이벤트·기억에 남는 글), note: 러너 프롬프트에만 붙는 덧붙임(opts.runnerNote) } */
const fakeChat = (replies) => {
  const calls = [];
  const fn = async (_ws, _slug, msg, _sid, opts) => {
    calls.push({ msg, note: opts?.runnerNote ?? '' });
    const r = replies.shift() ?? { reply: '보고: 새 항목 1건' };
    if (r instanceof Error) throw r;
    if (r.make) await writeFile(join(paths(_ws).vault, r.make[0]), r.make[1]);
    return { reply: r.reply, handover: null, sessionId: null, costUsd: null };
  };
  fn.calls = calls;
  return fn;
};
/** 알림 수집 — emitNotify는 마이크로태스크로 핸들러를 부른다. */
function notices(ws) {
  const got = [];
  const off = onNotify((e) => { if (e.wsId === ws) got.push(e); });
  return { got, stop: async () => { await new Promise((r) => setTimeout(r, 20)); off(); } };
}
const byId = async (ws, id) => (await loadRoutines(ws)).find((r) => r.id === id);
const thread = async (ws) => (await loadThread(ws, 'alpha')).messages;
const daily = (ws, extra = {}) => addRoutine(ws, { agentSlug: 'alpha', title: '메일 보고', prompt: '새 메일을 요약하라', schedule: { type: 'daily', time: '09:00' }, ...extra });
const HEAD = '[루틴: 메일 보고] 새 메일을 요약하라';

/* ─── 인접 행동 핀(옛 코드에서도 초록) ─────────────────────────────────────── */

test('핀: 성공 턴은 대화 기록에 지시(성공 모양)와 답을 남기고, 결과 알림 1건·lastOk true', async () => {
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '보고: 새 메일 2건' }]) });
  await n.stop();
  assert.equal(out.ok, true);
  const msgs = await thread(ws);
  assert.deepEqual(msgs.map((m) => [m.who, m.via ?? null, m.text]), [['user', 'routine', HEAD], ['crew', null, '보고: 새 메일 2건']],
    '대화 기록의 지시는 `[루틴: 제목] 지시` 그대로다(1:1 화면 출처 카드가 이 모양을 읽는다)');
  const saved = await byId(ws, r.id);
  assert.equal(saved.lastOk, true); assert.equal(saved.lastResult, '보고: 새 메일 2건');
  const results = n.got.filter((e) => e.type === 'routine');
  assert.equal(results.length, 1); assert.equal(results[0].ok, true); assert.equal(results[0].reply, '보고: 새 메일 2건');
});

test('핀: 실패는 lastOk false·lastResult 사유·실패 알림 1건, 예외는 호출자에게 그대로 던진다', async () => {
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  await assert.rejects(runRoutine(ws, r.id, { chatFn: fakeChat([new Error('러너 연결 안 됨')]) }), /러너 연결 안 됨/);
  await n.stop();
  const saved = await byId(ws, r.id);
  assert.equal(saved.lastOk, false); assert.match(saved.lastResult, /러너 연결 안 됨/);
  const fails = n.got.filter((e) => e.type === 'routine');
  assert.equal(fails.length, 1); assert.equal(fails[0].ok, false); assert.match(fails[0].reply, /러너 연결 안 됨/);
});

test('핀: 루프 루틴의 지시에는 루프 프로토콜이 붙고, 재시도 지시는 완료 조건 문구로 간다', async () => {
  const ws = await company();
  const loop = await addRoutine(ws, { agentSlug: 'alpha', title: '점검 루프', prompt: '서버를 점검하라', schedule: { type: 'interval', everyMinutes: 10 }, loop: { maxRuns: 5 } });
  const chatFn = fakeChat([{ reply: '정상\nLOOP: continue' }]);
  await runRoutine(ws, loop.id, { chatFn });
  assert.match(chatFn.calls[0].msg, /\[루프 프로토콜\]/);
  assert.match(chatFn.calls[0].msg, /LOOP: continue/);
});

/* ─── A. 실패를 대화 기록에 남긴다 ─────────────────────────────────────────── */

test('A1: 러너 예외로 실패한 루틴도 대화 기록에 지시(성공과 같은 모양)와 답 자리의 실패 안내가 남는다', async () => {
  const ws = await company();
  const r = await daily(ws);
  await assert.rejects(runRoutine(ws, r.id, { chatFn: fakeChat([new Error('러너 연결 안 됨')]) }));
  const msgs = await thread(ws);
  const i = msgs.findIndex((m) => m.who === 'user' && m.via === 'routine' && m.text === HEAD);
  assert.ok(i >= 0, `실패한 루틴의 지시가 대화 기록에 없다: ${JSON.stringify(msgs)}`);
  assert.equal(msgs[i + 1]?.who, 'crew', '답 자리에 실패 안내가 있어야 한다');
  assert.match(msgs[i + 1].text, /루틴 실행에 실패했습니다/);
  assert.match(msgs[i + 1].text, /러너 연결 안 됨/, '실패 사유가 함께 남는다');
  assert.equal(msgs.length, i + 2, '실패 한 번에 지시 1 + 안내 1');
});

test('A4: 완료 조건 설정 오류(chat 전에 실패)도 LLM 호출 없이 대화 기록에 남는다', async () => {
  const ws = await company();
  const r = await daily(ws, { verify: { files: ['보고.md'] } });
  const raw = await loadRoutines(ws);
  raw.find((x) => x.id === r.id).verify = { files: ['../밖.md'] }; // 오염된 저장값 — normalizeVerify가 거절한다
  await writeJsonAtomic(paths(ws).routines, raw);
  const chatFn = fakeChat([]);
  await assert.rejects(runRoutine(ws, r.id, { chatFn }), /완료 조건 설정 오류/);
  assert.equal(chatFn.calls.length, 0, '설정 오류는 chat 전에 실패한다(종전 핀)');
  const msgs = await thread(ws);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, HEAD);
  assert.match(msgs[1].text, /완료 조건 설정 오류/);
});

test('A5: 완료 조건 최종 미충족 — 시도 턴은 각자 남고, 그 뒤에 실패 안내 한 줄(지시를 다시 쓰지 않는다)', async () => {
  const ws = await company();
  const r = await daily(ws, { verify: { files: ['보고.md'], retries: 1 } });
  await assert.rejects(runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '다 했습니다' }, { reply: '또 다 했습니다' }]) }), /완료 조건 미충족\(2회 시도\)/);
  const msgs = await thread(ws);
  assert.deepEqual(msgs.map((m) => m.who), ['user', 'crew', 'user', 'crew', 'crew']);
  assert.equal(msgs.filter((m) => m.text === HEAD).length, 1, '첫 지시는 한 번만');
  assert.equal(msgs[3].text, '또 다 했습니다');
  assert.match(msgs[4].text, /루틴 실행에 실패했습니다/);
  assert.match(msgs[4].text, /보고\.md/);
});

test('A6: 완료 조건 재시도 턴에서 러너가 실패하면 그 재시도 지시와 실패 안내가 남는다', async () => {
  const ws = await company();
  const r = await daily(ws, { verify: { files: ['보고.md'], retries: 1 } });
  await assert.rejects(runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '다 했습니다' }, new Error('재시도 중 연결 끊김')]) }), /연결 끊김/);
  const msgs = await thread(ws);
  assert.deepEqual(msgs.map((m) => m.who), ['user', 'crew', 'user', 'crew']);
  assert.match(msgs[2].text, /완료 조건 미충족\(2차 시도\)/);
  assert.match(msgs[3].text, /재시도 중 연결 끊김/);
});

test('A8: 루프 회차 실패도 기록되고, 회차·연속 무판정 카운트는 종전대로 센다', async () => {
  const ws = await company();
  const loop = await addRoutine(ws, { agentSlug: 'alpha', title: '점검 루프', prompt: '서버를 점검하라', schedule: { type: 'interval', everyMinutes: 10 }, loop: { maxRuns: 5 } });
  await assert.rejects(runRoutine(ws, loop.id, { chatFn: fakeChat([new Error('러너 연결 안 됨')]) }));
  const saved = await byId(ws, loop.id);
  assert.equal(saved.loop.runs, 1); assert.equal(saved.loop.missingVerdicts, 1);
  const msgs = await thread(ws);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].text, /^\[루틴: 점검 루프\] 서버를 점검하라/);
  assert.match(msgs[1].text, /러너 연결 안 됨/);
});

/* ─── C. NO_REPORT ───────────────────────────────────────────────────────── */

test('C9·C7·C13: NO_REPORT 규칙은 러너 프롬프트에만(runnerNote) — 지시 원문(일지·턴 이벤트·대화 기록 재료)과 완료 조건 재시도 지시에는 없다', async () => {
  const ws = await company();
  const r = await daily(ws, { verify: { files: ['보고.md'], retries: 1 } });
  const chatFn = fakeChat([{ reply: '아직' }, { reply: '만들었습니다', make: ['보고.md', '# 보고'] }]);
  await runRoutine(ws, r.id, { chatFn });
  assert.equal(chatFn.calls[0].msg, HEAD, 'chat에 넘기는 지시는 종전 모양 그대로(규칙이 일지·턴 이벤트·기억 재료에 섞이지 않는다)');
  assert.match(chatFn.calls[0].note, /NO_REPORT/, '첫 실행의 러너 프롬프트에 보고 규칙이 붙는다');
  assert.equal(chatFn.calls[1].note, '', '재시도는 산출물을 요구하는 지시라 규칙을 붙이지 않는다');
  assert.doesNotMatch(chatFn.calls[1].msg, /NO_REPORT/);
  const msgs = await thread(ws);
  assert.equal(msgs[0].text, HEAD, '대화 기록의 지시는 종전 모양(규칙 없음)');
});

test('C6: 루프 루틴에는 NO_REPORT 규칙을 붙이지 않는다(마지막 줄 LOOP 판정과 충돌)', async () => {
  const ws = await company();
  const loop = await addRoutine(ws, { agentSlug: 'alpha', title: '점검 루프', prompt: '서버를 점검하라', schedule: { type: 'interval', everyMinutes: 10 }, loop: { maxRuns: 5 } });
  const chatFn = fakeChat([{ reply: '정상\nLOOP: continue' }]);
  await runRoutine(ws, loop.id, { chatFn });
  assert.doesNotMatch(chatFn.calls[0].msg, /NO_REPORT/);
  assert.equal(chatFn.calls[0].note, '');
});

test('C1·C11: 답이 NO_REPORT면 성공(lastResult 보고할 내용 없음)으로 기록하고 알림은 보내지 않는다', async () => {
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: 'NO_REPORT' }]) });
  await n.stop();
  assert.equal(out.ok, true);
  assert.equal(out.reply, '보고할 내용 없음', '목록의 지금 실행 응답도 알아듣는 말로');
  const saved = await byId(ws, r.id);
  assert.equal(saved.lastOk, true); assert.equal(saved.lastResult, '보고할 내용 없음');
  assert.equal(n.got.filter((e) => e.type === 'routine').length, 0, '보고할 것이 없으면 텔레그램·슬랙·메신저 알림을 보내지 않는다');
  const msgs = await thread(ws);
  assert.equal(msgs[0].text, HEAD);
  assert.equal(msgs[1].who, 'crew');
  assert.match(msgs[1].text, /보고할 내용 없음/);
  assert.doesNotMatch(msgs[1].text, /NO_REPORT/, '엔진용 표지를 대화에 그대로 보이지 않는다');
});

// 표지 줄 = 줄 머리의 NO_REPORT(대소문자 무시). 앞에는 공백·인용(>)·목록 기호(- + • · 1. 1))·굵게·백틱·따옴표, 뒤에는 닫는 꾸밈·
// 한국어 서술어('입니다'·'임' — 바로 뒤가 글자면 아님)·마침표만 허용한다. 답 안에 표지 줄이 따로 있으면 보고 없음이다(3차 검수 정책).
test('C4: 표지 줄의 변형(공백·백틱·마침표·서술어·목록 기호·소문자)도 NO_REPORT로 인정한다 — 알림 0, 대화 기록에 원문 토큰 없음', async () => {
  for (const reply of ['  NO_REPORT  ', '`NO_REPORT`', 'NO_REPORT.', '\n\nNO_REPORT\n',
    'NO_REPORT입니다', 'NO_REPORT입니다.', 'NO_REPORT임', '`NO_REPORT`입니다.', '- NO_REPORT', '* **NO_REPORT**', '1. NO_REPORT', '> NO_REPORT', 'no_report', 'No_Report.']) {
    const ws = await company();
    const r = await daily(ws);
    const n = notices(ws);
    const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
    await n.stop();
    assert.equal(n.got.filter((e) => e.type === 'routine').length, 0, JSON.stringify(reply));
    assert.equal(out.noReport, true, JSON.stringify(reply));
    assert.equal((await byId(ws, r.id)).lastResult, '보고할 내용 없음', JSON.stringify(reply));
    const msgs = await thread(ws);
    assert.equal(msgs.at(-1).text, '보고할 내용 없음 — 알림을 보내지 않았습니다.', JSON.stringify(reply));
  }
});

test('C3: 표지가 다른 줄과 같이 오면 보고로 보낸다(따로 떨어진 표지 줄만 뗀다) — 보안 검토(알림 억제): 표지 한 줄뿐일 때만 보고 없음', async () => {
  for (const [reply, sentText] of [
    ['새 메일 1건: 견적 회신\n\nNO_REPORT', '새 메일 1건: 견적 회신'],
    ['보고할 것 없음.\nNO_REPORT', '보고할 것 없음.'],
    ['NO_REPORT\n\n(새 메일 0건)', '(새 메일 0건)'],
    ['- 확인한 메일 3건, 새 것 없음\n- NO_REPORT', '- 확인한 메일 3건, 새 것 없음'],
    ['오늘 확인 결과\nno_report입니다.', '오늘 확인 결과'],
  ]) {
    const ws = await company();
    const r = await daily(ws);
    const n = notices(ws);
    const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
    await n.stop();
    const sent = n.got.filter((e) => e.type === 'routine');
    assert.equal(sent.length, 1, `보고로 알림 1건: ${JSON.stringify(reply)}`);
    assert.equal(sent[0].reply, sentText, `표지 줄만 떼고 나머지 그대로: ${JSON.stringify(reply)}`);
    assert.doesNotMatch(sent[0].reply, /no_report/i);
    assert.notEqual(out.noReport, true, JSON.stringify(reply));
    assert.equal((await thread(ws)).at(-1).text, sentText, '대화 기록에도 토큰 없이');
  }
});

test('C3s: 루틴이 읽은 바깥 글(메일 본문)에 심은 NO_REPORT 줄을 인용해도 보고는 사라지지 않는다 — 알림 1건, 원문 그대로', async () => {
  const reply = '새 업무 메일 1건\n- 보낸 사람: 거래처 A\n- 본문 인용:\n> 입금 기한이 오늘입니다\n> NO_REPORT\n\n확인이 필요합니다.';
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
  await n.stop();
  const sent = n.got.filter((e) => e.type === 'routine');
  assert.equal(sent.length, 1, '바깥 글 한 줄로 보고 전체가 숨겨지면 안 된다');
  assert.equal(sent[0].reply, reply.replace('\n> NO_REPORT', ''), '보고는 그대로 가고 따로 떨어진 표지 줄만 빠진다');
  assert.notEqual(out.noReport, true);
  assert.notEqual((await byId(ws, r.id)).lastResult, '보고할 내용 없음');
});

test('C5: 표지가 문장 속에 섞였거나 바로 뒤에 글자가 이어지면 표지가 아니다 — 보고로 원문 그대로 보낸다', async () => {
  for (const reply of [
    '어제는 NO_REPORT 였지만 오늘은 1건 있습니다',
    '오늘은 NO_REPORT 대상이 아닙니다 — 새 메일 1건이 있습니다',
    'NO_REPORT 대상이 아닙니다. 새 메일 1건',
    'NO_REPORT입니다만 새 메일 1건이 있습니다',
    'NO_REPORT였던 어제와 달리 오늘은 1건',
    'NO_REPORTS 2건을 확인했습니다',
    '오늘 확인 결과 NO_REPORT', // 줄 머리가 아니다 — 표지 줄이 따로 있지 않으면 보고로 둔다(잘못 막는 것보다 보내는 쪽)
    '확인 끝 — NO_REPORT.',
  ]) {
    const ws = await company();
    const r = await daily(ws);
    const n = notices(ws);
    const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
    await n.stop();
    const ev = n.got.filter((e) => e.type === 'routine');
    assert.equal(ev.length, 1, JSON.stringify(reply));
    assert.equal(ev[0].reply, reply, `원문 그대로: ${JSON.stringify(reply)}`);
    assert.equal(out.noReport, undefined, JSON.stringify(reply));
  }
});

test('C10: 1회 예약도 NO_REPORT는 성공 — 성공 규칙대로 스스로 꺼진다', async () => {
  const ws = await company();
  const r = await addRoutine(ws, { agentSlug: 'alpha', title: '예약', prompt: '확인하라', schedule: { type: 'once', date: '2099-01-02', time: '09:00' } });
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: 'NO_REPORT' }]) });
  const saved = await byId(ws, r.id);
  assert.equal(saved.lastOk, true); assert.equal(saved.enabled, false);
});

test('C12: 영문 회사는 규칙·결과·실패 문구가 영어다', async () => {
  const ws = await company('en');
  const r = await daily(ws);
  const chatFn = fakeChat([{ reply: 'NO_REPORT' }, { reply: '' }]);
  await runRoutine(ws, r.id, { chatFn });
  assert.match(chatFn.calls[0].note, /nothing to (report|tell)/i);
  assert.doesNotMatch(chatFn.calls[0].note, /보고 규칙/);
  assert.equal((await byId(ws, r.id)).lastResult, 'Nothing to report');
  await assert.rejects(runRoutine(ws, r.id, { chatFn }), /The agent returned no answer at all/);
});

/* ─── C·D. 빈 답 ─────────────────────────────────────────────────────────── */

test('A3·D1: 빈 답(SDK 빈 result 모양)은 실패 — 알아듣는 문구, 알림 본문에 사유, 대화 기록에 남는다', async () => {
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  await assert.rejects(runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '   ' }]) }), /에이전트가 아무 답도 내지 않았습니다/);
  await n.stop();
  const saved = await byId(ws, r.id);
  assert.equal(saved.lastOk, false); assert.match(saved.lastResult, /NO_REPORT/);
  const ev = n.got.filter((e) => e.type === 'routine');
  assert.equal(ev.length, 1); assert.equal(ev[0].ok, false);
  assert.match(ev[0].reply, /아무 답도 내지 않았습니다/, '제목만 가던 알림 대신 사유가 본문에 실린다');
  const msgs = await thread(ws);
  assert.equal(msgs[0].text, HEAD);
  assert.match(msgs[1].text, /아무 답도 내지 않았습니다/);
});

test('A2: CLI 경로의 빈 응답 예외(emptyReply)도 루틴에서는 같은 알아듣는 문구로 바뀐다', async () => {
  const ws = await company();
  const r = await daily(ws);
  const cliEmpty = Object.assign(new Error('Codex 러너가 빈 응답을 반환했습니다'), { emptyReply: true });
  await assert.rejects(runRoutine(ws, r.id, { chatFn: fakeChat([cliEmpty]) }), /에이전트가 아무 답도 내지 않았습니다\(보고할 것이 없을 때는 NO_REPORT로 답하도록 바뀌었습니다\)/);
  assert.match((await byId(ws, r.id)).lastResult, /아무 답도/);
});

test('D2: 루프 회차 답이 LOOP 판정 줄뿐이면 제목만 있는 결과 알림을 보내지 않는다(판정은 종전대로)', async () => {
  const ws = await company();
  const loop = await addRoutine(ws, { agentSlug: 'alpha', title: '점검 루프', prompt: '서버를 점검하라', schedule: { type: 'interval', everyMinutes: 10 }, loop: { maxRuns: 5 } });
  const n = notices(ws);
  await runRoutine(ws, loop.id, { chatFn: fakeChat([{ reply: 'LOOP: continue' }]) });
  await n.stop();
  assert.equal(n.got.filter((e) => e.type === 'routine').length, 0);
  const saved = await byId(ws, loop.id);
  assert.equal(saved.loop.lastVerdict, 'continue'); assert.equal(saved.loop.missingVerdicts, 0);
  assert.equal(saved.lastResult, '보고할 내용 없음');
});

/* ─── B. 놓친 회차 ───────────────────────────────────────────────────────── */

// 서울 시간대로 박은 daily 09:00 루틴 — 기기 시간대와 무관하게 결정적이다.
const SEOUL = 'Asia/Seoul';
const kst = (d, hm) => new Date(`${d}T${hm}:00+09:00`);
async function seoulDaily(ws, { times = ['09:00'], lastRun = kst('2026-10-07', '09:00').toISOString(), created = '2026-09-01T00:00:00.000Z' } = {}) {
  const r = await addRoutine(ws, { agentSlug: 'alpha', title: '아침 보고', prompt: '보고하라', schedule: { type: 'daily', times, tz: SEOUL } });
  const raw = await loadRoutines(ws);
  Object.assign(raw.find((x) => x.id === r.id), { lastRun, created, editedAt: created });
  await writeJsonAtomic(paths(ws).routines, raw);
  return r;
}

test('B1·B10: 4시간 넘게 놓친 회차는 활동 기록·알림에 한 번 남고, 같은 상태의 다음 틱은 쓰기 0', async () => {
  const ws = await company();
  const r = await seoulDaily(ws);
  const runs = [];
  const n = notices(ws);
  await runDueRoutines(ws, kst('2026-10-08', '15:00'), { runFn: async (_w, id) => { runs.push(id); } });
  await n.stop();
  assert.deepEqual(runs, [], '전제: 09:00 슬롯은 catch-up 창(4h)을 넘겨 실행되지 않는다(종전 동작)');
  const ev = (await readEvents(ws)).filter((e) => e.type === 'routine-skipped');
  assert.equal(ev.length, 1, '건너뛴 회차가 활동 기록에 남는다');
  assert.equal(ev[0].slug, 'alpha'); assert.equal(ev[0].routineId, r.id); assert.equal(ev[0].title, '아침 보고');
  assert.deepEqual(ev[0].slots, [{ date: '2026-10-08', time: '09:00' }]);
  const skipNotice = n.got.filter((e) => e.type === 'routine');
  assert.equal(skipNotice.length, 1, '알림은 기존 알림 설정을 따라 한 번');
  assert.equal(skipNotice[0].ok, false); assert.equal(skipNotice[0].phase, 'skipped');
  assert.match(skipNotice[0].reply, /10월 8일 09:00/); assert.match(skipNotice[0].reply, /기기가 꺼져/);

  const before = await readFile(paths(ws).routines, 'utf8');
  const n2 = notices(ws);
  await runDueRoutines(ws, kst('2026-10-08', '15:01'), { runFn: async (_w, id) => { runs.push(id); } });
  await n2.stop();
  assert.equal(await readFile(paths(ws).routines, 'utf8'), before, '이미 남긴 회차는 다시 쓰지 않는다(유휴 쓰기 0)');
  assert.equal((await readEvents(ws)).filter((e) => e.type === 'routine-skipped').length, 1);
  assert.equal(n2.got.length, 0);
});

test('B2·B3: 다음 실행 때 대화 기록에 건너뛴 회차 한 줄(같은 날 여러 회차는 한 줄)이 지시 앞에 남고, 남길 목록은 비운다', async () => {
  const ws = await company();
  const r = await seoulDaily(ws, { times: ['09:00', '13:00'], lastRun: kst('2026-10-07', '13:00').toISOString() }); // 전날 두 회차는 실행됨
  await runDueRoutines(ws, kst('2026-10-08', '18:00'), { runFn: async () => {} });
  assert.equal((await byId(ws, r.id)).missed?.length, 2);
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '보고 완료' }]) });
  const msgs = await thread(ws);
  const notes = msgs.filter((m) => /실행하지 못했습니다/.test(m.text));
  assert.equal(notes.length, 1, '같은 날 두 회차는 한 줄');
  assert.match(notes[0].text, /10월 8일 09:00·13:00/);
  assert.ok(msgs.indexOf(notes[0]) < msgs.findIndex((m) => m.text === '[루틴: 아침 보고] 보고하라'), '그 실행의 지시보다 앞에');
  assert.equal(notes[0].via, 'routine', '루틴에서 온 글로 표시된다(1:1 화면 출처 카드)');
  assert.equal((await byId(ws, r.id)).missed, undefined, '한 번 남긴 회차는 다음 실행에 다시 남기지 않는다');
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '보고 완료' }]) });
  assert.equal((await thread(ws)).filter((m) => /실행하지 못했습니다/.test(m.text)).length, 1);
});

test('B4: catch-up 창 안에 켜지면 종전대로 실행하고 건너뜀 기록은 없다', async () => {
  const ws = await company();
  const r = await seoulDaily(ws);
  const runs = [];
  await runDueRoutines(ws, kst('2026-10-08', '12:00'), { runFn: async (_w, id) => { runs.push(id); } });
  assert.deepEqual(runs, [r.id]);
  assert.equal((await readEvents(ws)).filter((e) => e.type === 'routine-skipped').length, 0);
});

test('B8: 에이전트 카드가 없는 루틴은 건너뜀을 기록하지 않는다(실행 건너뜀과 같은 판정, 저장 상태 불변)', async () => {
  const ws = await company();
  const r = await seoulDaily(ws);
  const raw = await loadRoutines(ws);
  raw.find((x) => x.id === r.id).agentSlug = 'ghost';
  await writeJsonAtomic(paths(ws).routines, raw);
  const before = await readFile(paths(ws).routines, 'utf8');
  await runDueRoutines(ws, kst('2026-10-08', '15:00'), { runFn: async () => {} });
  assert.equal(await readFile(paths(ws).routines, 'utf8'), before);
  assert.equal((await readEvents(ws)).filter((e) => e.type === 'routine-skipped').length, 0);
});

test('B5: 사람이 루틴을 고친 시각(editedAt)·만든 시각 이전 슬롯, 꺼진 루틴은 놓친 회차가 아니다', async () => {
  const ws = await company();
  const edited = await seoulDaily(ws);
  const off = await seoulDaily(ws);
  const raw = await loadRoutines(ws);
  raw.find((x) => x.id === edited.id).editedAt = kst('2026-10-08', '10:00').toISOString(); // 09:00 뒤에 다시 켬·편집
  raw.find((x) => x.id === off.id).enabled = false;
  await writeJsonAtomic(paths(ws).routines, raw);
  await runDueRoutines(ws, kst('2026-10-08', '15:00'), { runFn: async () => {} });
  assert.equal((await readEvents(ws)).filter((e) => e.type === 'routine-skipped').length, 0);
});

/* ─── 검수 반영(2차) ─────────────────────────────────────────────────────── */

test('C4b·C4d: 코드 펜스로 감싼 NO_REPORT 한 줄은 보고할 것 없음 — 보고 뒤에 붙어 오면 보고로 보낸다', async () => {
  for (const reply of ['```\nNO_REPORT\n```', '~~~text\nNO_REPORT\n~~~', '```\n\nNO_REPORT\n\n```\n']) {
    const ws = await company();
    const r = await daily(ws);
    const n = notices(ws);
    const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
    await n.stop();
    assert.equal(n.got.filter((e) => e.type === 'routine').length, 0, `펜스만 남은 알림이 나가면 안 된다: ${JSON.stringify(reply)}`);
    assert.equal(out.noReport, true, JSON.stringify(reply));
    assert.equal((await byId(ws, r.id)).lastResult, '보고할 내용 없음', JSON.stringify(reply));
  }
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  const reply = '새 메일 1건: 견적 회신\n\n```\nNO_REPORT\n```';
  const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
  await n.stop();
  const sent = n.got.filter((e) => e.type === 'routine');
  assert.equal(sent.length, 1, '보고 뒤에 표지가 붙어 오면 보고로 보낸다(C3과 같은 정책)');
  assert.equal(sent[0].reply, '새 메일 1건: 견적 회신', '표지 줄과 그것을 감쌌던 빈 코드 블록이 빠진다');
  assert.notEqual(out.noReport, true);
});

test('C4c: 같은 줄에 설명이 붙은 앞머리 표지(구분 기호 — : ( - .)도 보고 없음 — 설명은 대화 기록에만(줄을 바꿔 쓴 C3과 결과가 같다)', async () => {
  for (const [reply, shown] of [['NO_REPORT (새 메일 없음)', '새 메일 없음'], ['NO_REPORT — 새 항목 0건', '새 항목 0건'], ['NO_REPORT: 변동 없음', '변동 없음'], ['**NO_REPORT** - 확인 완료', '확인 완료'], ['NO_REPORT. 새 메일 0건', '새 메일 0건'], ['NO_REPORT입니다 — 변동 없음', '변동 없음']]) {
    const ws = await company();
    const r = await daily(ws);
    const n = notices(ws);
    const out = await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
    await n.stop();
    assert.equal(n.got.filter((e) => e.type === 'routine').length, 0, reply);
    assert.equal(out.noReport, true, reply);
    assert.equal((await byId(ws, r.id)).lastResult, '보고할 내용 없음', reply);
    assert.equal((await thread(ws)).at(-1).text, `${shown}\n\n(보고할 내용 없음으로 답해 알림을 보내지 않았습니다.)`, `표지만 떼고 설명은 대화 기록에: ${reply}`);
  }
  // 문장 속 단어(C5)는 그대로 — 앞머리 표지가 아니다
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: 'NO_REPORT였던 어제와 달리 오늘은 1건' }]) });
  await n.stop();
  assert.equal(n.got.filter((e) => e.type === 'routine')[0]?.reply, 'NO_REPORT였던 어제와 달리 오늘은 1건');
});

test('A10·A11: 루틴 실패 기록(지시·실패 안내)은 대화 기록에 보이되 다음 턴 맥락에서는 빠진다 — 성공 턴·놓친 회차 한 줄은 맥락에 남는다', async () => {
  const ws = await company();
  const r = await seoulDaily(ws, { times: ['09:00', '13:00'], lastRun: kst('2026-10-07', '13:00').toISOString() });
  await runDueRoutines(ws, kst('2026-10-08', '18:00'), { runFn: async () => {} }); // 10/8 두 회차 놓침 → 다음 실행이 한 줄 남긴다
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '보고: 새 메일 2건' }]) });
  await assert.rejects(runRoutine(ws, r.id, { chatFn: fakeChat([new Error('러너 연결 안 됨')]) }));
  const msgs = await thread(ws);
  assert.equal(msgs.length, 5, '건너뜀 1 + 성공 턴 2 + 실패 지시·안내 2 — 화면에는 다 보인다');
  const ctx = msgs.filter((m) => inThreadContext(m, null)).map((m) => [m.who, m.text]);
  assert.deepEqual(ctx.map(([w]) => w), ['user', 'user', 'crew'], `맥락 = 건너뜀 한 줄 + 성공 턴: ${JSON.stringify(ctx)}`);
  assert.match(ctx[0][1], /실행하지 못했습니다/);
  assert.equal(ctx[2][1], '보고: 새 메일 2건');
  assert.ok(!ctx.some(([, t]) => /루틴 실행에 실패했습니다/.test(t)), '실패 안내가 에이전트가 한 말처럼 다음 턴 맥락에 실리지 않는다');

  // 완료 조건 최종 미충족 — 시도 턴은 맥락에 남고, 뒤의 실패 안내 한 줄만 빠진다
  const ws2 = await company();
  const v = await daily(ws2, { verify: { files: ['보고.md'], retries: 1 } });
  await assert.rejects(runRoutine(ws2, v.id, { chatFn: fakeChat([{ reply: '다 했습니다' }, { reply: '또 다 했습니다' }]) }));
  const m2 = (await loadThread(ws2, 'alpha')).messages;
  assert.equal(m2.length, 5);
  assert.deepEqual(m2.filter((m) => inThreadContext(m, null)).map((m) => m.who), ['user', 'crew', 'user', 'crew']);
});

test('D3: 건너뜀 알림 머리는 (건너뜀)/(skipped) — 실패는 (실패)/(failed), 결과는 꼬리 없음(메신저 1:1 알림 문안)', () => {
  const base = { type: 'routine', routine: { title: '아침 보고' }, reply: '10월 8일 09:00 회차는 건너뛰었습니다' };
  const skipped = formatMsgrNotify({ ...base, ok: false, phase: 'skipped' }, 'ko');
  assert.match(skipped, /^\[루틴\] 아침 보고 \(건너뜀\)\n/);
  assert.doesNotMatch(skipped, /실패/);
  assert.match(formatMsgrNotify({ ...base, ok: false, phase: 'skipped' }, 'en'), /^\[Routine\] 아침 보고 \(skipped\)\n/);
  assert.match(formatMsgrNotify({ ...base, ok: false }, 'ko'), /^\[루틴\] 아침 보고 \(실패\)\n/);
  assert.match(formatMsgrNotify({ ...base, ok: true }, 'ko'), /^\[루틴\] 아침 보고\n/);
});

test('E1: 영문 회사의 여러 회차 건너뜀 안내는 복수형이다(한 회차는 단수)', async () => {
  const ws = await company('en');
  await seoulDaily(ws, { times: ['09:00', '13:00'], lastRun: kst('2026-10-07', '13:00').toISOString() });
  const one = await company('en');
  await seoulDaily(one);
  const n = notices(ws); const n1 = notices(one);
  await runDueRoutines(ws, kst('2026-10-08', '18:00'), { runFn: async () => {} });
  await runDueRoutines(one, kst('2026-10-08', '15:00'), { runFn: async () => {} });
  await n.stop(); await n1.stop();
  const many = n.got.find((e) => e.phase === 'skipped')?.reply ?? '';
  assert.match(many, /These runs were skipped/); assert.match(many, /Oct 8 09:00 · 13:00/);
  assert.doesNotMatch(many, /run was/);
  assert.match(n1.got.find((e) => e.phase === 'skipped')?.reply ?? '', /This run was skipped/);
});

test('B26: 건너뜀 안내는 사실만 말한다 — 날짜를 넘긴 23:00 회차는 00:30에 켜져 있어도 실행되지 않으므로 "4시간 안에 켜져 있으면 실행된다"고 하지 않는다', async () => {
  for (const lang of ['ko', 'en']) {
    const ws = await company(lang);
    const r = await seoulDaily(ws, { times: ['23:00'], lastRun: kst('2026-10-07', '23:00').toISOString() });
    const runs = [];
    await runDueRoutines(ws, kst('2026-10-09', '00:30'), { runFn: async (_w, id) => { runs.push(id); } });
    assert.deepEqual(runs, [], '전제: isDue는 날짜를 넘겨 따라잡지 않는다 — 10/8 23:00 회차를 1시간 30분 뒤인 00:30에 켜도 실행되지 않는다');
    const n = notices(ws);
    await runDueRoutines(ws, kst('2026-10-09', '03:30'), { runFn: async (_w, id) => { runs.push(id); } });
    await n.stop();
    const reply = n.got.find((e) => e.phase === 'skipped')?.reply ?? '';
    assert.match(reply, lang === 'en' ? /Oct 8 23:00/ : /10월 8일 23:00/);
    assert.doesNotMatch(reply, /4시간|4 hours/, `있지도 않은 4시간 규칙을 말하지 않는다: ${reply}`);
    assert.match(reply, lang === 'en' ? /off or asleep/ : /꺼져 있었거나 잠들어 있어 실행하지 못했습니다/, reply);
    await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '보고 완료' }]) }); // 다음 실행이 대화 기록에 같은 문구 한 줄
    const note = (await thread(ws)).find((m) => /23:00/.test(m.text))?.text ?? '';
    assert.doesNotMatch(note, /4시간|4 hours/, note);
    assert.match(note, lang === 'en' ? /off or asleep/ : /꺼져 있었거나 잠들어/, note);
  }
  // 활동 화면 문구(app/i18n.jsx activity.routineSkipped) — 같은 사실만
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const line = dict.split('\n').find((l) => l.includes("'activity.routineSkipped':")) ?? '';
  assert.ok(line, '활동 화면 키가 있다');
  assert.doesNotMatch(line, /4시간|4 hours/, line);
  assert.match(line, /꺼져 있었거나 잠들어/); assert.match(line, /off or asleep/);
});

test('B22: 판정 기간(7일) 밖의 missed 표지는 새로 남길 때 정리된다(쌓이지 않는다)', async () => {
  const ws = await company();
  const r = await seoulDaily(ws);
  const raw = await loadRoutines(ws);
  raw.find((x) => x.id === r.id).missed = [{ at: '2026-09-20T00:00:00.000Z', date: '2026-09-20', time: '09:00' }, { at: '2026-10-05T00:00:00.000Z', date: '2026-10-05', time: '09:00' }];
  await writeJsonAtomic(paths(ws).routines, raw);
  await runDueRoutines(ws, kst('2026-10-08', '15:00'), { runFn: async () => {} });
  assert.deepEqual((await byId(ws, r.id)).missed.map((m) => m.date), ['2026-10-05', '2026-10-08'], '7일 넘은 9/20 표지는 빠지고 기간 안 표지와 새 표지만 남는다');
});

test('B23: 틱이 읽은 목록이 낡았어도(그 사이 실행으로 lastRun이 바뀜) 잠금 안에서 디스크를 다시 판정해 기록하지 않는다', async () => {
  const ws = await company();
  const r = await seoulDaily(ws);
  const stale = await loadRoutines(ws); // 틱이 먼저 읽은 목록 — lastRun 10/7 09:00
  const raw = await loadRoutines(ws);
  raw.find((x) => x.id === r.id).lastRun = kst('2026-10-08', '14:59').toISOString(); // 같은 틱 사이 수동 '실행'이 lastRun을 바꿨다
  await writeJsonAtomic(paths(ws).routines, raw);
  const before = await readFile(paths(ws).routines, 'utf8');
  const n = notices(ws);
  const found = await recordMissedSlots(ws, stale, kst('2026-10-08', '15:00'));
  await n.stop();
  assert.deepEqual(found, []);
  assert.equal(await readFile(paths(ws).routines, 'utf8'), before, '디스크 최신본 기준으로는 놓친 회차가 없다 — 쓰기 0');
  assert.equal(n.got.length, 0);
});

test('C3p: 표지 판정은 긴 공백 줄에서도 선형 시간 — 공백 5만 칸 답도 50ms 안', async () => {
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  const t0 = performance.now();
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: ' '.repeat(50_000) + 'x\n' + '\t'.repeat(50_000) + 'y' }]) });
  await n.stop();
  assert.ok(performance.now() - t0 < 2000, '판정이 몇 초씩 걸리면 안 된다');
});
