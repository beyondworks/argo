// '/' 커맨더 목록 미러(유건 지시 2026-09-14) — 회사 별칭·스킬을 크루 행(commands)에 올린다. 본문·키는 싣지 않고, 같은 내용이면 폴마다 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crewCommands, mirrorCommands, _resetCommandsForTest } from '../src/gateway/msgr.mjs';

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

test('mirrorCommands — update 실패는 캐시에 남지 않아 다음 폴에 다시 시도한다', async () => {
  _resetCommandsForTest();
  let fail = true;
  const db = { setCommands: async () => { if (fail) throw new Error('rls'); } };
  await assert.rejects(mirrorCommands('ws1', { db, uid: 'u', commands: [] }));
  fail = false;
  assert.equal(await mirrorCommands('ws1', { db, uid: 'u', commands: [] }), true);
});
