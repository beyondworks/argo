// '/' 커맨더 목록 미러(유건 지시 2026-09-14) — 회사 별칭·스킬을 크루 행(commands)에 올린다. 본문·키는 싣지 않고, 같은 내용이면 폴마다 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crewCommands, mirrorCommands, fitCommands, commandsSize, COMMANDS_BUDGET, COMMANDS_REJECT_RETRY_MS, _resetCommandsForTest } from '../src/gateway/msgr.mjs';

test('crewCommands — 별칭(cmd·text)과 스킬(id·title)만, 빈 항목·비배열은 버리고 길이를 자른다', () => {
  const out = crewCommands({
    aliases: [{ cmd: '보고', text: '오늘 업무 보고서 작성' }, { cmd: '', text: 'x' }, { cmd: 'a' }, null],
    skills: [{ id: 'daily-report', title: '일일 보고', size: 1200, injected: 'full', text: 'SECRET BODY' }, { id: '' }, { id: 'no-title' }],
  });
  assert.deepEqual(out, [
    { kind: 'alias', cmd: '보고', text: '오늘 업무 보고서 작성' },
    { kind: 'skill', id: 'daily-report', title: '일일 보고' },
    { kind: 'skill', id: 'no-title', title: 'no-title' },
  ]);
  assert.ok(!JSON.stringify(out).includes('SECRET BODY'), '스킬 본문은 실리지 않는다');
  assert.deepEqual(crewCommands({ aliases: 'nope', skills: null }), []);
  assert.equal(crewCommands({ aliases: [{ cmd: 'x'.repeat(100), text: 'y' }] })[0].cmd.length, 40);
});

test('mirrorCommands — 바뀐 폴에만 update, 같은 내용이면 건너뛴다', async () => {
  _resetCommandsForTest();
  const calls = [];
  const db = { setCommands: async (uid, ws, commands) => calls.push({ uid, ws, commands }) };
  const cmds = [{ kind: 'skill', id: 's', title: 'S' }];
  assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: cmds }), true);
  assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: [...cmds] }), false, '같은 내용 → 쓰지 않음');
  assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: [] }), true, '스킬 삭제 → 갱신');
  assert.equal(await mirrorCommands('ws2', { db, uid: 'u', commands: [] }), true, '다른 회사는 따로');
  assert.deepEqual(calls.map((c) => [c.ws, c.commands.length]), [['ws1', 1], ['ws1', 0], ['ws2', 0]]);
});

// 실패 규칙(2026-10-06 — 23514로 1시간 226번 같은 update를 다시 보낸 사고): 일시 오류만 다시 시도하고, 영구 오류는 내용이 바뀔 때까지 멈춘다.
const err = (code, message = 'boom') => Object.assign(new Error(`msgr db: ${message}`), code === undefined ? {} : { code });
const quiet = async (fn) => { const logs = []; const o = [console.error, console.warn]; console.error = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' ')); try { await fn(); } finally { [console.error, console.warn] = o; } return logs; };

test('mirrorCommands — 일시 오류(네트워크·5xx·코드 없음)는 기억하지 않고 다음 폴에 다시 시도한다', async () => {
  for (const e of [err(undefined, 'fetch failed'), err('PGRST000', 'upstream 503'), err('57014', 'statement timeout'), err('40P01', 'deadlock')]) {
    _resetCommandsForTest();
    let fail = true; let calls = 0;
    const db = { setCommands: async () => { calls++; if (fail) throw e; } };
    await assert.rejects(mirrorCommands('ws1', { db, uid: 'u', commands: [] }), e, `${e.code ?? '코드 없음'}는 던진다(호출부가 로그)`);
    await assert.rejects(mirrorCommands('ws1', { db, uid: 'u', commands: [] }));
    fail = false;
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: [] }), true);
    assert.equal(calls, 3, `${e.code ?? '코드 없음'}: 폴마다 다시 보낸다`);
  }
});

test('mirrorCommands — 영구 오류(23xxx·42501·22xxx·옛 서버)는 같은 내용이면 다시 보내지 않고 로그는 한 번, 내용이 바뀌면 다시 시도', async () => {
  for (const code of ['23514', '42501', '22P02', 'PGRST204', '42703']) {
    _resetCommandsForTest();
    const calls = [];
    let fail = true;
    const db = { setCommands: async (u, ws, commands) => { calls.push(commands.length); if (fail) throw err(code); } };
    const A = [{ kind: 'skill', id: 'a', title: 'A' }];
    const logs = await quiet(async () => {
      for (let i = 0; i < 5; i++) assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A }), false, `${code}: 던지지 않는다`);
    });
    assert.deepEqual(calls, [1], `${code}: 5폴 동안 update 1번`);
    assert.equal(logs.length, 1, `${code}: 로그 1줄`);
    assert.match(logs[0], new RegExp(code));
    fail = false;
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: [...A, { kind: 'skill', id: 'b', title: 'B' }] }), true, '내용이 바뀌면 다시 보낸다');
    assert.equal(await mirrorCommands('ws2', { db, uid: 'u', commands: A }), true, '다른 회사는 따로 판정');
    assert.deepEqual(calls, [1, 2, 1]);
  }
});

