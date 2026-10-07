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

let seq = 0;
/** 회사 하나 + 에이전트 카드(alpha). 스케줄러는 카드 없는 루틴을 건너뛰므로 프로덕션 모양으로 카드를 둔다. */
async function company(lang = 'ko') {
  const ws = `rtnvis-${++seq}`;
  await createCompany(ws, '루틴 표시 검수', 'owner', null, lang);
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: 알파\nrole: 검증\n---\n검증용.\n');
  return ws;
}
const fakeChat = (replies) => {
  const calls = [];
  const fn = async (_ws, _slug, msg) => {
    calls.push(msg);
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
  assert.match(chatFn.calls[0], /\[루프 프로토콜\]/);
  assert.match(chatFn.calls[0], /LOOP: continue/);
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

test('C9·C7: 러너에게 가는 지시에만 NO_REPORT 규칙이 붙는다 — 대화 기록의 지시와 완료 조건 재시도 지시에는 없다', async () => {
  const ws = await company();
  const r = await daily(ws, { verify: { files: ['보고.md'], retries: 1 } });
  const chatFn = fakeChat([{ reply: '아직' }, { reply: '만들었습니다', make: ['보고.md', '# 보고'] }]);
  await runRoutine(ws, r.id, { chatFn });
  assert.ok(chatFn.calls[0].startsWith(HEAD), '지시 앞부분은 종전 그대로');
  assert.match(chatFn.calls[0], /NO_REPORT/, '첫 지시에 보고 규칙이 붙는다');
  assert.doesNotMatch(chatFn.calls[1], /NO_REPORT/, '재시도는 산출물을 요구하는 지시라 규칙을 붙이지 않는다');
  const msgs = await thread(ws);
  assert.equal(msgs[0].text, HEAD, '대화 기록의 지시는 종전 모양(규칙 없음)');
});

test('C6: 루프 루틴에는 NO_REPORT 규칙을 붙이지 않는다(마지막 줄 LOOP 판정과 충돌)', async () => {
  const ws = await company();
  const loop = await addRoutine(ws, { agentSlug: 'alpha', title: '점검 루프', prompt: '서버를 점검하라', schedule: { type: 'interval', everyMinutes: 10 }, loop: { maxRuns: 5 } });
  const chatFn = fakeChat([{ reply: '정상\nLOOP: continue' }]);
  await runRoutine(ws, loop.id, { chatFn });
  assert.doesNotMatch(chatFn.calls[0], /NO_REPORT/);
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

test('C4: 앞뒤 공백·백틱·마침표가 붙은 NO_REPORT도 인정한다', async () => {
  for (const reply of ['  NO_REPORT  ', '`NO_REPORT`', 'NO_REPORT.', '\n\nNO_REPORT\n']) {
    const ws = await company();
    const r = await daily(ws);
    const n = notices(ws);
    await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply }]) });
    await n.stop();
    assert.equal(n.got.filter((e) => e.type === 'routine').length, 0, JSON.stringify(reply));
    assert.equal((await byId(ws, r.id)).lastResult, '보고할 내용 없음', JSON.stringify(reply));
  }
});

test('C3·C5: 보고 뒤에 붙은 NO_REPORT 줄은 떼고 보고를 보낸다 / 문장 속 단어는 보고로 본다', async () => {
  const ws = await company();
  const r = await daily(ws);
  const n = notices(ws);
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '새 메일 1건: 견적 회신\n\nNO_REPORT' }]) });
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '어제는 NO_REPORT 였지만 오늘은 1건 있습니다' }]) });
  await n.stop();
  const results = n.got.filter((e) => e.type === 'routine');
  assert.equal(results.length, 2);
  assert.equal(results[0].reply, '새 메일 1건: 견적 회신');
  assert.equal(results[1].reply, '어제는 NO_REPORT 였지만 오늘은 1건 있습니다');
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
  assert.match(chatFn.calls[0], /nothing to (report|tell)/i);
  assert.doesNotMatch(chatFn.calls[0], /보고 규칙/);
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
  const notes = msgs.filter((m) => /건너뛰었습니다/.test(m.text));
  assert.equal(notes.length, 1, '같은 날 두 회차는 한 줄');
  assert.match(notes[0].text, /10월 8일 09:00·13:00/);
  assert.ok(msgs.indexOf(notes[0]) < msgs.findIndex((m) => m.text === '[루틴: 아침 보고] 보고하라'), '그 실행의 지시보다 앞에');
  assert.equal(notes[0].via, 'routine', '루틴에서 온 글로 표시된다(1:1 화면 출처 카드)');
  assert.equal((await byId(ws, r.id)).missed, undefined, '한 번 남긴 회차는 다음 실행에 다시 남기지 않는다');
  await runRoutine(ws, r.id, { chatFn: fakeChat([{ reply: '보고 완료' }]) });
  assert.equal((await thread(ws)).filter((m) => /건너뛰었습니다/.test(m.text)).length, 1);
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