test('mirrorCommands — 거절된 내용 뒤 예전 내용으로 돌아오면 서버 값이 그대로라 쓰지 않는다', async () => {
  _resetCommandsForTest();
  const calls = [];
  const A = [{ kind: 'skill', id: 'a', title: 'A' }], B = [{ kind: 'skill', id: 'b', title: 'B' }];
  const db = { setCommands: async (u, ws, commands) => { calls.push(commands[0]?.id); if (commands[0]?.id === 'b') throw err('23514'); } };
  await quiet(async () => {
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A }), true);
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: B }), false);
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A }), false, 'A는 이미 서버에 있다');
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: B }), false, 'B는 이미 거절됐다');
  });
  assert.deepEqual(calls, ['a', 'b']);
});

// 검수 #837 L-1·L-3: 거절 기억이 재시작 없이는 영영 안 풀리면 옛 서버에 마이그레이션이 들어온 뒤에도 상주의 '/' 목록이 낡은 채로 남는다.
test('mirrorCommands — 거절 기억은 1시간 뒤 한 번 다시 시도하고(로그는 처음 한 번), 성공하면 지운다', async () => {
  _resetCommandsForTest();
  const err = (code) => Object.assign(new Error(code), { code });
  const A = [{ kind: 'skill', id: 'a', title: 'A' }]; const B = [{ kind: 'skill', id: 'b', title: 'B' }];
  let fail = true; const calls = [];
  const db = { setCommands: async (u, ws, commands) => { calls.push(commands[0].id); if (fail) throw err('PGRST204'); } };
  const t0 = 1_000_000; const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A, now: t0 }), false);
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A, now: t0 + COMMANDS_REJECT_RETRY_MS - 1 }), false);
    assert.deepEqual(calls, ['a'], '1시간 안에는 다시 보내지 않는다');
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A, now: t0 + COMMANDS_REJECT_RETRY_MS }), false, '1시간 뒤 한 번 다시 — 아직 거절');
    assert.deepEqual(calls, ['a', 'a']); assert.equal(logs.length, 1, '같은 거절은 로그 한 번');
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A, now: t0 + COMMANDS_REJECT_RETRY_MS + 1 }), false, '다시 1시간 기다린다');
    assert.deepEqual(calls, ['a', 'a']);
    fail = false; // 서버가 열을 받게 됨(마이그레이션 적용)
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A, now: t0 + 2 * COMMANDS_REJECT_RETRY_MS }), true, '재시작 없이 회복');
    fail = true;
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: B, now: t0 + 2 * COMMANDS_REJECT_RETRY_MS }), false, 'B 거절');
    fail = false;
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: A, now: t0 + 2 * COMMANDS_REJECT_RETRY_MS }), false, 'A는 서버에 있다');
    const C = [{ kind: 'skill', id: 'c', title: 'C' }];
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: C, now: t0 + 2 * COMMANDS_REJECT_RETRY_MS }), true);
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: B, now: t0 + 2 * COMMANDS_REJECT_RETRY_MS }), true, '성공하면 거절 기억을 지운다 — 이제 받는 서버라 B를 바로 보낸다');
  } finally { console.error = orig; }
});

test('mirrorCommands — 유휴 폴은 쓰기 0: 같은 목록 100폴에 update 1번', async () => {
  _resetCommandsForTest();
  let calls = 0;
  const db = { setCommands: async () => { calls++; } };
  const list = () => crewCommands({ aliases: [{ cmd: '보고', text: '보고서' }], skills: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, title: `스킬 ${i}` })) }); // 폴마다 새 배열(실제처럼 매번 계산)
  for (let i = 0; i < 100; i++) await mirrorCommands('ws1', { db, uid: 'u', commands: list() });
  assert.equal(calls, 1);
});

// 크기 상한 — 서버 제약(65,536바이트)을 넘는 목록은 앞쪽부터 담고 넘친 항목은 뺀다(목록이 비지 않게).
const ko = (n) => '가나다라마바사아자차'.repeat(Math.ceil(n / 10)).slice(0, n);
const bigAliases = (n) => Array.from({ length: n }, (_, i) => ({ cmd: `별칭${i}`, text: ko(2000) }));         // 별칭 하나 약 6KB
const manySkills = (n) => Array.from({ length: n }, (_, i) => ({ id: `skill-${i}`, title: ko(80) }));        // 스킬 하나 약 270B

test('fitCommands — 상한 안이면 그대로, 빈 목록·비배열은 []', () => {
  const list = crewCommands({ aliases: [{ cmd: '보고', text: '보고서' }], skills: manySkills(20) });
  assert.deepEqual(fitCommands(list), { commands: list, dropped: 0 });
  assert.deepEqual(fitCommands([]), { commands: [], dropped: 0 });
  assert.deepEqual(fitCommands(null), { commands: [], dropped: 0 });
});

test('fitCommands — 경계: 정확히 상한이면 담고, 1바이트 넘으면 그 항목을 뺀다', () => {
  const a = { kind: 'skill', id: 'a', title: 'A' };
  const budget = commandsSize([a, a]);
  assert.deepEqual(fitCommands([a, a], budget), { commands: [a, a], dropped: 0 }, '정확히 상한');
  assert.deepEqual(fitCommands([a, a], budget - 1), { commands: [a], dropped: 1 }, '1바이트 초과');
});

test('fitCommands — 초과: 별칭이 먼저, 큰 별칭이 안 들어가도 뒤의 작은 스킬은 담고, 뺀 개수를 센다', () => {
  const list = crewCommands({ aliases: bigAliases(15), skills: manySkills(400) });
  const { commands, dropped } = fitCommands(list);
  assert.ok(commandsSize(commands) <= COMMANDS_BUDGET);
  assert.equal(commands.length + dropped, list.length);
  assert.ok(dropped > 0);
  assert.deepEqual(commands.slice(0, 3), list.slice(0, 3), '앞쪽 항목이 그대로 보인다');
  assert.ok(commands.some((c) => c.kind === 'skill'), '자리가 남으면 스킬도 담는다');
  const kept = new Set(commands.map((c) => JSON.stringify(c)));
  const order = list.filter((c) => kept.has(JSON.stringify(c)));
  assert.deepEqual(commands, order, '순서를 바꾸지 않는다');
  for (const c of commands.filter((c) => c.kind === 'alias')) assert.equal(c.text.length, 2000, '별칭 본문은 자르지 않는다(입력창에 그대로 넣는 지시문)');
});

test('fitCommands — 아주 많은 작은 항목도 상한 안(jsonb 항목당 머리 몫 포함)', () => {
  const list = crewCommands({ skills: Array.from({ length: 5000 }, () => ({ id: 'a', title: 'a' })) });
  const { commands, dropped } = fitCommands(list);
  assert.ok(commandsSize(commands) <= COMMANDS_BUDGET);
  assert.ok(Buffer.byteLength(JSON.stringify(commands)) + 14.1 * commands.length < 65536, '실측 jsonb 추정치도 제약 안');
  assert.equal(commands.length + dropped, 5000);
});

test('mirrorCommands — 상한을 넘는 목록은 줄여서 한 번 올리고, 뺀 개수는 로그 한 줄', async () => {
  _resetCommandsForTest();
  const sent = [];
  const db = { setCommands: async (u, ws, commands) => { sent.push(commands); } };
  const list = crewCommands({ aliases: bigAliases(15), skills: manySkills(400) });
  const logs = await quiet(async () => {
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: list }), true);
    assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: list }), false, '다음 폴은 쓰지 않는다');
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length > 0 && sent[0].length < list.length);
  assert.ok(commandsSize(sent[0]) <= COMMANDS_BUDGET);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`${list.length - sent[0].length}개를 빼고`));
});

test('crewCommands — jsonb가 거절하는 글자 정리: 이모지 중간에서 자른 반쪽·NUL', () => {
  const [s] = crewCommands({ skills: [{ id: 'emoji', title: '가'.repeat(79) + '😀' }] });
  assert.equal(s.title, '가'.repeat(79), '자른 끝의 반쪽 서로게이트는 버린다');
  assert.ok(s.title.isWellFormed());
  const [a] = crewCommands({ aliases: [{ cmd: 'x\u0000y', text: 'a\u0000b' }], skills: [{ id: 'lone', title: 'x\ud800y' }] });
  assert.deepEqual(a, { kind: 'alias', cmd: 'xy', text: 'ab' });
  assert.ok(crewCommands({ skills: [{ id: 'lone', title: 'x\ud800y' }] })[0].title.isWellFormed(), '중간의 짝 잃은 반쪽도 정리');
});
